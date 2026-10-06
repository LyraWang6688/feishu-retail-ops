// 「第二次交付」：已入账之后把未付 / 预付单收尾（补收款 + 交付），以及每天 9 点的群提醒。
//
// 这个文件盯的是**业务规则本身**，不是实现细节：
//   · 未付单点「成交」只补收款，**一丁点库存都不许碰**（第一次交付时已经扣过了）；
//   · 预付单点「成交」要补收款 + 明细转已交付 + 扣库存（复用 deliver，不自己写库存）；
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
const { startSecondDeliveryReminder, shanghaiHour } = require('../src/utils/secondDeliveryReminder');
const { settleSecondDeliveryOrder } = require('../src/utils/larkCards');

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
  { record_id: 'behavior_unpaid', fields: { 行为编码: 'SALE_UNPAID', 行为名称: '未付' } },
  { record_id: 'behavior_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预付' } },
  { record_id: 'behavior_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货' } },
];
const METHOD_ROWS = [
  { record_id: 'method_1', fields: { 收款方式: '微信' } },
  { record_id: 'method_2', fields: { 收款方式: '现金' } },
];

// ─────────────────────────────────────────────────────────────────────────────
// 一、点「成交」：未付单只补收款，一点都不碰库存
// ─────────────────────────────────────────────────────────────────────────────

