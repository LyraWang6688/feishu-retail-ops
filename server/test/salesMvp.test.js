const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { PaymentService } = require('../src/services/paymentService');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { SalesProgressService } = require('../src/services/salesProgressService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const fake = () => {
  const sizes = [38, 39, 40, 41, 42, 43, 44].map((size) => ({
    record_id: `size_${size}`, fields: { 尺码: size },
  }));
  const records = new Map([
    ['salesEntry', [{ record_id: 'order_1', fields: { 销售单号: 'XSD-001', '确认状态': '未确认' } }]],
    ['sizeManagement', sizes],
  ]);
  let seq = 0;
  const batches = [];
  const gateway = {
    records, batches, table: (key) => V1_BITABLE_SCHEMA.tables[key], validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
          const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
          if (!field) throw new Error(`${key}: unknown field ${name}`);
          return [field, value];
        }));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    // ⭐ 2026-10-18：生产网关有 batchCreate；这里按同序逐条落库并记下"用了批量"。
    createBatch: async (key, rows) => {
      batches.push([key, rows.length]);
      const created = [];
      for (const values of rows) created.push(await gateway.create(key, values));
      return created;
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      Object.assign(record.fields, Object.fromEntries(Object.entries(values)
        .map(([name, value]) => {
          const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
          if (!field) throw new Error(`${key}: unknown field ${name}`);
          return [field, value];
        })));
      return record;
    },
    delete: async (key, id) => records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id)),
  };
  return gateway;
};
const references = { resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
  resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }) };

test('first sale creates one master, multiple details and one receipt; retry creates nothing twice', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1', totalPaid: 230, paymentMethod: '微信',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }, { itemNo: 'B200', size: 39, quantity: 1, actualAmount: 130 }] };
  await service.confirm(input);
  await service.confirm(input);
  assert.equal(gateway.records.get('salesEntry').length, 1);
  assert.equal(gateway.records.get('salesDetail').length, 2);
  // 真实表里尺码是关联字段：写进去的必须是关联记录 ID，不是数字。
  // 假 Base 不校验字段类型，所以只有显式断言写入形态才测得出来。
  assert.deepEqual(gateway.records.get('salesDetail').map((row) => row.fields['尺码']),
    [['size_38'], ['size_39']]);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('明细批量写：一次 batchCreate 建完整单（不再逐行 4 秒）', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  await service.confirm({
    salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 },
      { itemNo: 'A100', size: 39, quantity: 1, actualAmount: 100 },
      { itemNo: 'B200', size: 40, quantity: 1, actualAmount: 100 },
    ],
    payments: [{ method: '微信', amount: 300 }],
  });
  assert.deepEqual(gateway.batches[0], ['salesDetail', 3], '三条明细必须一次 batch 写完');
  assert.ok(gateway.batches.some(([table]) => table === 'paymentRecord'), '收款明细也必须走批量（不逐条 4 秒）');
  assert.equal(gateway.records.get('salesDetail').length, 3);
});

test('mixed payment creates two receipts for the same order and retry is idempotent', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 250, gift: true, giftDescription: '鞋垫一双' }],
    payments: [{ method: '微信', amount: 150 }, { method: '现金', amount: 100 }] };
  await service.confirm(input);
  await service.confirm(input);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  // ⭐ 2026-10-08：赠品的落点搬到**销售主表**；明细那一列已被她整列删除。
  assert.equal(gateway.records.get('salesEntry')[0].fields['赠品'], '鞋垫一双');
  assert.equal(gateway.records.get('salesDetail')[0].fields['赠品'], undefined);
  assert.equal(gateway.records.get('paymentRecord').length, 2);
  assert.deepEqual(gateway.records.get('paymentRecord').map((record) => record.fields['交易金额']), [150, 100]);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
});

test('each pair has its own detail even when product and size are identical', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1', items: [
    { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 89 },
    { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 89 },
  ], payments: [{ method: '微信', amount: 178 }] };
  const first = await service.confirm(input);
  const retry = await service.confirm(input);
  assert.equal(new Set(first.detailRecordIds).size, 2);
  assert.deepEqual(retry.detailRecordIds, first.detailRecordIds);
  assert.equal(gateway.records.get('salesDetail').length, 2);
  assert.ok(gateway.records.get('salesDetail').every((row) => row.fields['数量'] === undefined &&
    row.fields['履约状态'] === '未交付'));
});

test('an unlisted sellable kind is refused instead of silently treated as a shoe', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  await assert.rejects(service.confirm({ salesEntryRecordId: 'order_1',
    items: [{ kind: 'gift_card', itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }],
    payments: [{ method: '微信', amount: 100 }] }), /未声明的可售品类型/);
});

test('a multi-pair line without individual prices stops before creating sale details', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  await assert.rejects(service.confirm({ salesEntryRecordId: 'order_1', items: [
    { itemNo: 'A100', size: 38, quantity: 2, actualAmount: 178 },
  ], payments: [{ method: '微信', amount: 178 }] }), /逐双说明实收金额/);
  assert.equal(gateway.records.get('salesDetail'), undefined);
});

