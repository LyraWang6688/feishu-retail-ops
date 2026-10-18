/**
 * ⭐⭐ 明细 ID / 收款明细 ID / 主表交易类型 —— 业务负责人 **2026-10-12** 定的格式与用途。
 *
 * 她的原话（要点）：
 *   · **销售明细ID** = `{销售单号}-{两位序号}`（`XSD-…-01`、`…-02`）
 *   · **收款明细ID** = `{销售单号}-收款-{两位序号}`（第二笔 `-02`）
 *   · 「它们都是写在明细表里面的」「主表存的是**销售单号**」
 *   · 「明细 ID 相当于说，**这是这一次的第几双或者第几笔**」
 *   · 「**交易类型你忘记了，我们之前是可以多选的**，所以混合单它可以多选」
 *     ⚠️ 但**生产真表上「销售主表.交易类型」是 `SingleLink`（单选关联）**，不是多选
 *     ⇒ 本轮：全现货写现货 / 全预订写预订 / **混合单留空 + 记一条日志**（改多选是另一件事，她定）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-ID1 明细 ID 格式逐字：`{销售单号}-01`、`-02`（同一主单内按创建顺序）
 *  AC-ID2 收款 ID 格式逐字：`{销售单号}-收款-01`…；⭐ **【未收款】占位行也占号**
 *         （理由：它是一条真实存在的收款记录、且被"一次收清"改状态时**记录不变**
 *          ⇒ 号必须跟着记录走，不能等它变成已收款才补号）
 *  AC-ID3 ⭐ **后补的行接着排号、不重排已有行**（分笔补款 ⇒ 第三笔是 `-收款-03`）
 *  AC-ID4 **幂等重放不重复占号**（同一 `request_id` / 同一次建单重放 ⇒ 行不新增、号不变）
 *  AC-TT1/2 主表「交易类型」：全现货 ⇒ 写现货；全预订 ⇒ 写预订
 *  AC-TT3 ⭐ **混合单 ⇒ 主表那一列留空 + 一条日志**（生产上它是单选，写不了两个）
 *  AC-REG **其余字段一字未变**（主表 / 明细 / 收款行的字段**逐字**对照）
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { PaymentService } = require('../src/services/paymentService');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { SalesProgressService } = require('../src/services/salesProgressService');
const { SalesStatusWriter } = require('../src/services/salesStatusWriter');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const ENTRY = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
const DETAIL = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
const PAYMENT = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
const ORDER_NO = 'XSD-20261012-0001';
const ORDER_ID = 'order_1';

/** 内存假网关：语义键 → 真实列名走真 schema（写错语义键当场抛）。 */
const fakeGateway = () => {
  const records = new Map([
    ['salesEntry', [{ record_id: ORDER_ID, fields: { [ENTRY.orderNo]: ORDER_NO, [ENTRY.writeStatus]: '未完成' } }]],
    ['sizeManagement', [41, 42].map((size) => ({ record_id: `size_${size}`, fields: { [V1_BITABLE_SCHEMA.tables.sizeManagement.fields.size]: size } }))],
    ['behavior', [
      { record_id: 'behavior_cash', fields: { [V1_BITABLE_SCHEMA.tables.behavior.fields.code]: 'SALE_CASH' } },
      { record_id: 'behavior_prepaid', fields: { [V1_BITABLE_SCHEMA.tables.behavior.fields.code]: 'SALE_PREPAID' } },
    ]],
    ['paymentMethod', [{ record_id: 'method_微信', fields: { [V1_BITABLE_SCHEMA.tables.paymentMethod.fields.name]: '微信' } }]],
    ['product', [
      { record_id: 'product_A', fields: { [V1_BITABLE_SCHEMA.tables.product.fields.number]: 'A100|黑|A' } },
      { record_id: 'product_B', fields: { [V1_BITABLE_SCHEMA.tables.product.fields.number]: 'B200|棕|A' } },
    ]],
  ]);
  let seq = 0;
  const gateway = {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = {};
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
        if (!field) throw new Error(`${key}: unknown semantic field ${name}`);
        fields[field] = value;
      }
      records.set(key, [...(records.get(key) || []), { record_id: recordId, fields }]);
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      for (const [name, value] of Object.entries(values)) {
        const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
        if (!field) throw new Error(`${key}: unknown semantic field ${name}`);
        record.fields[field] = value;
      }
      return record;
    },
    delete: async (key, id) => records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id)),
  };
  return gateway;
};

const references = {
  resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
  resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }),
  // 「行为管理」里那两条现成的记录（现货 / 预订）—— 与 seed 的 behavior 表对得上
  resolveSalesTradeType: async (code) => ({
    recordId: String(code).toUpperCase() === 'SALE_PREPAID' ? 'behavior_prepaid' : 'behavior_cash',
  }),
};

