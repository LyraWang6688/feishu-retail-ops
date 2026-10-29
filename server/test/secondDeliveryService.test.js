// 「第二次交付」：已入账之后把预定 / 现货待收单收尾（补收款 + 交付），以及每天 9 点的群提醒。
//
// 这个文件盯的是**业务规则本身**，不是实现细节：
//   · 现货待收单点「成交」只补收款，**一丁点库存都不许碰**（第一次交付时已经扣过了）；
//   · 预定单点「成交」要补收款 + 明细转已交付 + 扣库存（复用 deliver，不自己写库存）；
//   · 没到账的那条收款「收支方向」留空，变成已收款的那一刻才写「收入」；
//   · 销售明细的「交易类型」和销售主表写同一条行为关联；
//   · 同一笔不重复推的是「同一天」：跨天照发（业务负责人否掉了"按单只推一次"）；
//   · 点完「成交」之后那张卡的这一单要变灰（按钮换成一行说明），失败/只成一半时不能灰。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { PaymentService } = require('../src/services/paymentService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
// 群聊相关配置在服务构造时会被读一次；给测试值，免得用例里刷出一条"没配"的警告
// 把真正的失败淹掉。
process.env.LARK_BOT_OPEN_ID = process.env.LARK_BOT_OPEN_ID || 'ou_test_bot_open_id';
const CHAT_ID = 'oc_test_second_delivery_chat';

// 内存假 Base：语义字段名 → 真实字段名的映射与线上 schema 完全一致，所以
// "到底写进哪一列"是被真正验证的（写错字段名会在这里直接抛错，而不是被糊过去）。
const fakeGateway = (seed = {}) => {
  let seq = 0;
  const records = new Map(Object.entries(seed).map(([key, rows]) =>
    [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  const writes = [];
  const apply = (key, values) => {
    const fields = {};
    for (const [name, value] of Object.entries(values || {})) {
      if (value === undefined) continue;
      const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
      if (!field) throw new Error(`${key}: unknown field ${name}`);
      fields[field] = value;
    }
    return fields;
  };
  const gateway = {
    records, writes,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${key}_${++seq}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: apply(key, values) });
      writes.push({ table: key, op: 'create', recordId, semantic: values, fields: apply(key, values) });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      if (!record) throw new Error(`${key} ${id} 不存在`);
      Object.assign(record.fields, apply(key, values));
      writes.push({ table: key, op: 'update', recordId: id, semantic: values, fields: apply(key, values) });
      return record;
    },
  };
  return gateway;
};

const fakeInventory = () => {
  const applySaleCalls = [];
  return {
    applySaleCalls,
    applySale: async (input) => {
      applySaleCalls.push(input);
      return { productRecordId: input.productRecordId, sampleConsumedQuantity: 0, consumedLiveRecordIds: [] };
    },
    getSaleResult: async () => null,
  };
};

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const BEHAVIOR_ROWS = [
  // ⚠️ 2026-10-07：行为管理表里**只剩两条**（现货 / 预定）；「现货待收」那条记录已被业务负责人删除。
  { record_id: 'behavior_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货' } },
  { record_id: 'behavior_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预定' } },
];
const METHOD_ROWS = [
  { record_id: 'method_1', fields: { 收款方式: '微信' } },
  { record_id: 'method_2', fields: { 收款方式: '现金' } },
];

// ─────────────────────────────────────────────────────────────────────────────
// 一、点「成交」：**现货待收**（货已交付、钱没结清）只补收款，一点都不碰库存
// ─────────────────────────────────────────────────────────────────────────────