test('deposit creates paid and unpaid receipts; follow-up 记一条新收款 + 把占位行清零（不动库存）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  // 「尾款以后付 140」＝她明说欠 140，所以 owed 由解析层给到入账层，后端才补那条未收款。
  const posted = await sales.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: '695887B-5', size: 43, quantity: 1, actualAmount: 240 }],
    payments: [{ method: '微信', amount: 100 }], owed: 140 });
  const detail = await gateway.get('salesDetail', posted.detailRecordIds[0]);
  assert.equal(detail.fields['履约状态'], '未交付');
  assert.equal(detail.fields['数量'], undefined);
  const receipts = gateway.records.get('paymentRecord');
  assert.deepEqual(receipts.map((row) => [row.fields['交易金额'], row.fields['钱款状态']]),
    [[100, '已收款'], [140, '未收款']]);
  assert.equal(receipts[1].fields['收付日'], undefined);
  assert.equal(receipts[1].fields['支付方式'], undefined);
  assert.equal((await gateway.get('salesEntry', 'order_1')).fields['履约状态'], undefined);
  assert.equal((await gateway.get('salesEntry', 'order_1')).fields['钱款状态'], undefined);
  const pendingId = receipts[1].record_id;
  const payments = new PaymentService({ gateway, references });
  const followup = new SalesFollowupService({ gateway, payments,
    store: new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-deposit-')),
      idField: 'task_id' }) });
  const result = await followup.addPayment({ salesEntryRecordId: 'order_1', method: '微信',
    amount: 140, operatorOpenId: 'ou_1', requestId: '00000000-0000-4000-8000-000000000001' });
  // ⚠️ 2026-10-12 **改写**（业务负责人：「1. 可以做」= 补收款支持分笔）：
  //    改前：补收款**复用**那条【未收款】——`result.recordId === pendingId`、
  //          状态被改成「已收款」、收款明细仍然是 2 条；
  //    改后：每次提交**各记一条**「已收款」行，那条【未收款】**不删、状态也不改**，
  //          只把金额**同步成当前剩余**（这里收满 ⇒ 0）——与「逐件补实收」同一条口径。
  assert.notEqual(result.recordId, pendingId, '新记了一条收款行（不再复用那条占位行）');
  assert.equal(result.pendingAmount, 0, '收满了 ⇒ 剩余 0');
  assert.equal(gateway.records.get('paymentRecord').length, 3,
    '已收 100 + 新记的 140 + 那条占位行（金额已同步为 0）');
  const settled = await gateway.get('paymentRecord', pendingId);
  assert.equal(settled.fields['钱款状态'], '未收款', '占位行的**状态一个字没动**（不删、也不改状态）');
  assert.equal(settled.fields['交易金额'], 0, '金额同步成 0（收满）');
  const fresh = await gateway.get('paymentRecord', result.recordId);
  assert.equal(fresh.fields['钱款状态'], '已收款');
  assert.equal(fresh.fields['交易金额'], 140);
  assert.equal(fresh.fields['支付方式'][0], 'method_微信', '方式照她说（`resolvePaymentMethod` 解析出来的记录）');
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  const inventoryCalls = [];
  const delivery = new SalesDeliveryService({ gateway, inventory: {
    applySale: async (input) => { inventoryCalls.push(input); return { sampleConsumedQuantity: 0 }; },
  } });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds });
  assert.equal(inventoryCalls.length, 1);
  assert.equal(inventoryCalls[0].quantity, 1);
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '已交付');
});

test('platform voucher has no receipt time until verified settlement', async () => {
  const gateway = fake();
  const payments = new PaymentService({ gateway, references });
  const cash = await payments.record({ salesEntryRecordId: 'order_1', method: '微信', amount: 169 });
  const voucher = await payments.record({ salesEntryRecordId: 'order_1', method: '抖音团购券',
    amount: 85.4, status: '待平台结算' });
  assert.equal((await gateway.get('paymentRecord', cash.recordId)).fields['钱款状态'], '已收款');
  assert.ok((await gateway.get('paymentRecord', cash.recordId)).fields['收付日'] > 0);
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['钱款状态'], '待平台结算');
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['收付日'], undefined);
  await payments.settlePlatformReceipt(voucher.recordId, 1234567890000);
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['钱款状态'], '已收款');
  assert.equal((await gateway.get('paymentRecord', voucher.recordId)).fields['收付日'], 1234567890000);
});

test('sale records cash and pending voucher on one order without treating voucher as received', async () => {
  const gateway = fake();
  const sale = new SalesOrderService({ gateway, references });
  await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: '2A831-18', size: 44, quantity: 1, actualAmount: 254.4 }],
    payments: [{ method: '微信', amount: 169 },
      { method: '抖音团购券', amount: 85.4, status: '待平台结算' }] });
  const receipts = gateway.records.get('paymentRecord');
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].fields['收付日'] > 0, true);
  assert.equal(receipts[1].fields['收付日'], undefined);
  assert.equal(gateway.records.get('salesEntry')[0].fields['钱款状态'], undefined);
  await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: '2A831-18', size: 44, quantity: 1, actualAmount: 254.4 }],
    payments: [{ method: '微信', amount: 169 },
      { method: '抖音团购券', amount: 85.4, status: '待平台结算' }] });
  assert.equal(gateway.records.get('paymentRecord').length, 2);
});

