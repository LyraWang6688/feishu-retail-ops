// 「退过 / 换过 / 赔过的单**不进**待处理清单」的验收用例（业务负责人 2026-10-08 口径）。
//
// 逐字口径：
//   「其实**不需要单号**，需要的是那个**编号和尺码信息**～……然后销售按照**预定和现货待收**分区，
//    **不需要退货和换货的**，销售就是预定和现货待收的」
//
// 真机伤口：日志里出现 `未知销售明细履约状态：已换货` 的 warn，整单跳过 ——
//   结果对，但看着像代码没想过这个取值。现在把它写成**明确规则**，日志如实说 reason。
//
// 本文件盯的是（验收标准 B1–B6）：
//   B1/B2/B3 明细含 已退货 / 已换货 / 已赔货 ⇒ 该单不进候选（逐条）；
//   B4 记 info（reason=after_sales_fulfillment），**不再**出现「未知销售明细履约状态」的 warn；
//   B5 三个字面量只从 config/afterSales 取（service 里没有第二份中文）；
//   B6 不误伤：未交付 / 已交付 的单照旧进候选。
// 逐条对照见 docs/pending-push-card-and-retry-2026-10-08.md 第 4 节。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { AFTER_SALES_FULFILLMENT, AFTER_SALES_FULFILLMENT_EXCLUDED } = require('../src/config/afterSales');

const tmpStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

const NOW = new Date('2026-10-08T02:00:00.000Z');
const SOLD_AT = Date.parse('2026-10-07T00:00:00.000Z');

// 假 Base：语义字段名 → 真实字段名映射与 schema 一致（写错字段名会当场露馅）。
const fakeGateway = (seed = {}) => {
  const records = new Map(Object.entries(seed).map(([key, rows]) =>
    [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  return {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    update: async () => ({}),
    create: async () => ({ recordId: 'x' }),
  };
};

const capture = () => {
  const lines = { info: [], warn: [] };
  const original = { log: console.log, warn: console.warn };
  console.log = (line) => lines.info.push(String(line));
  console.warn = (line) => lines.warn.push(String(line));
  return {
    lines,
    infoEvents: () => lines.info.map((line) => JSON.parse(line)),
    restore: () => { console.log = original.log; console.warn = original.warn; },
  };
};

// 一笔单：一张主表记录 + 一条明细（履约状态可控）+ 一条未收款。
const seedOrder = (orderId, fulfillmentStatus, { entryExtra = {} } = {}) => ({
  behavior: [{ record_id: 'behavior_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预定' } }],
  sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
  product: [{ record_id: 'prod_1', fields: { 编号: 'JC002' } }],
  salesEntry: [{
    record_id: orderId,
    fields: { 资金状态: '已写入', 销售单号: `XSD-${orderId}`, 交易类型: ['behavior_prepaid'], ...entryExtra },
  }],
  salesDetail: [{
    record_id: `${orderId}_d1`,
    fields: {
      销售单号: [orderId], 编号: ['prod_1'], 尺码: ['size_40'], 履约状态: fulfillmentStatus,
      成交金额: 128, 销售日: SOLD_AT,
    },
  }],
  paymentRecord: [{
    record_id: `${orderId}_p1`, fields: { 关联销售单: [orderId], 收款金额: 0, 收款状态: '未收款' },
  }],
});

const listWith = async (fulfillmentStatus, options) => {
  const gateway = fakeGateway(seedOrder('order_a', fulfillmentStatus, options));
  const service = new SecondDeliveryService({ gateway, store: tmpStore('pending-exclusion-') });
  return service.listPendingDeliveries({ now: NOW });
};

// ─────────────────────────────────────────────────────────────────────────────
// B1 / B2 / B3：三种售后履约状态 —— 逐条
// ─────────────────────────────────────────────────────────────────────────────

test('B1/B2/B3 明细含 已退货 / 已换货 / 已赔货 ⇒ 该单**不进**候选（逐条）', async () => {
  for (const status of [AFTER_SALES_FULFILLMENT.RETURNED,
    AFTER_SALES_FULFILLMENT.EXCHANGED, AFTER_SALES_FULFILLMENT.COMPENSATED]) {
    const captureLogs = capture();
    let orders;
    try {
      orders = await listWith(status);
    } finally {
      captureLogs.restore();
    }
    assert.deepEqual(orders, [], `「${status}」的单不许进候选`);
    const skipped = captureLogs.infoEvents()
      .find((entry) => entry.event === 'sales.second_delivery.reminder.order_skipped');
    assert.ok(skipped, `「${status}」要留一条 order_skipped`);
    assert.equal(skipped.reason, 'after_sales_fulfillment');
    assert.equal(skipped.fulfillment_status, status);
    // B4：**不再**把它说成"未知"（今天真机日志里的那条 warn 就是这么来的）。
    const joined = [...captureLogs.lines.info, ...captureLogs.lines.warn].join('\n');
    assert.ok(!joined.includes('未知销售明细履约状态'), `不许再打「未知」的 warn：${joined}`);
  }
  assert.deepEqual(AFTER_SALES_FULFILLMENT_EXCLUDED,
    ['已退货', '已换货', '已赔货'], 'B5 三个字面量只从 config/afterSales 取');
});

test('B5 判据来源：service 里没有第二份中文（只有配置里那一份）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/secondDeliveryService.js'), 'utf8');
  for (const literal of AFTER_SALES_FULFILLMENT_EXCLUDED) {
    assert.ok(!source.includes(`'${literal}'`), `service 里不许再写「${literal}」这个字面量`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B6：不误伤
// ─────────────────────────────────────────────────────────────────────────────

test('B6 未交付 / 已交付（含换货新换出去那一双）的单**照旧**进候选', async () => {
  const undelivered = await listWith('未交付');
  assert.equal(undelivered.length, 1);
  assert.equal(undelivered[0].salesEntryRecordId, 'order_a');
  assert.equal(undelivered[0].fulfillmentStatus, '未交付');

  // 已交付 + 钱没结清 = 现货待收，仍要进候选（新口径的关键一类）。
  const delivered = await listWith('已交付');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].fulfillmentStatus, '已交付');
});

test('B6 一单多件：只要有一件是售后件，整单不进（与"整单跳过"的既有行为一致）', async () => {
  const gateway = fakeGateway({
    ...seedOrder('order_a', '已交付'),
    salesDetail: [
      {
        record_id: 'order_a_d1',
        fields: {
          销售单号: ['order_a'], 编号: ['prod_1'], 尺码: ['size_40'], 履约状态: '已交付', 成交金额: 128, 销售日: SOLD_AT,
        },
      },
      {
        record_id: 'order_a_d2',
        fields: {
          销售单号: ['order_a'], 编号: ['prod_1'], 尺码: ['size_40'], 履约状态: '已换货', 成交金额: 0, 销售日: SOLD_AT,
        },
      },
    ],
  });
  const service = new SecondDeliveryService({ gateway, store: tmpStore('pending-exclusion-multi-') });
  const orders = await service.listPendingDeliveries({ now: NOW });
  assert.deepEqual(orders, []);
});