test('未付单点「成交」：只补收款，库存与明细履约状态一个字都不动', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS,
    paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
    // 未付：第一次录单时明细就已经是「已交付」（库存那时候扣过了），收款是一条全额未收款。
    salesEntry: [{ record_id: 'order_unpaid', fields: {
      资金状态: '已写入', 销售单号: 'XSD-U-1', 交易类型: ['behavior_unpaid'], 订单状态: '已确认',
    } }],
    salesDetail: [{ record_id: 'detail_u1', fields: {
      销售单号: ['order_unpaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 260,
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
  assert.deepEqual(receipt.fields['交易方式'], ['method_1']);
  assert.equal(receipt.fields['交易方向'], '收入');
  assert.ok(Number(receipt.fields['收款时间']) >= before, '收款时间必须是点击那一刻');
  assert.equal(result.collectedAmount, 260);
  assert.deepEqual(result.collectedPaymentIds, ['receipt_u1']);

  // ② 库存：一次都没扣（applySale 没被调用，库存两张表也没有任何写入）。
  assert.equal(inventory.applySaleCalls.length, 0, '未付单再次交付就是扣两次库存');
  assert.equal(gateway.writes.filter((write) =>
    write.table === 'inventoryLedger' || write.table === 'liveInventory').length, 0);
  // ③ 明细履约状态没被重写（本来就是已交付，不重复交付）。
  assert.equal(gateway.writes.filter((write) => write.table === 'salesDetail').length, 0);
  assert.equal(gateway.records.get('salesDetail')[0].fields['履约状态'], '已交付');
  // ④ 钱货都齐了，主表订单状态同步成已完成。
  assert.equal(gateway.records.get('salesEntry')[0].fields['订单状态'], '已完成');
  assert.equal(result.delivery, null, '未付单不该走交付');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、点「成交」：预付单补收款 + 明细转已交付 + 扣库存（走 deliver）
// ─────────────────────────────────────────────────────────────────────────────

test('预付单点「成交」：补收款 + 明细未交付转已交付 + 扣库存（复用 deliver）', async () => {
  const gateway = fakeGateway({
    behavior: BEHAVIOR_ROWS,
    paymentMethod: METHOD_ROWS,
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
    salesEntry: [{ record_id: 'order_prepaid', fields: {
      资金状态: '已写入', 销售单号: 'XSD-P-1', 交易类型: ['behavior_prepaid'], 订单状态: '已确认',
    } }],
    // 预付：货还没拿走（未交付），钱是定金 + 余款两条，余款那条是未收款。
    salesDetail: [{ record_id: 'detail_p1', fields: {
      销售单号: ['order_prepaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '未交付', 成交金额: 400,
    } }],
    paymentRecord: [
      { record_id: 'receipt_p1', fields: {
        关联销售单: ['order_prepaid'], 收款金额: 200, 收款状态: '已收款', 交易方式: ['method_1'],
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
  assert.deepEqual(pending.fields['交易方式'], ['method_2']);
  assert.ok(Number(pending.fields['收款时间']) > 0);
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
      资金状态: '已写入', 销售单号: 'XSD-U-1', 交易类型: ['behavior_unpaid'],
    } }],
    salesDetail: [{ record_id: 'detail_u1', fields: {
      销售单号: ['order_unpaid'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 260,
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
    salesEntry: [{ record_id: 'order_1', fields: { 资金状态: '已写入' } }],
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
    salesEntry: [{ record_id: 'order_1', fields: { 资金状态: '已写入' } }],
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
      确认状态: '未确认', 销售单号: 'XSD-1', 交易类型: ['behavior_cash'],
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
    salesEntry: [{ record_id: 'order_1', fields: { 确认状态: '未确认', 销售单号: 'XSD-1' } }],
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
  // 预付那一单点「成交」要真的走交付（否则交付失败、卡片按规则本来就不该变灰），
  // 所以货品与尺码这两张参照表也得在。
  sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
  product: [{ record_id: 'product_1', fields: { 编号: 'P1' } }],
  salesEntry: [
    // 要推的：未付、已入账、7 天内、钱没收清。
    { record_id: 'order_unpaid_pending', fields: {
      资金状态: '已写入', 销售单号: 'XSD-U-2', 交易类型: ['behavior_unpaid'],
      录单日: inWindow('2026-10-02T10:00:00+08:00'),
    } },
    // 要推的：预付、已入账、7 天内、货没交 + 钱没收清（录单更早，应排在前面）。
    { record_id: 'order_prepaid_pending', fields: {
      资金状态: '已写入', 销售单号: 'XSD-P-2', 交易类型: ['behavior_prepaid'],
      录单日: inWindow('2026-10-01T10:00:00+08:00'),
    } },
    // 不推：现货（交易类型就不在范围内）。
    { record_id: 'order_cash', fields: {
      资金状态: '已写入', 销售单号: 'XSD-C-2', 交易类型: ['behavior_cash'],
      录单日: inWindow('2026-10-03T10:00:00+08:00'),
    } },
    // 不推：未付但钱货都齐了（已完成履约）。
    { record_id: 'order_unpaid_done', fields: {
      资金状态: '已写入', 销售单号: 'XSD-U-3', 交易类型: ['behavior_unpaid'],
      录单日: inWindow('2026-10-03T10:00:00+08:00'),
    } },
    // 不推：7 天以外的未付单。
    { record_id: 'order_unpaid_old', fields: {
      资金状态: '已写入', 销售单号: 'XSD-U-9', 交易类型: ['behavior_unpaid'], 录单日: OUT_OF_WINDOW,
    } },
  ],
  salesDetail: [
    { record_id: 'd_u2', fields: { 销售单号: ['order_unpaid_pending'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 260 } },
    { record_id: 'd_p2', fields: { 销售单号: ['order_prepaid_pending'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '未交付', 成交金额: 400 } },
    { record_id: 'd_c2', fields: { 销售单号: ['order_cash'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 100 } },
    { record_id: 'd_u3', fields: { 销售单号: ['order_unpaid_done'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 100 } },
    { record_id: 'd_u9', fields: { 销售单号: ['order_unpaid_old'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 100 } },
  ],
  paymentRecord: [
    { record_id: 'r_u2', fields: { 关联销售单: ['order_unpaid_pending'], 收款金额: 260, 收款状态: '未收款' } },
    { record_id: 'r_p2a', fields: { 关联销售单: ['order_prepaid_pending'], 收款金额: 200, 收款状态: '已收款' } },
    { record_id: 'r_p2b', fields: { 关联销售单: ['order_prepaid_pending'], 收款金额: 200, 收款状态: '未收款' } },
    { record_id: 'r_c2', fields: { 关联销售单: ['order_cash'], 收款金额: 100, 收款状态: '已收款' } },
    { record_id: 'r_u3', fields: { 关联销售单: ['order_unpaid_done'], 收款金额: 100, 收款状态: '已收款' } },
    { record_id: 'r_u9', fields: { 关联销售单: ['order_unpaid_old'], 收款金额: 100, 收款状态: '未收款' } },
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

test('每日提醒：只推「未付 / 预付 + 7 天内 + 尚未完成履约」，卡片发到采购群', async () => {
  const sent = [];
  const service = new SecondDeliveryService({
    gateway: fakeGateway(reminderSeed()), store: tmpStore('second-delivery-reminder-'),
    client: fakeClient(sent), chatId: CHAT_ID,
  });

  const result = await service.sendDailyReminder({ now: NOW });

  assert.equal(result.day, '2026-10-05');
  assert.equal(result.pushedOrderCount, 2);
  assert.equal(sent.length, 1, '一天只发一张卡');
  assert.equal(sent[0].params.receive_id_type, 'chat_id');
  assert.equal(sent[0].data.receive_id, CHAT_ID);
  assert.equal(sent[0].data.msg_type, 'interactive');

  const card = cardOf(sent[0]);
  const content = JSON.stringify(card);
  assert.match(content, /XSD-P-2/);
  assert.match(content, /XSD-U-2/);
  assert.doesNotMatch(content, /XSD-C-2/, '现货不进提醒');
  assert.doesNotMatch(content, /XSD-U-3/, '已完成履约的不进提醒');
  assert.doesNotMatch(content, /XSD-U-9/, '7 天以外的不进提醒');
  assert.match(content, /未收 ￥260/);
  assert.match(content, /未交付 1\/1 双/);

  // 按钮：每单每种收款方式一个「成交」，取值带销售单号 + 收款方式。
  const buttons = cardButtons(card);
  assert.deepEqual(buttons.map((button) => button.value.sales_entry_record_id), [
    'order_prepaid_pending', 'order_prepaid_pending', 'order_unpaid_pending', 'order_unpaid_pending',
  ]);
  assert.deepEqual(buttons.map((button) => button.value.method), ['微信', '现金', '微信', '现金']);
  assert.ok(buttons.every((button) => button.value.action === 'confirm_second_delivery'));
  // 按钮取值里还要带「这张卡是哪天的」：点完之后要靠它把这张卡取回来改成已成交。
  assert.deepEqual([...new Set(buttons.map((button) => button.value.reminder_day))], ['2026-10-05']);
  assert.deepEqual(buttons.map((button) => button.text.content),
    ['成交·微信', '成交·现金', '成交·微信', '成交·现金']);
});

test('只配了一种收款方式时按钮直接叫「成交」', async () => {
  const sent = [];
  const service = new SecondDeliveryService({
    gateway: fakeGateway(reminderSeed()), store: tmpStore('second-delivery-reminder-'),
    client: fakeClient(sent), chatId: CHAT_ID,
  });
  service.paymentMethodNames = async () => ['微信'];
  await service.sendDailyReminder({ now: NOW });
  const buttons = cardButtons(cardOf(sent[0]));
  assert.deepEqual([...new Set(buttons.map((button) => button.text.content))], ['成交']);
});

test('每日只推一次：同一天第二次 tick 不再推；同一笔单第二天照常再推一次', async () => {
  const sent = [];
  const service = new SecondDeliveryService({
    gateway: fakeGateway(reminderSeed()), store: tmpStore('second-delivery-reminder-'),
    client: fakeClient(sent), chatId: CHAT_ID,
  });

  await service.sendDailyReminder({ now: NOW });
  assert.equal(sent.length, 1);

  // 同一天再 tick（进程重启后 interval 立刻再跑就是这种情况）：一次都不该再发。
  const sameDay = await service.sendDailyReminder({ now: NOW });
  assert.equal(sameDay.skipped, true);
  assert.equal(sameDay.reason, 'already_ran_today');
  assert.equal(sent.length, 1, '同一天只发一次');

  // 第二天：那两笔**还在 7 天内、还没成交**，所以照样全发一遍。
  // 业务负责人明确说了「不用防重复推送……只要他还在 7 天的时间范围内，你就继续发」，
  // 所以这里断言的恰恰是"跨天会推"，不是空跑。
  const nextDay = await service.sendDailyReminder({ now: TOMORROW });
  assert.equal(nextDay.pushedOrderCount, 2, '同一笔在 7 天内要跨天照发');
  assert.equal(sent.length, 2, '第二天再发一张卡');
  const firstCard = JSON.stringify(cardOf(sent[0]));
  const secondCard = JSON.stringify(cardOf(sent[1]));
  for (const orderNo of ['XSD-P-2', 'XSD-U-2']) {
    assert.match(firstCard, new RegExp(orderNo));
    assert.match(secondCard, new RegExp(orderNo), `${orderNo} 第二天还要在卡里（跨天照发）`);
  }
});

test('没配收款方式就不推，也不猜一个方式写账（第二天配置好了照常推）', async () => {
  const sent = [];
  const gateway = fakeGateway(reminderSeed());
  gateway.records.set('paymentMethod', []);
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-reminder-'), client: fakeClient(sent), chatId: CHAT_ID,
  });

  const blocked = await service.sendDailyReminder({ now: NOW });
  assert.equal(blocked.reason, 'no_payment_method');
  assert.equal(sent.length, 0);

  // 这一天没推成（按天认领已落盘），但这不等于单被标记过：配置补上之后第二天照常推。
  gateway.records.set('paymentMethod', METHOD_ROWS);
  const nextDay = await service.sendDailyReminder({ now: TOMORROW });
  assert.equal(nextDay.pushedOrderCount, 2);
  assert.equal(sent.length, 1);
});

test('没配群 id 时不发、也不抛异常（第二天配置好之后还能推）', async () => {
  const sent = [];
  const gateway = fakeGateway(reminderSeed());
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-reminder-'), client: fakeClient(sent), chatId: '',
  });
  const result = await service.sendDailyReminder({ now: NOW });
  assert.equal(result.reason, 'no_chat');
  assert.equal(sent.length, 0);
  // 群 id 配好之后，第二天照样能推（按天认领只挡同一天）。
  service.chatId = CHAT_ID;
  assert.equal((await service.sendDailyReminder({ now: TOMORROW })).pushedOrderCount, 2);
});

test('这一单是哪天的：明细「销售日」优先、主表「录单日」兜底，两个都读不到就跳过这单', async () => {
  const seed = reminderSeed();
  // 未付那单：主表日期清掉，靠明细的「销售日」判在窗口内。
  delete seed.salesEntry.find((row) => row.record_id === 'order_unpaid_pending').fields['录单日'];
  seed.salesDetail.find((row) => row.record_id === 'd_u2').fields['销售日'] =
    Date.parse('2026-10-02T10:00:00+08:00');
  // 预付那单：主表和明细都没有日期 —— 不能当成"太老了"悄悄丢掉，要跳过并记警告。
  delete seed.salesEntry.find((row) => row.record_id === 'order_prepaid_pending').fields['录单日'];

  const sent = [];
  const service = new SecondDeliveryService({
    gateway: fakeGateway(seed), store: tmpStore('second-delivery-reminder-'),
    client: fakeClient(sent), chatId: CHAT_ID,
  });
  const result = await service.sendDailyReminder({ now: NOW });

  assert.equal(result.pushedOrderCount, 1);
  assert.match(JSON.stringify(cardOf(sent[0])), /XSD-U-2/);
  assert.doesNotMatch(JSON.stringify(cardOf(sent[0])), /XSD-P-2/);
});

test('单条数据不自洽（收款超过成交额）时跳过它，其余单照推', async () => {
  const seed = reminderSeed();
  seed.paymentRecord.push({ record_id: 'r_bad', fields: {
    关联销售单: ['order_unpaid_pending'], 收款金额: 9999, 收款状态: '已收款',
  } });
  const sent = [];
  const service = new SecondDeliveryService({
    gateway: fakeGateway(seed), store: tmpStore('second-delivery-reminder-'),
    client: fakeClient(sent), chatId: CHAT_ID,
  });
  const result = await service.sendDailyReminder({ now: NOW });
  assert.equal(result.pushedOrderCount, 1);
  assert.match(JSON.stringify(cardOf(sent[0])), /XSD-P-2/);
  assert.doesNotMatch(JSON.stringify(cardOf(sent[0])), /XSD-U-2/);
});

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

test('点完「成交」：被点那一单的按钮换成一行灰字，卡片里别的单一个字都不动', async () => {
  const { service, gateway, sent, patched } = reminderHarness();
  await service.sendDailyReminder({ now: NOW });
  const original = cardOf(sent[0]);
  // 卡里两单：预付（10-01）在前，未付（10-02）在后 —— 点后面那一单。
  assert.deepEqual(original.elements.map((element) => element.tag),
    ['div', 'column_set', 'div', 'column_set']);

  await clickFirstCard(service, 'order_unpaid_pending');

  // ① 钱真的收了（变灰是成交的结果，不是替代）。
  assert.equal(gateway.records.get('paymentRecord').find((row) => row.record_id === 'r_u2').fields['收款状态'], '已收款');
  // ② patch 打在**被点的那张卡**上，且只有一次。
  assert.equal(patched.length, 1, '成交成功后更新那张卡');
  assert.equal(patched[0].message_id, 'om_1');

  const next = JSON.parse(patched[0].content);
  // ③ 卡片头与前半段（预付那一单的明细行 + 按钮行）原样保留。
  assert.deepEqual(next.header, original.header);
  assert.deepEqual(next.config, original.config);
  assert.deepEqual(next.elements.slice(0, 3), original.elements.slice(0, 3), '别的单一个字都不动');
  // ④ 被点那一单的位置：按钮没了，换成一行 note 灰字。
  const note = next.elements[3];
  assert.equal(note.tag, 'div');
  assert.deepEqual(note.text, { tag: 'lark_md', content: '✅ 已成交（10:00 点击）', text_size: 'note' });
  assert.equal(next.elements.length, 4);
  // ⑤ 未付那一单的按钮一行都不剩；预付那一单的按钮还在（不能把整张卡灰掉）。
  const buttons = cardButtons(next);
  assert.deepEqual([...new Set(buttons.map((button) => button.value.sales_entry_record_id))],
    ['order_prepaid_pending']);
  assert.match(JSON.stringify(next), /XSD-P-2/);
});

test('同一张卡再点一次（这一单已成交）：不再写账，也不再重复改那张卡', async () => {
  const { service, gateway, patched } = reminderHarness();
  await service.sendDailyReminder({ now: NOW });
  await clickFirstCard(service, 'order_unpaid_pending');
  const writesAfterFirstClick = gateway.writes.length;

  const again = await clickFirstCard(service, 'order_unpaid_pending');

  assert.equal(again.alreadyCompleted, true);
  assert.equal(gateway.writes.length, writesAfterFirstClick, '第二次点击一个字都不写');
  assert.equal(patched.length, 1, '那一单在卡上已经灰了，没有第二遍可改');
});

test('第一次 patch 失败时卡片没灰：再点一次补上变灰（补的是"已成交"，不是又写一遍账）', async () => {
  const sent = [];
  const patched = [];
  const gateway = fakeGateway(reminderSeed());
  let failFirstPatch = true;
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-settle-'), chatId: CHAT_ID,
    client: {
      im: {
        message: { create: async ({ params, data }) => {
          sent.push({ params, data });
          return { code: 0, data: { message_id: `om_${sent.length}` } };
        } },
        // patch 挂在 im.v1.message 上，和真实 SDK 一致（updateInteractiveCard 先找这一支）。
        v1: { message: { patch: async ({ path, data }) => {
          if (failFirstPatch) {
            failFirstPatch = false;
            return { code: 99991663, msg: '卡片更新失败' };
          }
          patched.push({ message_id: path.message_id, content: data.content });
          return { code: 0 };
        } } },
      },
    },
    delivery: new SalesDeliveryService({ gateway, inventory: fakeInventory() }),
  });
  await service.sendDailyReminder({ now: NOW });

  const first = await clickFirstCard(service, 'order_unpaid_pending');
  assert.equal(first.collectedAmount, 260, 'patch 失败不影响成交');
  assert.equal(patched.length, 0);

  // patch 失败时没有把改过的卡写回记录，所以那张卡还是"有按钮"的样子：再点一次
  // 会走到 alreadyCompleted，把这一单补成灰的。
  const second = await clickFirstCard(service, 'order_unpaid_pending');
  assert.equal(second.alreadyCompleted, true);
  assert.equal(patched.length, 1);
  assert.deepEqual([...new Set(cardButtons(JSON.parse(patched[0].content))
    .map((button) => button.value.sales_entry_record_id))], ['order_prepaid_pending']);
});

test('同一张卡里的两单先后点：先灰的那单不会被后一次 patch 变回能点', async () => {
  const { service, patched } = reminderHarness();
  await service.sendDailyReminder({ now: NOW });

  await clickFirstCard(service, 'order_unpaid_pending');
  await clickFirstCard(service, 'order_prepaid_pending');

  assert.equal(patched.length, 2);
  const last = JSON.parse(patched[1].content);
  // 两单都灰了：第二次 patch 必须基于"已经改过的那张卡"再改（见 markCardSettled）。
  assert.deepEqual(cardButtons(last), [], '两单的按钮都该没了');
  assert.deepEqual(last.elements.filter((element) => element.tag === 'div')
    .map((element) => element.text.content), [
    'XSD-P-2　·　预付\n未收 ￥200　·　未交付 1/1 双',
    '✅ 已成交（10:00 点击）',
    'XSD-U-2　·　未付\n未收 ￥260',
    '✅ 已成交（10:00 点击）',
  ]);
});

test('交付只成了一半：不变灰（那几双货还要靠这张卡再点一次）', async () => {
  const { service, sent, patched } = reminderHarness({
    // 故意让交付失败：钱已经收下，货一双都没交出去。
    delivery: { deliver: async () => ({ deliveredQuantity: 0, failures: [{ detailRecordId: 'd_p2', error: '库存里没有' }] }) },
  });
  await service.sendDailyReminder({ now: NOW });

  const result = await clickFirstCard(service, 'order_prepaid_pending');

  assert.equal(result.delivery.failures.length, 1);
  assert.equal(patched.length, 0, '成交失败（只成一半）时绝不能变灰');
  // 卡片还是原样那一张，按钮都还在。
  assert.deepEqual([...new Set(cardButtons(cardOf(sent[0])).map((button) => button.value.sales_entry_record_id))],
    ['order_prepaid_pending', 'order_unpaid_pending']);
});

test('成交时底层直接抛错：卡片一个字都不动', async () => {
  const { service, patched } = reminderHarness({
    delivery: { deliver: async () => { throw new Error('库存服务连不上'); } },
  });
  await service.sendDailyReminder({ now: NOW });

  await assert.rejects(() => clickFirstCard(service, 'order_prepaid_pending'), /库存服务连不上/);
  assert.equal(patched.length, 0, '抛错时不能变灰，那张卡还得能重点');
});

test('patch 失败不影响成交结果（只记一条 warn，账已经写完）', async () => {
  const sent = [];
  const gateway = fakeGateway(reminderSeed());
  const service = new SecondDeliveryService({
    gateway, store: tmpStore('second-delivery-settle-'), chatId: CHAT_ID,
    // 飞书那边更新卡片失败（网络/权限），成交本身必须照常返回成功。
    client: { im: {
      message: { create: async ({ params, data }) => {
        sent.push({ params, data });
        return { code: 0, data: { message_id: `om_${sent.length}` } };
      } },
      v1: { message: { patch: async () => { throw new Error('patch 挂了'); } } },
    } },
    delivery: new SalesDeliveryService({ gateway, inventory: fakeInventory() }),
  });
  await service.sendDailyReminder({ now: NOW });

  const result = await clickFirstCard(service, 'order_unpaid_pending');

  assert.equal(result.alreadyCompleted, false);
  assert.equal(result.collectedAmount, 260);
  assert.equal(gateway.records.get('paymentRecord').find((row) => row.record_id === 'r_u2').fields['收款状态'], '已收款');
  assert.equal(await service.markCardSettled({ reminderDay: '2026-10-05', cardMessageId: 'om_1',
    salesEntryRecordId: 'order_unpaid_pending' }), false);
});

test('老卡片（按钮里没有 reminder_day）不改灰，也不报错', async () => {
  const { service, patched } = reminderHarness();
  await service.sendDailyReminder({ now: NOW });

  const result = await clickFirstCard(service, 'order_unpaid_pending', { reminderDay: '' });

  assert.equal(result.collectedAmount, 260, '成交照常完成');
  assert.equal(patched.length, 0, '取不到那张卡就不猜，宁可那次不变灰');
});

test('settleSecondDeliveryOrder：卡里没有这一单时返回 null，多行按钮只留一行灰字', async () => {
  const card = { config: {}, header: {}, elements: [
    { tag: 'div', text: { tag: 'lark_md', content: 'A' } },
    ...buttonRowsForTest('order_a', 4),
    { tag: 'div', text: { tag: 'lark_md', content: 'B' } },
    ...buttonRowsForTest('order_b', 1),
  ] };
  assert.equal(settleSecondDeliveryOrder(card, { salesEntryRecordId: 'order_c' }), null);

  const next = settleSecondDeliveryOrder(card, { salesEntryRecordId: 'order_a', settledAt: new Date('2026-10-05T14:57:00Z') });
  assert.deepEqual(next.elements.map((element) => element.tag), ['div', 'div', 'div', 'column_set']);
  assert.equal(next.elements[1].text.content, '✅ 已成交（22:57 点击）');
  assert.equal(next.elements[1].text.text_size, 'note');
  // 原卡没被动过（调用方拿的还是它自己那份）。
  assert.deepEqual(card.elements.map((element) => element.tag),
    ['div', 'column_set', 'column_set', 'div', 'column_set']);
});


// ─────────────────────────────────────────────────────────────────────────────
// 七、定时器：北京时间 9 点之前不跑
// ─────────────────────────────────────────────────────────────────────────────

test('东八区小时换算：UTC 01:00 就是北京 9 点', () => {
  assert.equal(shanghaiHour(new Date('2026-10-05T01:00:00Z')), 9);
  assert.equal(shanghaiHour(new Date('2026-10-05T00:30:00Z')), 8);
  assert.equal(shanghaiHour(new Date('2026-10-04T23:00:00Z')), 7);
});

test('定时器：9 点前不跑，过了 9 点就跑一次', async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  const early = [];
  const stopEarly = startSecondDeliveryReminder({
    run: async () => { early.push(1); },
    intervalMs: 60_000,
    now: () => Date.parse('2026-10-05T00:30:00Z'), // 北京 08:30
  });
  await settle();
  stopEarly();
  assert.equal(early.length, 0, '9 点前不该推');

  const late = [];
  const stopLate = startSecondDeliveryReminder({
    run: async () => { late.push(1); },
    intervalMs: 60_000,
    now: () => Date.parse('2026-10-05T02:00:00Z'), // 北京 10:00
  });
  await settle();
  stopLate();
  assert.equal(late.length, 1, '过了 9 点补推当天这一趟');
});

// ─────────────────────────────────────────────────────────────────────────────
// 八、机器人分派：没有草稿 id 也要能走这条链路
// ─────────────────────────────────────────────────────────────────────────────

test('卡片动作 confirm_second_delivery 按销售单号分派，不要求草稿 id（并带上卡片消息 id 与日期键）', async () => {
  let captured = null;
  const service = new LarkMvpService({
    client: {}, gateway: {}, references: {}, posting: {}, recognizer: {},
    store: tmpStore('second-delivery-mvp-'),
    purchaseBatchLocatorStore: tmpStore('second-delivery-locator-'),
    secondDelivery: { confirm: async (input) => {
      captured = input;
      return { alreadyCompleted: false, collectedAmount: 260, delivery: null };
    } },
  });

  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    context: { open_message_id: 'om_9' },
    action: { value: { action: 'confirm_second_delivery', draft_id: '',
      sales_entry_record_id: 'order_1', method: '微信', reminder_day: '2026-10-05' } },
  });

  // 卡片消息 id 从回调事件里取（成交成功后要拿它把那张卡改成已成交），
  // 日期键从按钮取值里带回来（用来取回当初发出去的那张卡）。
  assert.deepEqual(captured, { salesEntryRecordId: 'order_1', method: '微信', operatorOpenId: 'ou_1',
    cardMessageId: 'om_9', reminderDay: '2026-10-05' });
  assert.equal(result.toast.type, 'success');
  assert.match(result.toast.content, /补收款 ￥260/);
});

test('卡片动作 confirm_second_delivery 对已成交的单回 info，不报错', async () => {
  const service = new LarkMvpService({
    client: {}, gateway: {}, references: {}, posting: {}, recognizer: {},
    store: tmpStore('second-delivery-mvp-'),
    purchaseBatchLocatorStore: tmpStore('second-delivery-locator-'),
    secondDelivery: { confirm: async () => ({ alreadyCompleted: true }) },
  });
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_second_delivery', sales_entry_record_id: 'order_1', method: '微信' } },
  });
  assert.equal(result.toast.type, 'info');
});

test('交付只成了一半时如实说"还有几双没交"，不报成功', async () => {
  const service = new LarkMvpService({
    client: {}, gateway: {}, references: {}, posting: {}, recognizer: {},
    store: tmpStore('second-delivery-mvp-'),
    purchaseBatchLocatorStore: tmpStore('second-delivery-locator-'),
    secondDelivery: { confirm: async () => ({
      alreadyCompleted: false, collectedAmount: 200,
      delivery: { deliveredQuantity: 1, failures: [{ detailRecordId: 'd2', error: '库存里没有' }] },
    }) },
  });
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_second_delivery', sales_entry_record_id: 'order_1', method: '微信' } },
  });
  assert.equal(result.toast.type, 'warning');
  assert.match(result.toast.content, /1 双交付未完成/);
});