test('voucher-only sale creates one pending receipt and no zero-value cash receipt', async () => {
  const gateway = fake();
  const sale = new SalesOrderService({ gateway, references });
  const posted = await sale.confirm({ salesEntryRecordId: 'order_1', items: [
    { itemNo: 'XHB8095', size: 42, quantity: 1, actualAmount: 85.4, gift: true,
      giftDescription: '袜子两双' },
  ], payments: [{ method: '抖音团购券', amount: 85.4, status: '待平台结算' }] });
  const payments = gateway.records.get('paymentRecord');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].fields['钱款状态'], '待平台结算');
  assert.equal(payments[0].fields['收付日'], undefined);
  // ⭐ 2026-10-08：赠品在**销售主表**；明细行不带它（`posted.detailRecordIds[0]` 那一行）。
  assert.equal((await gateway.get('salesEntry', 'order_1')).fields['赠品'], '袜子两双');
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['赠品'], undefined);
  const progress = await new SalesProgressService({ gateway }).forOrder('order_1');
  assert.equal(progress.pendingAmount, 0);
  assert.equal(progress.platformPendingAmount, 85.4);
  assert.equal(progress.pendingDeliveryQuantity, 1);
});

test('invalid initial receipt cannot silently become unpaid', async () => {
  const gateway = fake();
  const service = new SalesOrderService({ gateway, references });
  await assert.rejects(service.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 100 }],
    payments: [{ method: '微信', amount: '' }] }), /收款金额/);
  assert.equal(gateway.records.get('paymentRecord'), undefined);
  // 「确认状态」（用户那一维）由 larkMvpService 在她点确认时写；这里直接调 SalesOrderService，
  // 所以它保持夹具里的「未确认」——入账失败**不该**去动她那一维。
  // ⭐ 2026-10-18：旧四列已删；半截失败（明细成了、收款没成）⇒ 写入状态=部分失败。
  assert.equal(gateway.records.get('salesEntry')[0].fields['写入状态'], '部分失败');
});

test('unpaid sale can be delivered once, then later payment does not touch inventory', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  // 「260 元未付」这一单：一分钱都没收到 ⇒ 差额 = 每件实收合计（100）⇒ **自动**补一条【未收款 100】。
  // ⚠️ 2026-10-16 晚更正（改前逐字：「owed=100 才补一条未收款（她没说欠就不补…）」—— 那是老口径）：
  //    新口径下**差额自己就会挂**；她明说的 `owed: 100` 现在只作**交叉校验**（说错要拦住，见下面那条）。
  const posted = await sales.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }], owed: 100 });
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  assert.equal(gateway.records.get('paymentRecord')[0].fields['钱款状态'], '未收款');
  const calls = [];
  const delivery = new SalesDeliveryService({ gateway, inventory: { applySale: async (input) => { calls.push(input); return { quantity: 0 }; } } });
  const request = { salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds };
  await delivery.deliver(request);
  await delivery.deliver(request);
  assert.equal(calls.length, 1);
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '已交付');
  const payment = new PaymentService({ gateway, references });
  await payment.collectPendingReceipt(gateway.records.get('paymentRecord')[0].record_id,
    { salesEntryRecordId: 'order_1', method: '微信', amount: 100 });
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  assert.equal(calls.length, 1);
});

// ─── ⭐ 2026-10-16 晚起：未收款 = **差额**（`每件实收合计 − 已收` > 0 就**自动**补一条）───
//   改前逐字（已作废 ✗）：「未收款只在「她明说欠」时才补，实收金额 = 她说的收款额（业务负责人口径）」
//   改后逐字：差额 = 0 ⇒ 一条不补；差额 > 0 ⇒ **自动**补（她有没有说"欠"都一样）✓
//   依据 = 她 2026-10-16 晚裁定「**客户少付 ⇒ 自动记一条【未收款】（差额）**」
//          ＋ 她 2026-10-14 逐字「只要本次付的金额小于累计的，那么差额都是未收款」
//   ⚠️ 下面这条用例**数据自洽**（成交 = 实收 = 100 ⇒ 差额 0）⇒ 断言**一个字不动**、仍然绿 ✓
//      （新口径下它不再靠"她没说欠"，而是靠"差额 0"—— 见用例内注释。）