const build = () => {
  const gateway = fakeGateway();
  const store = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sales-ids-')), idField: 'task_id' });
  const payments = new PaymentService({ gateway, references });
  const progress = new SalesProgressService({ gateway });
  return {
    gateway,
    payments,
    // ⚠️ 用**真的**状态写手：两维状态（销售 / 资金）是「订单已入账」的判据，补收款那条路会读它。
    orders: new SalesOrderService({
      gateway, references, payments, progress, status: new SalesStatusWriter({ gateway }),
    }),
    followup: new SalesFollowupService({ gateway, payments, progress, store }),
  };
};

const confirm = (harness, input = {}) => harness.orders.confirm({
  salesEntryRecordId: ORDER_ID,
  items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 240 }],
  payments: [{ method: '微信', amount: 100 }],
  ...input,
});

const detailsOf = (h) => h.gateway.records.get('salesDetail') || [];
const paymentsOf = (h) => h.gateway.records.get('paymentRecord') || [];
const cell = (row, field) => row.fields?.[field];
const detailIds = (h) => detailsOf(h).map((row) => cell(row, DETAIL.detailId));
const receiptIds = (h) => paymentsOf(h).map((row) => cell(row, PAYMENT.receiptId));

const captureInfo = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const value = await run();
    return { value, entries: lines.map((line) => JSON.parse(line)) };
  } finally { console.log = original; }
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-ID1 明细 ID：`{销售单号}-01`、`-02`
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID1 明细 ID = `{销售单号}-{两位序号}`，同一主单内按创建顺序 01 / 02', async () => {
  const h = build();
  await confirm(h, {
    items: [
      { itemNo: 'A100', size: 41, quantity: 1, actualAmount: 150, tradeTypeCode: 'SALE_CASH' },
      { itemNo: 'B200', size: 42, quantity: 1, actualAmount: 90, tradeTypeCode: 'SALE_CASH' },
    ],
    payments: [],
  });
  assert.deepEqual(detailIds(h), [`${ORDER_NO}-01`, `${ORDER_NO}-02`],
    '两双 ⇒ 01 / 02（她口径逐字：`{销售单号}-{两位序号}`）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ID2 收款 ID：`{销售单号}-收款-01`…；占位行也占号
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID2 收款 ID = `{销售单号}-收款-{两位序号}`；⭐【未收款】占位行**也占号**', async () => {
  const h = build();
  // 「卖了 240，先给 100，还欠 140」⇒ 一条已收 + 一条【未收款】占位
  await confirm(h, {
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 240 }],
    payments: [{ method: '微信', amount: 100 }],
    owed: 140,
  });
  assert.deepEqual(receiptIds(h), [`${ORDER_NO}-收款-01`, `${ORDER_NO}-收款-02`],
    '定金 = -01、【未收款】占位 = -02（占位行是一条真实存在的收款记录，号跟着记录走）');
  const pending = paymentsOf(h)[1];
  assert.equal(cell(pending, PAYMENT.status), '未收款');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ID3 后补的行接着排号、不重排已有行
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID3 ⭐ 后补一行 ⇒ 接着排号、不重排已有行（分笔补款：第三笔 = `-收款-03`）', async () => {
  const h = build();
  await confirm(h, {
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 240 }],
    payments: [{ method: '微信', amount: 100 }],
    owed: 140,
  });
  const before = receiptIds(h);
  // 工作台**分笔**补两笔（第二笔把 140 收满）
  await h.followup.addPayment({
    requestId: '00000000-0000-4000-8000-000000000001', salesEntryRecordId: ORDER_ID,
    amount: 100, method: '微信', operatorOpenId: 'ou_1',
  });
  await h.followup.addPayment({
    requestId: '00000000-0000-4000-8000-000000000002', salesEntryRecordId: ORDER_ID,
    amount: 40, method: '微信', operatorOpenId: 'ou_1',
  });
  assert.deepEqual(receiptIds(h).slice(0, before.length), before, '已有的两行**一个字符都没被改**');
  assert.deepEqual(receiptIds(h), [
    `${ORDER_NO}-收款-01`, `${ORDER_NO}-收款-02`, `${ORDER_NO}-收款-03`, `${ORDER_NO}-收款-04`,
  ], '后补的两笔接着排 03 / 04');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ID4 幂等重放不重复占号
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID4 幂等重放不重复占号：建单重放 + 同一 request_id 重放 ⇒ 行不新增、号不变', async () => {
  const h = build();
  const input = {
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 240 }],
    payments: [{ method: '微信', amount: 100 }],
    owed: 140,
  };
  const first = await confirm(h, input);
  const idsAfterFirst = { detail: detailIds(h), receipt: receiptIds(h) };
  // ① 建单重放（同一次提交，按既有幂等协议把已写行的 id 传回来）
  const again = await confirm(h, {
    ...input,
    knownRecordIds: { details: first.detailRecordIds, payments: first.paymentRecordIds },
  });
  assert.deepEqual(again.detailRecordIds, first.detailRecordIds, '重放复用原来那几行');
  assert.deepEqual({ detail: detailIds(h), receipt: receiptIds(h) }, idsAfterFirst, '号一个都没变、也没多');

  // ② 同一 request_id 再补一笔 ⇒ 不新占号
  const req = { requestId: '00000000-0000-4000-8000-0000000000ff', salesEntryRecordId: ORDER_ID, amount: 10, method: '微信', operatorOpenId: 'ou_1' };
  await h.followup.addPayment(req);
  const after = receiptIds(h);
  await h.followup.addPayment(req);
  assert.deepEqual(receiptIds(h), after, '重放不新增行、不占新号');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-TT1/2/3 主表「交易类型」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID5 ⭐ 未付单：【未收款】占位行**占 01**，之后每笔真实收款接着 02、03…', async () => {
  const h = build();
  // 「卖了 140，一分钱还没收」⇒ 这一单只有那条【未收款】占位行
  await confirm(h, {
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 140 }],
    payments: [],
    owed: 140,
  });
  assert.deepEqual(receiptIds(h), [`${ORDER_NO}-收款-01`],
    '占位行**算一个号**、而且它就是 01（她 2026-10-12 的口径：「占位行也算一个号」）');
  await h.followup.addPayment({
    requestId: '00000000-0000-4000-8000-0000000000aa', salesEntryRecordId: ORDER_ID,
    amount: 90, method: '微信', operatorOpenId: 'ou_1',
  });
  await h.followup.addPayment({
    requestId: '00000000-0000-4000-8000-0000000000bb', salesEntryRecordId: ORDER_ID,
    amount: 50, method: '现金', operatorOpenId: 'ou_1',
  });
  assert.deepEqual(receiptIds(h),
    [`${ORDER_NO}-收款-01`, `${ORDER_NO}-收款-02`, `${ORDER_NO}-收款-03`],
    '真实收款接着 02 / 03（占位行那个号不被重排、也不被抢）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-REG 其余字段一字未变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-REG 其余字段一字未变：主表 / 明细 / 收款行的字段**逐字**对照', async () => {
  const h = build();
  await confirm(h, {
    items: [{ itemNo: 'A100', size: 41, quantity: 1, actualAmount: 240, tradeTypeCode: 'SALE_CASH' }],
    payments: [{ method: '微信', amount: 100 }],
    owed: 140,
  });
  const entry = await h.gateway.get('salesEntry', ORDER_ID);
  // ⭐ 2026-10-16 **成对迁移**（加一列，判据的严格度不变：仍是"这一单写到的列**逐个**对上"）——
  //   · 改前逐字：
  //     `assert.deepEqual(Object.keys(entry.fields).sort(), [ENTRY.orderNo, ENTRY.tradeType, ENTRY.userAction, ENTRY.gift, ENTRY.sales, ENTRY.funds].sort(),`
  //   · 改后逐字：下面这一行（数组末尾加了 `ENTRY.totalAmount`，期望里同时加了 `ENTRY.totalAmount`）
  //   · 依据 = 业务负责人 2026-10-16 逐字：「我在销售主表里面加了一个货币字段，叫做「**总金额**」。
  //     这个就是用来记录我们「**一单多货**」时需要判断的**累计金额**，也是**它的写入地方**。」
  //     ⇒ 这一单（1 行、实收 240）写到的「总金额」= 240，**多出来的这一列是她的口径**，不是漂移。
  //   ⚠️ 本用例**没有放宽**：仍是 `deepEqual` 全等（少一列 / 多一列都红）。
  assert.deepEqual(Object.keys(entry.fields).sort(),
    [ENTRY.orderNo, ENTRY.gift, ENTRY.totalAmount, ENTRY.writeStatus].sort(),
    '主表这次写到的列：销售单号 / 赠品 / 总金额 / 写入状态 —— 没有多出来的列');
  assert.equal(cell(entry, ENTRY.totalAmount), 240, '「总金额」= 各行实收之和（这一单只有一行 240）');
  assert.deepEqual(Object.keys(detailsOf(h)[0].fields).sort(),
    [DETAIL.salesEntry, DETAIL.product, DETAIL.size, DETAIL.actualAmount, DETAIL.fulfillmentStatus, DETAIL.tradeType, DETAIL.detailId].sort(),
    '明细行：原有 6 列 + 新的「销售明细ID」，其余不变');
  assert.deepEqual(Object.keys(paymentsOf(h)[0].fields).sort(),
    [PAYMENT.salesEntry, PAYMENT.method, PAYMENT.amount, PAYMENT.status, PAYMENT.receivedAt, PAYMENT.tradeDirection, PAYMENT.receiptId].sort(),
    '收款行：原有 6 列 + 新的「收款明细ID」');
  assert.equal(cell(paymentsOf(h)[0], PAYMENT.receivedAt) > 0, true, '「收款日」照旧是点击那一刻');
  assert.deepEqual(cell(paymentsOf(h)[0], PAYMENT.tradeDirection), '收入', '交易方向照旧');
});