test('现货待收单点「成交」：只补收款，库存与明细履约状态一个字都不动', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS,
    paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
    // 现货：第一次录单时明细就已经是「已交付」（库存那时候扣过了），收款是一条全额未收款。
    salesEntry: [{ record_id: 'order_unpaid', fields: {
      '写入状态': '成功', 销售单号: 'XSD-U-1', 交易类型: ['behavior_cash'],
    } }],
    salesDetail: [{ record_id: 'detail_u1', fields: {
      销售单号: ['order_unpaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260,
    } }],
    paymentRecord: [{ record_id: 'receipt_u1', fields: {
      关联销售单: ['order_unpaid'], 交易金额: 260, 钱款状态: '未收款',
    } }],
  });
  const inventory = fakeInventory();
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-'),
    delivery: new SalesDeliveryService({ gateway, inventory }),
  });

  const before = Date.now();
  const result = await service.confirm({ salesEntryRecordId: 'order_unpaid', method: '微信', operatorOpenId: 'ou_1' });

  // ① 那条「未收款」→「已收款」：收款时间 = 点击时间，方向补「收入」。
  const receipt = gateway.records.get('paymentRecord')[0];
  assert.equal(receipt.fields['钱款状态'], '已收款');
  assert.deepEqual(receipt.fields['支付方式'], ['method_1']);
  assert.equal(receipt.fields['收支方向'], '收入');
  assert.ok(Number(receipt.fields['收付日']) >= before, '收款时间必须是点击那一刻');
  assert.equal(result.collectedAmount, 260);
  assert.deepEqual(result.collectedPaymentIds, ['receipt_u1']);

  // ② 库存：一次都没扣（applySale 没被调用，库存两张表也没有任何写入）。
  assert.equal(inventory.applySaleCalls.length, 0, '现货单再次交付就是扣两次库存');
  assert.equal(gateway.writes.filter((write) =>
    write.table === 'inventoryLedger' || write.table === 'liveInventory').length, 0);
  // ③ 明细履约状态没被重写（本来就是已交付，不重复交付）。
  assert.equal(gateway.writes.filter((write) => write.table === 'salesDetail').length, 0);
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  // ④ 钱货都齐了 —— 但**主表这一列什么都不写**（2026-10-06 起 salesProgressService 只算不写；
  //    「订单状态」那一列也已被业务负责人整列删除）。这一步只补收款，所以主表零写入。
  assert.equal(gateway.writes.filter((write) => write.table === 'salesEntry').length, 0);
  // 进度写在新的状态维度上（这一步只补收款，没有交付 → 库存状态不该被写）。
  assert.equal(gateway.records.get('salesEntry')[0].fields['库存状态'], undefined);
  assert.equal(result.delivery, null, '现货单不该走交付（货已经交过了）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、点「成交」：预定单补收款 + 明细转已交付 + 扣库存（走 deliver）
// ─────────────────────────────────────────────────────────────────────────────

test('预定单点「成交」：补收款 + 明细未交付转已交付 + 扣库存（复用 deliver）', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS,
    paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
    salesEntry: [{ record_id: 'order_prepaid', fields: {
      '写入状态': '成功', 销售单号: 'XSD-P-1', 交易类型: ['behavior_prepaid'],
    } }],
    // 预定：货还没到 / 没拿走（未交付），钱是定金 + 余款两条，余款那条是未收款。
    salesDetail: [{ record_id: 'detail_p1', fields: {
      销售单号: ['order_prepaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '未交付', 实收金额: 400,
    } }],
    paymentRecord: [
      { record_id: 'receipt_p1', fields: {
        关联销售单: ['order_prepaid'], 交易金额: 200, 钱款状态: '已收款', 支付方式: ['method_1'],
      } },
      { record_id: 'receipt_p2', fields: {
        关联销售单: ['order_prepaid'], 交易金额: 200, 钱款状态: '未收款',
      } },
    ],
  });
  const inventory = fakeInventory();
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-'),
    delivery: new SalesDeliveryService({ gateway, inventory }),
  });

  const result = await service.confirm({ salesEntryRecordId: 'order_prepaid', method: '现金', operatorOpenId: 'ou_1' });

  // ① 补收款：那条「未收款」→「已收款」+ 收支方向「收入」+ 收款时间。
  const pending = gateway.records.get('paymentRecord').find((row) => row.record_id === 'receipt_p2');
  assert.equal(pending.fields['钱款状态'], '已收款');
  assert.equal(pending.fields['收支方向'], '收入');
  assert.deepEqual(pending.fields['支付方式'], ['method_2']);
  assert.ok(Number(pending.fields['收付日']) > 0);
  assert.equal(result.collectedAmount, 200);
  // 原来那条已收款（定金）不动，也不重复写方向。
  const deposit = gateway.records.get('paymentRecord').find((row) => row.record_id === 'receipt_p1');
  assert.equal(deposit.fields['钱款状态'], '已收款');
  assert.equal(deposit.fields['收支方向'], undefined);

  // ② 明细：未交付 → 已交付。
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  // ③ 库存：正好扣一次（就是 deliver 里那一次 applySale），并带走这次补收的收款记录。
  assert.equal(inventory.applySaleCalls.length, 1);
  assert.deepEqual(inventory.applySaleCalls[0], {
    salesDetailRecordId: 'detail_p1', salesEntryRecordId: 'order_prepaid',
    productRecordId: 'product_1', size: 38, quantity: 1,
    occurredAt: inventory.applySaleCalls[0].occurredAt,
  });
  assert.equal(result.delivery.deliveredQuantity, 1);
  assert.equal(result.delivery.failures.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、连点两次：第二次不重复写
// ─────────────────────────────────────────────────────────────────────────────

test('同一张单连点两次「成交」：第二次只回"已成交"，不再写任何东西', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS, paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
    salesEntry: [{ record_id: 'order_unpaid', fields: {
      '写入状态': '成功', 销售单号: 'XSD-U-1', 交易类型: ['behavior_cash'],
    } }],
    salesDetail: [{ record_id: 'detail_u1', fields: {
      销售单号: ['order_unpaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260,
    } }],
    paymentRecord: [{ record_id: 'receipt_u1', fields: {
      关联销售单: ['order_unpaid'], 交易金额: 260, 钱款状态: '未收款',
    } }],
  });
  const inventory = fakeInventory();
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-'),
    delivery: new SalesDeliveryService({ gateway, inventory }),
  });

  await service.confirm({ salesEntryRecordId: 'order_unpaid', method: '微信' });
  const writesAfterFirst = gateway.writes.length;
  const second = await service.confirm({ salesEntryRecordId: 'order_unpaid', method: '微信' });

  assert.equal(second.alreadyCompleted, true);
  assert.equal(gateway.writes.length, writesAfterFirst, '第二次点击不该再写任何表');
  assert.equal(inventory.applySaleCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、收款明细「收支方向」：没到账留空，到账那一刻写「收入」
// ─────────────────────────────────────────────────────────────────────────────

test('未收款那条不写收支方向；变成已收款的那一刻才写「收入」', async () => {
  const gateway = fakeGateway({
    paymentMethod: METHOD_ROWS,
    salesEntry: [{ record_id: 'order_1', fields: { '写入状态': '成功' } }],
  });
  const payments = new PaymentService({ gateway });

  const pending = await payments.record({ salesEntryRecordId: 'order_1', amount: 100, status: '未收款' });
  const pendingFields = gateway.records.get('paymentRecord').find((row) => row.record_id === pending.recordId).fields;
  assert.equal(pendingFields['钱款状态'], '未收款');
  assert.equal(pendingFields['收支方向'], undefined, '钱还没到账，方向必须留空');

  await payments.collectPendingReceipt(pending.recordId, {
    salesEntryRecordId: 'order_1', amount: 100, method: '微信', receivedAt: Date.now(),
  });
  assert.equal(pendingFields['收支方向'], '收入');
  assert.equal(pendingFields['钱款状态'], '已收款');

  // 正常收款（一次写成的已收款）同样直接带方向。
  const paid = await payments.record({ salesEntryRecordId: 'order_1', amount: 50, method: '现金' });
  const paidFields = gateway.records.get('paymentRecord').find((row) => row.record_id === paid.recordId).fields;
  assert.equal(paidFields['收支方向'], '收入');
});

test('待平台结算结清时补写「收入」（到账那一刻才算收款事实）', async () => {
  const gateway = fakeGateway({
    salesEntry: [{ record_id: 'order_1', fields: { '写入状态': '成功' } }],
    paymentRecord: [{ record_id: 'receipt_1', fields: {
      关联销售单: ['order_1'], 交易金额: 100, 钱款状态: '待平台结算',
    } }],
  });
  const payments = new PaymentService({ gateway });
  await payments.settlePlatformReceipt('receipt_1', Date.now());
  const fields = gateway.records.get('paymentRecord')[0].fields;
  assert.equal(fields['钱款状态'], '已收款');
  assert.equal(fields['收支方向'], '收入');
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、销售明细「交易类型」：和销售主表写同一条行为关联
// ─────────────────────────────────────────────────────────────────────────────

test('入账时销售明细的「交易类型」来自明细自己的那一行（主表已无该列）', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS,
    paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    salesEntry: [{ record_id: 'order_1', fields: {
      销售单号: 'XSD-1', 写入状态: '未完成',
    } }],
  });
  const service = new SalesOrderService({
    gateway,
    references: {
      resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
      resolvePaymentMethod: async () => ({ recordId: 'method_1' }),
      resolveSalesTradeType: async () => ({ recordId: 'behavior_cash' }),
    },
  });

  const result = await service.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: '8088-26', size: 38, quantity: 1, actualAmount: 230, tradeTypeCode: 'SALE_CASH' }],
    payments: [{ amount: 230, method: '微信' }],
  });

  const detail = gateway.records.get('salesDetail').find((row) => row.record_id === result.detailRecordIds[0]);
  assert.deepEqual(detail.fields['交易类型'], ['behavior_cash'], '明细的交易类型来自明细自己那一行');
  assert.equal(gateway.records.get('salesEntry')[0].fields['交易类型'], undefined, '主表已删该列 ⇒ 不再写');
  // 顺带确认正常收款也带上了方向（同一次入账里的两件事）。
  assert.equal(gateway.records.get('paymentRecord')[0].fields['收支方向'], '收入');
});