test('她说了"收了 100"、没说欠：成交即实收（差额 0），不补未收款，订单直接到已完成', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  // 她的真实一单：119 的腰带，收到了 100 元微信。解析层已经定好成交=100、owed 为空
  // （119 只是用来对档位的价位，不落库）。
  // ⚠️ 2026-10-16 晚更正**理由**（改前逐字：「入账层就该一条未收款都不写」—— 那是"她说欠才算欠"）；
  //    改后逐字：这一单 `每件实收合计 (100) − 已收 (100) = 0` ⇒ **没有差额** ⇒ 一条未收款都不挂 ✓
  //    （差额 > 0 的单会**自动**挂 —— 见 `test/owedAutoOnShortfall.test.js` 的 AC-OWED-1。）
  const posted = await sales.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }],
    payments: [{ method: '微信', amount: 100 }] });

  const receipts = gateway.records.get('paymentRecord');
  assert.equal(receipts.length, 1, '差额 0（成交=实收=100）⇒ 绝不能挂未收款');
  assert.equal(receipts[0].fields['交易金额'], 100);
  assert.equal(receipts[0].fields['钱款状态'], '已收款');
  const progress = await new SalesProgressService({ gateway }).forOrder('order_1',
    { detailRecordIds: posted.detailRecordIds, paymentRecordIds: posted.paymentRecordIds });
  assert.equal(progress.paymentStatus, '已收款');
  assert.equal(progress.pendingAmount, 0);
  // 全付但这一双还没交付 ⇒ 订单停在「已确认」（配品链路已退场，改用鞋行验证收货语义）
  assert.equal(progress.orderStatus, '已确认');
  // ⚠️ 「订单状态」那一列已被业务负责人整列删除；salesProgressService 从 2026-10-06 起
  //    只算不写。所以这里断言的是**新维度写对了**（progress.orderStatus 只是算出来的 JS 字段）。
  const entry = await gateway.get('salesEntry', 'order_1');
  assert.equal(entry.fields['写入状态'], '成功');
});

test('她明说"还欠 19"：补一条未收款 19，订单停在已确认', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const posted = await sales.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 119 }],
    payments: [{ method: '微信', amount: 100 }], owed: 19 });

  const receipts = gateway.records.get('paymentRecord');
  assert.deepEqual(receipts.map((row) => [row.fields['交易金额'], row.fields['钱款状态']]),
    [[100, '已收款'], [19, '未收款']]);
  assert.equal(receipts[1].fields['收付日'], undefined);
  const progress = await new SalesProgressService({ gateway }).forOrder('order_1',
    { detailRecordIds: posted.detailRecordIds, paymentRecordIds: posted.paymentRecordIds });
  assert.equal(progress.pendingAmount, 19);
  assert.equal(progress.paymentStatus, '部分收款');
  assert.equal(progress.orderStatus, '已确认');
});

test('她说的欠款和「成交 − 已收」对不上时拦下来，不静默写一条错账', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await assert.rejects(sales.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }],
    payments: [{ method: '微信', amount: 100 }], owed: 19 }), /欠款与「实收金额−已收金额」不一致/);
  // 拦下来了就不该写任何收款记录
  assert.equal(gateway.records.get('paymentRecord'), undefined);
});

test('confirmed sale delivery writes positive stock movement and removes exactly one door-box unit', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  gateway.records.set('liveInventory', [
    { record_id: 'door_1', fields: { 编号: ['product_A100'], 尺码: ['size_38'], 所属状态: '门盒' } },
    { record_id: 'sample_1', fields: { 编号: ['product_A100'], 尺码: ['size_38'], 所属状态: '样品' } },
  ]);
  const sale = new SalesOrderService({ gateway, references });
  const posted = await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 220 }],
    payments: [{ method: '微信', amount: 220 }] });
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  const inventory = new InventoryService({ gateway, store: new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-delivery-')), idField: 'operation_id',
  }) });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds });
  assert.deepEqual(gateway.records.get('liveInventory').map((row) => row.record_id), ['sample_1']);
  assert.deepEqual(gateway.records.get('inventoryLedger')[0].fields, {
    编号: ['product_A100'], 尺码: ['size_38'], 变动数量: 1,
    库存行为: ['behavior_sale'], 关联销售: ['order_1'],
  });
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '已交付');
});

test('a failed fulfillment-state write retries without deducting the same pair twice', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  gateway.records.set('liveInventory', [
    { record_id: 'door_1', fields: { 编号: ['product_A100'], 尺码: ['size_38'], 所属状态: '门盒' } },
  ]);
  const sale = new SalesOrderService({ gateway, references });
  const posted = await sale.confirm({ salesEntryRecordId: 'order_1', items: [
    { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 89 },
  ], payments: [{ method: '微信', amount: 89 }] });
  const originalUpdate = gateway.update;
  let failOnce = true;
  gateway.update = async (key, id, fields) => {
    if (key === 'salesDetail' && fields.fulfillmentStatus === '已交付' && failOnce) {
      failOnce = false;
      throw new Error('temporary field write failure');
    }
    return originalUpdate(key, id, fields);
  };
  const inventory = new InventoryService({ gateway, store: new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-state-retry-')), idField: 'operation_id',
  }) });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  const request = { salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds };
  const first = await delivery.deliver(request);
  assert.equal(first.failures.length, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(gateway.records.get('liveInventory').length, 0);
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '未交付');
  const retried = await delivery.deliver(request);
  assert.equal(retried.failures.length, 0);
  assert.equal(retried.deliveredQuantity, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '已交付');
});

