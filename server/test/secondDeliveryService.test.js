// 「第二次交付」：已入账之后把预定 / 现货待收单收尾（补收款 + 交付），以及每天 9 点的群提醒。
//
// 这个文件盯的是**业务规则本身**，不是实现细节：
//   · 现货待收单点「成交」只补收款，**一丁点库存都不许碰**（第一次交付时已经扣过了）；
//   · 预定单点「成交」要补收款 + 明细转已交付 + 扣库存（复用 deliver，不自己写库存）；
//   · 没到账的那条收款「交易方向」留空，变成已收款的那一刻才写「收入」；
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
const { LarkMvpService } = require('../src/services/larkMvpService');
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
      '资金状态': '已写入', 销售单号: 'XSD-U-1', 交易类型: ['behavior_cash'],
    } }],
    salesDetail: [{ record_id: 'detail_u1', fields: {
      销售单号: ['order_unpaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260,
    } }],
    paymentRecord: [{ record_id: 'receipt_u1', fields: {
      关联销售单: ['order_unpaid'], 收款金额: 260, 收款状态: '未收款',
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
  assert.equal(receipt.fields['收款状态'], '已收款');
  assert.deepEqual(receipt.fields['收款方式'], ['method_1']);
  assert.equal(receipt.fields['交易方向'], '收入');
  assert.ok(Number(receipt.fields['收款日']) >= before, '收款时间必须是点击那一刻');
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
      '资金状态': '已写入', 销售单号: 'XSD-P-1', 交易类型: ['behavior_prepaid'],
    } }],
    // 预定：货还没到 / 没拿走（未交付），钱是定金 + 余款两条，余款那条是未收款。
    salesDetail: [{ record_id: 'detail_p1', fields: {
      销售单号: ['order_prepaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '未交付', 实收金额: 400,
    } }],
    paymentRecord: [
      { record_id: 'receipt_p1', fields: {
        关联销售单: ['order_prepaid'], 收款金额: 200, 收款状态: '已收款', 收款方式: ['method_1'],
      } },
      { record_id: 'receipt_p2', fields: {
        关联销售单: ['order_prepaid'], 收款金额: 200, 收款状态: '未收款',
      } },
    ],
  });
  const inventory = fakeInventory();
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-'),
    delivery: new SalesDeliveryService({ gateway, inventory }),
  });

  const result = await service.confirm({ salesEntryRecordId: 'order_prepaid', method: '现金', operatorOpenId: 'ou_1' });

  // ① 补收款：那条「未收款」→「已收款」+ 交易方向「收入」+ 收款时间。
  const pending = gateway.records.get('paymentRecord').find((row) => row.record_id === 'receipt_p2');
  assert.equal(pending.fields['收款状态'], '已收款');
  assert.equal(pending.fields['交易方向'], '收入');
  assert.deepEqual(pending.fields['收款方式'], ['method_2']);
  assert.ok(Number(pending.fields['收款日']) > 0);
  assert.equal(result.collectedAmount, 200);
  // 原来那条已收款（定金）不动，也不重复写方向。
  const deposit = gateway.records.get('paymentRecord').find((row) => row.record_id === 'receipt_p1');
  assert.equal(deposit.fields['收款状态'], '已收款');
  assert.equal(deposit.fields['交易方向'], undefined);

  // ② 明细：未交付 → 已交付。
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  // ③ 库存：正好扣一次（就是 deliver 里那一次 applySale），并带走这次补收的收款记录。
  assert.equal(inventory.applySaleCalls.length, 1);
  assert.deepEqual(inventory.applySaleCalls[0], {
    salesDetailRecordId: 'detail_p1', productRecordId: 'product_1', size: 38, quantity: 1,
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
      '资金状态': '已写入', 销售单号: 'XSD-U-1', 交易类型: ['behavior_cash'],
    } }],
    salesDetail: [{ record_id: 'detail_u1', fields: {
      销售单号: ['order_unpaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260,
    } }],
    paymentRecord: [{ record_id: 'receipt_u1', fields: {
      关联销售单: ['order_unpaid'], 收款金额: 260, 收款状态: '未收款',
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
// 四、收款明细「交易方向」：没到账留空，到账那一刻写「收入」
// ─────────────────────────────────────────────────────────────────────────────

test('未收款那条不写交易方向；变成已收款的那一刻才写「收入」', async () => {
  const gateway = fakeGateway({
    paymentMethod: METHOD_ROWS,
    salesEntry: [{ record_id: 'order_1', fields: { '资金状态': '已写入' } }],
  });
  const payments = new PaymentService({ gateway });

  const pending = await payments.record({ salesEntryRecordId: 'order_1', amount: 100, status: '未收款' });
  const pendingFields = gateway.records.get('paymentRecord').find((row) => row.record_id === pending.recordId).fields;
  assert.equal(pendingFields['收款状态'], '未收款');
  assert.equal(pendingFields['交易方向'], undefined, '钱还没到账，方向必须留空');

  await payments.collectPendingReceipt(pending.recordId, {
    salesEntryRecordId: 'order_1', amount: 100, method: '微信', receivedAt: Date.now(),
  });
  assert.equal(pendingFields['交易方向'], '收入');
  assert.equal(pendingFields['收款状态'], '已收款');

  // 正常收款（一次写成的已收款）同样直接带方向。
  const paid = await payments.record({ salesEntryRecordId: 'order_1', amount: 50, method: '现金' });
  const paidFields = gateway.records.get('paymentRecord').find((row) => row.record_id === paid.recordId).fields;
  assert.equal(paidFields['交易方向'], '收入');
});

test('待平台结算结清时补写「收入」（到账那一刻才算收款事实）', async () => {
  const gateway = fakeGateway({
    salesEntry: [{ record_id: 'order_1', fields: { '资金状态': '已写入' } }],
    paymentRecord: [{ record_id: 'receipt_1', fields: {
      关联销售单: ['order_1'], 收款金额: 100, 收款状态: '待平台结算',
    } }],
  });
  const payments = new PaymentService({ gateway });
  await payments.settlePlatformReceipt('receipt_1', Date.now());
  const fields = gateway.records.get('paymentRecord')[0].fields;
  assert.equal(fields['收款状态'], '已收款');
  assert.equal(fields['交易方向'], '收入');
});

// ─────────────────────────────────────────────────────────────────────────────
// 五、销售明细「交易类型」：和销售主表写同一条行为关联
// ─────────────────────────────────────────────────────────────────────────────

test('入账时销售明细的「交易类型」抄的是销售主表同一条行为关联', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS,
    paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    salesEntry: [{ record_id: 'order_1', fields: {
      '确认状态': '未确认', 销售单号: 'XSD-1', 交易类型: ['behavior_cash'],
    } }],
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
  assert.deepEqual(detail.fields['交易类型'], ['behavior_cash'], '明细和主表必须是同一条行为记录');
  assert.equal(detail.fields['交易类型'][0], gateway.records.get('salesEntry')[0].fields['交易类型'][0]);
  // 顺带确认正常收款也带上了方向（同一次入账里的两件事）。
  assert.equal(gateway.records.get('paymentRecord')[0].fields['交易方向'], '收入');
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
// 六、每日提醒：选单范围、群卡片、两层防重复
// ─────────────────────────────────────────────────────────────────────────────

// 上海 2026-10-05 10:00（UTC 02:00），"最近 7 天" = 09-29 起。
const NOW = new Date('2026-10-05T02:00:00Z');
const TOMORROW = new Date('2026-10-06T02:00:00Z');
const inWindow = (iso) => Date.parse(iso);
const OUT_OF_WINDOW = Date.parse('2026-09-20T10:00:00+08:00');

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
      '资金状态': '已写入', 销售单号: 'XSD-U-2', 交易类型: ['behavior_cash'],
      录单日: inWindow('2026-10-02T10:00:00+08:00'),
    } },
    // 要推的：预定、已入账、7 天内、货没交 + 钱没收清（录单更早，应排在前面）。
    { record_id: 'order_prepaid_pending', fields: {
      '资金状态': '已写入', 销售单号: 'XSD-P-2', 交易类型: ['behavior_prepaid'],
      录单日: inWindow('2026-10-01T10:00:00+08:00'),
    } },
    // 不推：现货、钱货两清（已完成履约）。
    { record_id: 'order_cash', fields: {
      '资金状态': '已写入', 销售单号: 'XSD-C-2', 交易类型: ['behavior_cash'],
      录单日: inWindow('2026-10-03T10:00:00+08:00'),
    } },
    // 不推：钱货都齐了（已完成履约）。
    { record_id: 'order_cash_done', fields: {
      '资金状态': '已写入', 销售单号: 'XSD-U-3', 交易类型: ['behavior_cash'],
      录单日: inWindow('2026-10-03T10:00:00+08:00'),
    } },
    // 不推：7 天以外的单。
    { record_id: 'order_cash_old', fields: {
      '资金状态': '已写入', 销售单号: 'XSD-U-9', 交易类型: ['behavior_cash'], 录单日: OUT_OF_WINDOW,
    } },
  ],
  salesDetail: [
    { record_id: 'd_c1', fields: { 销售单号: ['order_cash_pending'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 260 } },
    { record_id: 'd_p2', fields: { 销售单号: ['order_prepaid_pending'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '未交付', 实收金额: 400 } },
    { record_id: 'd_c2', fields: { 销售单号: ['order_cash'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 100 } },
    { record_id: 'd_c3', fields: { 销售单号: ['order_cash_done'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 100 } },
    { record_id: 'd_c9', fields: { 销售单号: ['order_cash_old'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 实收金额: 100 } },
  ],
  paymentRecord: [
    { record_id: 'r_c1', fields: { 关联销售单: ['order_cash_pending'], 收款金额: 260, 收款状态: '未收款' } },
    { record_id: 'r_p2a', fields: { 关联销售单: ['order_prepaid_pending'], 收款金额: 200, 收款状态: '已收款' } },
    { record_id: 'r_p2b', fields: { 关联销售单: ['order_prepaid_pending'], 收款金额: 200, 收款状态: '未收款' } },
    { record_id: 'r_c2', fields: { 关联销售单: ['order_cash'], 收款金额: 100, 收款状态: '已收款' } },
    { record_id: 'r_c3', fields: { 关联销售单: ['order_cash_done'], 收款金额: 100, 收款状态: '已收款' } },
    { record_id: 'r_c9', fields: { 关联销售单: ['order_cash_old'], 收款金额: 100, 收款状态: '未收款' } },
  ],
});

// patch 走 SDK 的 `client.im.v1.message.patch`（updateInteractiveCard 优先取这一支），
// 所以假 client 也照这个形状给，才能在测试里看到"卡片被改成了什么"。
const fakeClient = (sent, patched = []) => ({
  im: {
    message: {
      create: async ({ params, data }) => {
        sent.push({ params, data });
        return { code: 0, data: { message_id: `om_${sent.length}` } };
      },
    },
    v1: { message: { patch: async ({ path, data }) => {
      patched.push({ message_id: path.message_id, content: data.content });
      return { code: 0 };
    } } },
  },
});

const cardOf = (message) => JSON.parse(message.data.content);
const cardButtons = (card) => card.elements
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => element.columns.flatMap((column) => column.elements));








// ─────────────────────────────────────────────────────────────────────────────
// 六之二、点完「成交」：那张卡的这一单变灰（按钮换成一行说明）
// ─────────────────────────────────────────────────────────────────────────────

// 发一张当天的卡，返回 service / gateway / sent（发出去的卡）/ patched（patch 过的卡）。
// 卡片消息 id 是 om_1。
const reminderHarness = (options = {}) => {
  const sent = [];
  const patched = [];
  const gateway = fakeGateway(reminderSeed());
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-settle-'),
    client: fakeClient(sent, patched), chatId: CHAT_ID,
    delivery: new SalesDeliveryService({ gateway, inventory: fakeInventory() }),
    ...options,
  });
  return { service, gateway, sent, patched };
};

// 点的是卡里的哪一单（按钮取值就带这个），外加回调带上来的消息 id 和日期键。
const clickFirstCard = (service, salesEntryRecordId, extra = {}) => service.confirm({
  salesEntryRecordId, method: '微信', operatorOpenId: 'ou_wangying',
  cardMessageId: 'om_1', reminderDay: '2026-10-05', settledAt: NOW, ...extra,
});

// 手搓"某一单有 N 种收款方式"的按钮行：结构与 larkCards.buttonRows 一致
// （每行最多 3 个按钮的 column_set），用来验证多行按钮会被收成一行灰字。
const buttonRowsForTest = (salesEntryRecordId, count) => {
  const rows = [];
  for (let index = 0; index < count; index += 3) {
    const perRow = Math.min(3, count - index);
    rows.push({
      tag: 'column_set', flex_mode: 'none',
      columns: Array.from({ length: perRow }, (_, offset) => ({
        tag: 'column', width: 'weighted', weight: 1,
        elements: [{
          tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '成交' },
          value: { action: 'confirm_second_delivery', draft_id: '',
            sales_entry_record_id: salesEntryRecordId, method: `m${index + offset}` },
        }],
      })),
    });
  }
  return rows;
};











// ─────────────────────────────────────────────────────────────────────────────
// 七、定时器：北京时间 9 点之前不跑
// ─────────────────────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────────────────────
// 八、机器人分派：没有草稿 id 也要能走这条链路
// ─────────────────────────────────────────────────────────────────────────────