test('主表没有交易类型时明细也不写这一列（不猜一个方向）', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS,
    paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    salesEntry: [{ record_id: 'order_1', fields: { '确认状态': '未确认', 销售单号: 'XSD-1' } }],
  });
  const service = new SalesOrderService({
    gateway,
    references: {
      resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
      resolvePaymentMethod: async () => ({ recordId: 'method_1' }),
    },
  });
  const result = await service.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: '8088-26', size: 38, quantity: 1, actualAmount: 230 }],
    payments: [{ amount: 230, method: '微信' }],
  });
  const detail = gateway.records.get('salesDetail').find((row) => row.record_id === result.detailRecordIds[0]);
  assert.equal(detail.fields['交易类型'], undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 六、候选口径（`listPendingDeliveries`）——
//     ⭐ 2026-10-28：原来这一节是「每日提醒」的用例（卡片发群 / 按天只推一次 / 没配群不发…）。
//     业务负责人确认「**9 点群推送不再需要**」「现在没有群聊入口，也没有旧卡片」⇒
//     那条推送（含它的卡片与按天认领）**整体删除**。
//     ⚠️ **候选口径本身一个字都没改**，它是保留下来的 `listPendingDeliveries` 的行为 ——
//     下面这些断言就是从那批用例**原样搬过来**的（不是放宽、不是 skip）。
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ 2026-10-14 夹具整体**后移 17 天**（相对关系不变）——
//   依据：她 2026-10-14 逐字「**数据从 20261015 开始**」＋「**存量行不用管，就看增量**」
//     ⇒ 判据 = 「最近 7 天」**且**「数据起点之后」（见 `isWithinLookupWindow` / `isOnOrAfterSince`）。
//   ⭐ `OUT_OF_WINDOW` 特意落在 **2026-10-15（数据起点当天）**：它 ≥ 起点 ⇒
//     被排除的**唯一**理由仍是我们本来就要钉的"7 天窗口" ✓（新窗口起点 = 10-16）。
const NOW = new Date('2026-10-22T02:00:00Z');
const inWindow = (iso) => Date.parse(iso);
const OUT_OF_WINDOW = Date.parse('2026-10-15T10:00:00+08:00');

const reminderSeed = () => ({
  behavior: BEHAVIOR_ROWS,
  paymentMethod: METHOD_ROWS,
  // 预定那一单点「成交」要真的走交付（否则交付失败、卡片按规则本来就不该变灰），
  // 所以货品与尺码这两张参照表也得在。
  sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
  product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
  salesEntry: [
    // 要推的：**现货待收**（货已交付、钱没收清）—— 新口径下这类单必须进候选。
    { record_id: 'order_cash_pending', fields: {
      '写入状态': '成功', 销售单号: 'XSD-U-2', 交易类型: ['behavior_cash'],
      录单日: inWindow('2026-10-19T10:00:00+08:00'),
    } },
    // 要推的：预定、已入账、7 天内、货没交 + 钱没收清（录单更早，应排在前面）。
    { record_id: 'order_prepaid_pending', fields: {
      '写入状态': '成功', 销售单号: 'XSD-P-2', 交易类型: ['behavior_prepaid'],
      录单日: inWindow('2026-10-18T10:00:00+08:00'),
    } },
    // 不推：现货、钱货两清（已完成履约）。
    { record_id: 'order_cash', fields: {
      '写入状态': '成功', 销售单号: 'XSD-C-2', 交易类型: ['behavior_cash'],
      录单日: inWindow('2026-10-20T10:00:00+08:00'),
    } },
    // 不推：钱货都齐了（已完成履约）。
    { record_id: 'order_cash_done', fields: {
      '写入状态': '成功', 销售单号: 'XSD-U-3', 交易类型: ['behavior_cash'],
      录单日: inWindow('2026-10-20T10:00:00+08:00'),
    } },
    // 不推：7 天以外的单。
    { record_id: 'order_cash_old', fields: {
      '写入状态': '成功', 销售单号: 'XSD-U-9', 交易类型: ['behavior_cash'], 录单日: OUT_OF_WINDOW,
    } },
  ],
  salesDetail: [
    { record_id: 'd_c1', fields: { 交易类型: ['behavior_cash'], 销售单号: ['order_cash_pending'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260 } },
    { record_id: 'd_p2', fields: { 销售单号: ['order_prepaid_pending'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '未交付', 实收金额: 400, 交易类型: ['behavior_prepaid'] } },
    { record_id: 'd_c2', fields: { 交易类型: ['behavior_cash'], 销售单号: ['order_cash'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 100 } },
    { record_id: 'd_c3', fields: { 交易类型: ['behavior_cash'], 销售单号: ['order_cash_done'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 100 } },
    { record_id: 'd_c9', fields: { 交易类型: ['behavior_cash'], 销售单号: ['order_cash_old'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 100 } },
  ],
  paymentRecord: [
    { record_id: 'r_c1', fields: { 关联销售单: ['order_cash_pending'], 交易金额: 260, 钱款状态: '未收款' } },
    { record_id: 'r_p2a', fields: { 关联销售单: ['order_prepaid_pending'], 交易金额: 200, 钱款状态: '已收款' } },
    { record_id: 'r_p2b', fields: { 关联销售单: ['order_prepaid_pending'], 交易金额: 200, 钱款状态: '未收款' } },
    { record_id: 'r_c2', fields: { 关联销售单: ['order_cash'], 交易金额: 100, 钱款状态: '已收款' } },
    { record_id: 'r_c3', fields: { 关联销售单: ['order_cash_done'], 交易金额: 100, 钱款状态: '已收款' } },
    { record_id: 'r_c9', fields: { 关联销售单: ['order_cash_old'], 交易金额: 100, 钱款状态: '未收款' } },
  ],
});

test('候选 = 尚未完成履约（预定 / 现货待收）+ 7 天内；已完成 / 窗口外的不进', async () => {
  const service = new SecondDeliveryService({ gateway: fakeGateway(reminderSeed()) });
  const orders = await service.listPendingDeliveries({ now: NOW });

  assert.deepEqual(orders.map((order) => order.salesEntryRecordId),
    ['order_prepaid_pending', 'order_cash_pending'], '最早的单排最前；其余三类都不进候选');
  const cash = orders.find((order) => order.salesEntryRecordId === 'order_cash_pending');
  assert.equal(cash.pendingAmount, 260, '现货待收：未收款合计');
  assert.equal(cash.fulfillmentStatus, '已交付');
  const prepaid = orders.find((order) => order.salesEntryRecordId === 'order_prepaid_pending');
  assert.equal(prepaid.pendingDeliveryQuantity, 1, '预定：还有 1 双没交');
  assert.equal(prepaid.pendingAmount, 200);
  // 已两清 / 未入账 / 窗口外的都不在
  const ids = orders.map((order) => order.salesEntryRecordId);
  for (const excluded of ['order_cash', 'order_cash_done', 'order_cash_old']) {
    assert.equal(ids.includes(excluded), false, `${excluded} 不该进候选`);
  }
});

// ⭐⭐ 2026-10-14 她的数据口径：「**数据从 20261015 开始**」＋「**存量行不用管，就看增量**」
//   判据 = 既有的 7 天窗口 **且** `config/dataSince` 的 `isOnOrAfterSince`（同一行判断）。
test('⭐⭐ 数据起点：注入 10-14 与 10-15 两单 ⇒ **只有 10-15 被挑出来**', async () => {
  const DAY = new Date('2026-10-20T02:00:00Z'); // 起点之后；10-15 仍落在 7 天窗口内
  const seed = { ...reminderSeed() };
  seed.salesEntry = [
    { record_id: 'order_before', fields: {
      '写入状态': '成功', 销售单号: 'XSD-B4', 交易类型: ['behavior_cash'],
      录单日: Date.parse('2026-10-14T10:00:00+08:00'),
    } },
    { record_id: 'order_since', fields: {
      '写入状态': '成功', 销售单号: 'XSD-SINCE', 交易类型: ['behavior_cash'],
      录单日: Date.parse('2026-10-15T10:00:00+08:00'),
    } },
  ];
  seed.salesDetail = [
    { record_id: 'd_before', fields: { 销售单号: ['order_before'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260 } },
    { record_id: 'd_since', fields: { 销售单号: ['order_since'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260 } },
  ];
  seed.paymentRecord = [
    { record_id: 'r_before', fields: { 关联销售单: ['order_before'], 交易金额: 260, 钱款状态: '未收款' } },
    { record_id: 'r_since', fields: { 关联销售单: ['order_since'], 交易金额: 260, 钱款状态: '未收款' } },
  ];
  const service = new SecondDeliveryService({ gateway: fakeGateway(seed) });
  const orders = await service.listPendingDeliveries({ now: DAY });
  assert.deepEqual(orders.map((order) => order.salesEntryRecordId), ['order_since'],
    '10-14（起点之前）= 存量 ⇒ 不推；10-15（起点当天，含）⇒ 推');
});

test('这一单是哪天的：明细「销售日」优先、主表「录单日」兜底，两个都读不到就跳过这单', async () => {
  const seed = reminderSeed();
  // 现货待收那单：主表日期清掉，靠明细的「销售日」判在窗口内。
  delete seed.salesEntry.find((row) => row.record_id === 'order_cash_pending').fields['录单日'];
  seed.salesDetail.find((row) => row.record_id === 'd_c1').fields['销售日'] =
    Date.parse('2026-10-19T10:00:00+08:00');
  // 预定那单：主表和明细都没有日期 —— 不能当成"太老了"悄悄丢掉，要跳过并记警告。
  delete seed.salesEntry.find((row) => row.record_id === 'order_prepaid_pending').fields['录单日'];

  const service = new SecondDeliveryService({ gateway: fakeGateway(seed) });
  const orders = await service.listPendingDeliveries({ now: NOW });
  assert.deepEqual(orders.map((order) => order.salesEntryRecordId), ['order_cash_pending'],
    '明细有销售日的照进候选；两处日期都读不到的跳过这单（不猜）');
});

test('单条数据不自洽（收款超过成交额）时跳过它，其余单照旧进候选', async () => {
  const seed = reminderSeed();
  seed.paymentRecord.push({ record_id: 'r_bad', fields: {
    关联销售单: ['order_cash_pending'], 交易金额: 9999, 钱款状态: '已收款',
  } });
  const service = new SecondDeliveryService({ gateway: fakeGateway(seed) });
  const orders = await service.listPendingDeliveries({ now: NOW });
  assert.deepEqual(orders.map((order) => order.salesEntryRecordId), ['order_prepaid_pending']);
});