test('one out-of-stock shoe does not prevent later shoes from delivering, and retry deducts only the missing shoe', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  gateway.records.set('liveInventory', [
    { record_id: 'door_a', fields: { 编号: ['product_A100'], 尺码: ['size_39'], 所属状态: '门盒' } },
    { record_id: 'door_c', fields: { 编号: ['product_C300'], 尺码: ['size_43'], 所属状态: '门盒' } },
    { record_id: 'door_d', fields: { 编号: ['product_D400'], 尺码: ['size_44'], 所属状态: '门盒' } },
  ]);
  const sale = new SalesOrderService({ gateway, references });
  const posted = await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 39, quantity: 1, actualAmount: 186 },
      { itemNo: 'B200', size: 38, quantity: 1, actualAmount: 176 },
      { itemNo: 'C300', size: 43, quantity: 1, actualAmount: 99 },
      { itemNo: 'D400', size: 44, quantity: 1, actualAmount: 89 },
    ], payments: [{ method: '微信', amount: 550 }] });
  const inventory = new InventoryService({ gateway, store: new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-partial-delivery-')), idField: 'operation_id',
  }) });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  const request = { salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds };
  const first = await delivery.deliver(request);
  assert.equal(first.deliveredQuantity, 3);
  assert.equal(first.totalQuantity, 4);
  assert.equal(first.fulfillmentStatus, '部分交付');
  assert.deepEqual(first.failures.map((item) => item.lineNumber), [2]);
  assert.match(first.failures[0].error, /库存不足/);
  assert.deepEqual(await Promise.all(posted.detailRecordIds.map(async (id) =>
    (await gateway.get('salesDetail', id)).fields['履约状态'])), ['已交付', '未交付', '已交付', '已交付']);
  assert.equal(gateway.records.get('inventoryLedger').length, 3);

  gateway.records.get('liveInventory').push({ record_id: 'door_b', fields: {
    编号: ['product_B200'], 尺码: ['size_38'], 所属状态: '门盒',
  } });
  const retried = await delivery.deliver(request);
  assert.equal(retried.failures.length, 0);
  assert.equal(retried.deliveredQuantity, 4);
  assert.equal(retried.fulfillmentStatus, '已交付');
  assert.equal(gateway.records.get('inventoryLedger').length, 4);
  assert.ok((await Promise.all(posted.detailRecordIds.map((id) => gateway.get('salesDetail', id))))
    .every((detail) => detail.fields['履约状态'] === '已交付'));
});

test('newly created detail and receipt are resolved by record ID when list results lag', async () => {
  const gateway = fake();
  const listAll = gateway.listAll;
  gateway.listAll = async (key) => ['salesDetail', 'paymentRecord'].includes(key) ? [] : listAll(key);
  const sale = new SalesOrderService({ gateway, references });
  const posted = await sale.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 89 }],
    payments: [{ method: '微信', amount: 89 }] });
  const order = await gateway.get('salesEntry', 'order_1');
  assert.equal(order.fields['钱款状态'], undefined);
  const delivery = new SalesDeliveryService({ gateway, inventory: {
    applySale: async () => ({ sampleConsumedQuantity: 0 }),
  } });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds });
  assert.equal(order.fields['履约状态'], undefined);
  assert.equal(order.fields['钱款状态'], undefined);
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['交付数量'], undefined);
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '已交付');
});

test('Feishu record_ids link shape reuses an existing order, receipt, and detail before delivery', async () => {
  const gateway = fake();
  const sale = new SalesOrderService({ gateway, references });
  const input = { salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 42, quantity: 1, actualAmount: 89 },
      { itemNo: 'B200', size: 42, quantity: 1, actualAmount: 59 },
      { itemNo: 'C300', size: 40, quantity: 1, actualAmount: 39 },
    ], payments: [{ method: '微信', amount: 187 }] };
  const first = await sale.confirm(input);
  const receipt = await gateway.get('paymentRecord', first.paymentRecordIds[0]);
  const linked = (recordId) => [{ record_ids: [recordId], text: 'display', type: 'text' }];
  for (const [index, recordId] of first.detailRecordIds.entries()) {
    const detail = await gateway.get('salesDetail', recordId);
    detail.fields['销售单号'] = linked('order_1');
    detail.fields['编号'] = linked(`product_${input.items[index].itemNo}`);
  }
  receipt.fields['关联销售单'] = linked('order_1');
  receipt.fields['支付方式'] = linked('method_微信');
  // 上一次尝试在「资金状态」上留了失败标记（旧「确认状态（旧）」那一列已不存在）。
  (await gateway.get('salesEntry', 'order_1')).fields['资金状态'] = '写入失败';

  const retried = await sale.confirm(input);
  assert.deepEqual(retried.detailRecordIds, first.detailRecordIds);
  assert.deepEqual(retried.paymentRecordIds, first.paymentRecordIds);
  assert.equal(gateway.records.get('salesDetail').length, 3);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  const stockCalls = [];
  const delivery = new SalesDeliveryService({ gateway, inventory: {
    applySale: async (request) => { stockCalls.push(request); return { sampleConsumedQuantity: 0 }; },
  } });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: first.detailRecordIds,
    paymentRecordIds: first.paymentRecordIds });
  assert.equal(stockCalls.length, 3);
  assert.deepEqual(stockCalls.map((call) => call.productRecordId),
    ['product_A100', 'product_B200', 'product_C300']);
  assert.ok((await Promise.all(first.detailRecordIds.map((id) => gateway.get('salesDetail', id))))
    .every((detail) => detail.fields['履约状态'] === '已交付'));
});

test('temporary 1254607 after receipt creation retries reads and delivers once without duplicate records', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  gateway.records.set('liveInventory', [
    { record_id: 'door_1', fields: { 编号: ['product_A100'], 尺码: ['size_39'], 所属状态: '门盒' } },
    { record_id: 'sample_1', fields: { 编号: ['product_A100'], 尺码: ['size_39'], 所属状态: '样品' } },
  ]);
  const listAll = gateway.listAll;
  let pendingReads = 1;
  gateway.listAll = async (key) => {
    if (key === 'salesDetail' && pendingReads &&
      gateway.records.get('salesEntry')[0].fields['写入状态'] === '成功') {
      pendingReads -= 1;
      const error = new Error('Request failed with status code 400');
      error.response = { data: { code: 1254607, msg: 'Data not ready, please try again later' } };
      throw error;
    }
    return listAll(key);
  };
  const progress = new SalesProgressService({ gateway, retryDelays: [0, 0, 0] });
  const sales = new SalesOrderService({ gateway, references, progress });
  const posted = await sales.confirm({ salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 39, quantity: 1, actualAmount: 260 }],
    payments: [{ method: '微信', amount: 260 }] });
  const inventory = new InventoryService({ gateway, store: new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-read-retry-')), idField: 'operation_id',
  }) });
  const delivery = new SalesDeliveryService({ gateway, progress, inventory });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds });
  assert.equal(pendingReads, 0);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.deepEqual(gateway.records.get('liveInventory').map((row) => row.record_id), ['sample_1']);
  assert.equal(gateway.records.get('salesEntry')[0].fields['写入状态'], '成功');
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '已交付');
});

test('exhausted progress read preserves posted sale and known IDs recover when list results lag', async () => {
  const gateway = fake();
  const listAll = gateway.listAll;
  let pendingReads = 3;
  let retryReadFailures = 0;
  let laggedLists = false;
  gateway.listAll = async (key) => {
    if (key === 'salesDetail' && retryReadFailures) {
      retryReadFailures -= 1;
      const error = new Error('Request failed with status code 400');
      error.response = { data: { code: 1254607 } };
      throw error;
    }
    if (key === 'salesDetail' && pendingReads &&
      gateway.records.get('salesEntry')[0].fields['写入状态'] === '成功') {
      pendingReads -= 1;
      const error = new Error('Request failed with status code 400');
      error.response = { data: { code: 1254607 } };
      throw error;
    }
    if (laggedLists && ['salesDetail', 'paymentRecord'].includes(key)) return [];
    return listAll(key);
  };
  const progress = new SalesProgressService({ gateway, retryDelays: [0, 0, 0] });
  const sales = new SalesOrderService({ gateway, references, progress });
  const knownRecordIds = { details: [], payments: [] };
  const input = { salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 39, quantity: 1, actualAmount: 260 }],
    payments: [{ method: '微信', amount: 260 }], knownRecordIds,
    onRecordPersisted: async (kind, index, id) => { knownRecordIds[kind][index] = id; } };
  await assert.rejects(sales.confirm(input), (error) => error.saleRecordsWritten === true);
  // 复核失败会收口成「部分失败」；钱本身已写成功（这里只核状态不再撒谎为成功）。
  assert.equal(gateway.records.get('salesEntry')[0].fields['写入状态'], '部分失败');
  // 🔴 2026-10-09：业务负责人把「失败原因」那一列从生产「销售主表」删掉了 ⇒ 写入点随列一起删
  //（`salesOrderService` 原来在这里回填"后续同步待恢复：…"；见 `v1BitableSchema.salesEntry` 段）。
  // 失败的可见落点现在是**状态维度**（上面那行）+ `v1.sale.sync_pending` 日志。
  // ⚠️ 这里是**断定它没写**（而不是"值不对"）：这个假网关对未配置的语义键**当场抛**
  //    ⇒ 只要写入点回来，这条用例立刻红。
  assert.equal(gateway.records.get('salesEntry')[0].fields['失败原因'], undefined,
    '「失败原因」列已删 ⇒ 不许再写（失败只落状态维度 + 日志）');
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  assert.equal(knownRecordIds.details.length, 1);
  assert.equal(knownRecordIds.payments.length, 1);

  laggedLists = true;
  retryReadFailures = 3;
  await assert.rejects(sales.confirm({ ...input, knownFinancialComplete: true }),
    (error) => error.saleRecordsWritten === true);
  assert.equal(gateway.records.get('salesEntry')[0].fields['写入状态'], '部分失败');
  const posted = await sales.confirm({ ...input, knownFinancialComplete: true });
  assert.deepEqual(posted.detailRecordIds, knownRecordIds.details);
  assert.deepEqual(posted.paymentRecordIds, knownRecordIds.payments);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  const stockCalls = [];
  const delivery = new SalesDeliveryService({ gateway, progress, inventory: {
    applySale: async (request) => { stockCalls.push(request); return { sampleConsumedQuantity: 0 }; },
  } });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds });
  await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds });
  assert.equal(stockCalls.length, 1);
  assert.equal((await gateway.get('salesDetail', posted.detailRecordIds[0])).fields['履约状态'], '已交付');
});

// ─── 「这一单到底扣没扣库存」：三条日志的字段名、值与顺序（业务负责人 2026-10-07 拍板） ───
//
// 起因（真实误判）：`v1.sale.posted` 里的 `inventory_applied: false` 被读成了"整单没扣库存"，
// 但它只是说"**落表这一步**不动库存"（库存在交付那一步才扣，而且已经扣了）。
// 改法是她逐字批准的三条：a 字段名带范围 · b 库存真动完记一条**正向证据** · c 写明下一步。
// 下面四个用例把这三条钉住：**日志是排查判据，格式回退必须红**。
//
// 日志捕获（与 purchaseReturn.test.js / purchaseWebhookService.test.js 同款）：
// 结构化日志的出口就是 console.log/warn/error（src/utils/logger.js），抓它们即可断言。
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    // 只取某个事件的结构化日志对象（日志行就是 logger 打的一行 JSON）。
    logs: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)).map((line) => JSON.parse(line)),
    firstIndex: (event) => lines.findIndex((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

test('① 落表日志只说「这一步不动库存」：字段名带范围 ＋ 写明下一步，旧字段名整条消失', async () => {
  const gateway = fake();
  const logs = captureLogs();
  let posted;
  try {
    posted = await new SalesOrderService({ gateway, references }).confirm({
      salesEntryRecordId: 'order_1',
      items: [{ itemNo: 'A100', size: 40, quantity: 1, actualAmount: 220 }],
      payments: [{ method: '微信', amount: 220 }],
    });
  } finally {
    logs.restore();
  }

  const listed = logs.logs('v1.sale.posted');
  assert.equal(listed.length, 1, '入账这一步只该记一条 v1.sale.posted');
  const entry = listed[0];
  assert.equal(entry.sales_entry_record_id, 'order_1');
  assert.equal(entry.detail_count, 1);
  assert.equal(entry.payment_count, 1);
  // a. 字段名写清**范围**：这条日志只回答"落表这一步"。
  assert.equal(entry.step, 'posting');
  assert.equal(entry.inventory_applied_by_this_step, false);
  // c. 补一句"下一步会做什么"。
  assert.equal(entry.inventory_planned, true);
  assert.equal(entry.inventory_step, 'after_delivery');
  // 🔴 旧字段名不许留半句话：它正是被读成"整单没扣库存"的那个词。
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'inventory_applied'), false);
  assert.ok(!logs.lines.some((line) => line.includes('"inventory_applied":')),
    '日志原文里也不许再出现旧键名 inventory_applied');
  // 前提：落表这一步确实不碰库存（流水要等交付那一步）。
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  // 返回值语义不变（本次只改"日志怎么说"）：本步不动库存。
  assert.equal(posted.inventoryApplied, false);
});

test('② 库存真的扣完：sales.inventory.applied 带这次写入的流水 id 与行为编码，三条日志顺序可对', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  gateway.records.set('liveInventory', [
    { record_id: 'door_1', fields: { 编号: ['product_A100'], 尺码: ['size_40'], 所属状态: '门盒' } },
  ]);
  const logs = captureLogs();
  let ledgerId;
  try {
    const sale = new SalesOrderService({ gateway, references });
    const posted = await sale.confirm({ salesEntryRecordId: 'order_1',
      items: [{ itemNo: 'A100', size: 40, quantity: 1, actualAmount: 220 }],
      payments: [{ method: '微信', amount: 220 }] });
    const inventory = new InventoryService({ gateway, store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-stock-log-')), idField: 'operation_id',
    }) });
    const delivery = new SalesDeliveryService({ gateway, inventory });
    await delivery.deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds,
      paymentRecordIds: posted.paymentRecordIds });
    ledgerId = gateway.records.get('inventoryLedger')[0].record_id;
  } finally {
    logs.restore();
  }

  // a + c：落表那条（同 ①，这里再钉一次"它和库存证据不是同一条"）。
  const posted = logs.logs('v1.sale.posted');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].step, 'posting');
  assert.equal(posted[0].inventory_applied_by_this_step, false);
  assert.equal(posted[0].inventory_step, 'after_delivery');

  // 库存引擎逐条写流水的证据（既有日志，原样仍在）。
  const changes = logs.logs('inventory.change.applied');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'STOCK_SALE_DECREASE');
  assert.equal(changes[0].ledger_record_id, ledgerId);

  // 「库存状态」写下去的那条 —— 排查时对顺序用的锚点。
  // ⭐ 2026-10-18：旧「库存状态」维度已删除，收口写的是「写入状态」。
  const statusWriteIndex = logs.lines.findIndex((line) =>
    line.includes('"event":"sales.status.written"') && line.includes('"dimensions":["writeStatus"]'));
  assert.ok(statusWriteIndex >= 0, '「写入状态」必须写下去并记日志');

  // b. ⭐ 正向证据：**库存真的动完了**。
  const applied = logs.logs('sales.inventory.applied');
  assert.equal(applied.length, 1, '库存真动完时必须且只记一条 sales.inventory.applied');
  assert.equal(applied[0].sales_entry_record_id, 'order_1');
  assert.deepEqual(applied[0].ledger_ids, [ledgerId],
    'ledger_ids 必须是这次真的写下去的库存流水 record_id');
  assert.deepEqual(applied[0].behaviors, ['STOCK_SALE_DECREASE']);
  assert.equal(applied[0].applied_detail_count, 1);
  assert.equal(applied[0].already_delivered_detail_count, 0);
  assert.equal(applied[0].failed_detail_count, 0);
  assert.deepEqual(applied[0].live_record_ids, ['door_1']);
  assert.equal(applied[0].stock_status, '已写入');
  assert.deepEqual(applied[0].sample_consumed_detail_ids, [], '这一单没卖样品，没有要补的');

  // 证据：库存流水 + 正向证据仍在；「写入状态」日志也仍在（旧四维已删）。
  assert.ok(logs.firstIndex('inventory.change.applied') >= 0, '库存流水证据仍在');
  assert.ok(logs.lines.some((line) => line.includes('"event":"sales.status.written"')),
    '「写入状态」日志仍在');
  assert.ok(logs.firstIndex('sales.inventory.applied') >= 0, '正向证据仍在');
});

test('③ 部分扣：正向证据只列真的扣成的流水，并把失败条数一并说清（不假装全扣了）', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  // A100/39 有货；B200/38 一双都没有 → 那一条交付必然失败。
  gateway.records.set('liveInventory', [
    { record_id: 'door_a', fields: { 编号: ['product_A100'], 尺码: ['size_39'], 所属状态: '门盒' } },
  ]);
  const logs = captureLogs();
  try {
    const sale = new SalesOrderService({ gateway, references });
    const posted = await sale.confirm({ salesEntryRecordId: 'order_1', items: [
      { itemNo: 'A100', size: 39, quantity: 1, actualAmount: 186 },
      { itemNo: 'B200', size: 38, quantity: 1, actualAmount: 176 },
    ], payments: [{ method: '微信', amount: 362 }] });
    const inventory = new InventoryService({ gateway, store: new JsonTaskStore({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-stock-log-partial-')), idField: 'operation_id',
    }) });
    const result = await new SalesDeliveryService({ gateway, inventory })
      .deliver({ salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds });
    assert.equal(result.failures.length, 1, '前提：这是一次真失败（否则这条用例测不到"部分扣"）');
    assert.match(result.failures[0].error, /库存不足/);
  } finally {
    logs.restore();
  }

  const applied = logs.logs('sales.inventory.applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].applied_detail_count, 1, '只有 1 条真的扣成了');
  assert.equal(applied[0].already_delivered_detail_count, 0);
  assert.equal(applied[0].failed_detail_count, 1, '失败那条要如实说出来，不能假装全扣了');
  assert.equal(applied[0].stock_status, '部分写入');
  assert.deepEqual(applied[0].ledger_ids, [gateway.records.get('inventoryLedger')[0].record_id]);
  assert.deepEqual(applied[0].live_record_ids, ['door_a']);
});

test('④ ledger_ids 为空 ≠ 没扣库存：重复交付已交付的明细时，用 already_delivered 说清', async () => {
  const gateway = fake();
  gateway.records.set('behavior', [{ record_id: 'behavior_sale', fields: {
    行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
  } }]);
  gateway.records.set('liveInventory', [
    { record_id: 'door_1', fields: { 编号: ['product_A100'], 尺码: ['size_40'], 所属状态: '门盒' } },
  ]);
  const logs = captureLogs();
  try {
    const sale = new SalesOrderService({ gateway, references });
    const posted = await sale.confirm({ salesEntryRecordId: 'order_1',
      items: [{ itemNo: 'A100', size: 40, quantity: 1, actualAmount: 220 }],
      payments: [{ method: '微信', amount: 220 }] });
    const request = { salesEntryRecordId: 'order_1', detailRecordIds: posted.detailRecordIds };
    const firstStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-stock-log-redeliver-')),
      idField: 'operation_id' });
    await new SalesDeliveryService({ gateway, inventory: new InventoryService({ gateway, store: firstStore }) })
      .deliver(request);
    // 第二次换一个**空**的本地任务日志目录：模拟"这条明细确实已交付，但本地那份任务日志不在"
    //（换了机器 / 目录被清）—— 正是「拿不到 ledger_id」的那种真实情形。
    const secondStore = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-stock-log-empty-')),
      idField: 'operation_id' });
    const retried = await new SalesDeliveryService({ gateway,
      inventory: new InventoryService({ gateway, store: secondStore }) }).deliver(request);
    assert.equal(retried.failures.length, 0, '前提：重试不该失败（否则测的是别的路径）');
  } finally {
    logs.restore();
  }

  const applied = logs.logs('sales.inventory.applied');
  assert.equal(applied.length, 2, '两次交付各记一条正向证据');
  assert.equal(applied[0].applied_detail_count, 1, '第一次真的扣了并拿得到流水 id');
  assert.equal(applied[0].already_delivered_detail_count, 0);
  // ⭐ 第二次：拿不到流水 id（本地任务日志不在），但**绝不能被读成"没扣库存"**。
  assert.deepEqual(applied[1].ledger_ids, []);
  assert.equal(applied[1].already_delivered_detail_count, 1,
    '这一条本来就已交付 —— 库存早扣过了，必须由这个字段说清');
  assert.equal(applied[1].failed_detail_count, 0);
  assert.equal(applied[1].stock_status, '已写入');
  // 事实表侧：库存流水只有一条，第二次没有重复扣。
  assert.equal(gateway.records.get('inventoryLedger').length, 1);
  assert.equal(logs.logs('inventory.change.applied').length, 1);
});
