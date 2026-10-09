// 「9 点待处理单推送」三块候选的**取数口径**（验收标准，据 `docs/push-blocks-caliber-2026-10-08.md`
// 与业务负责人 2026-10-08 晚对**聚合单位**的纠正）。
//
// 本文件**直接**盯着取数那一处（`PendingPushCandidateService` + `config/pendingPushCandidates`）——
// 渲染（标题 / 两栏 / 卡片标记）不在这里，那一份在 pendingDealPush*.test.js。
//
// 业务负责人 2026-10-08 晚的口径（逐字）：
//   「首先是现货未收：你只需要去交易明细里看交易类型，如果类型是现货但未收款，那就属于现货未收。
//    对于预定的：你需要去销售明细里找**预定但未交付**的，同时再去收款明细里找到**这笔销售单号
//    对应的未收款金额**，就很简单」，补充：「**直接按照销售单号去进行聚合**就可以了」。
//   ⇒ ⭐ **聚合单位 = 一张销售单一行**（旧版"一条明细一行 / 一条收款明细一行"是错的）：
//   ①【预定】    = 销售明细里 **交易类型 = 预定（行为编码 `SALE_PREPAID`）** 且 **履约状态 ≠ 已交付** 的件；
//                  一行 = 一张销售单，文字 = 该单**符合条件的那几件**（货号 颜色 尺码，并列）；
//                  金额 = **该销售单号在「收款明细」里所有 `收款状态 = 未收款` 的金额之和**。
//   ②【现货未收】= 收款明细里 **交易类型 = 现货（行为编码 `SALE_CASH`）** 且 **收款状态 = 未收款** 的记录；
//                  一行 = 一张销售单（同一单多条未收款 ⇒ 一行），文字 = 该单的 货号 颜色 尺码；
//                  金额 = **同一口径**（该销售单号下所有 `收款状态 = 未收款` 的金额之和）。
//   ③【采购】    = 报货批次里 **到货状态 = 未到货**（沿用 `PurchasePendingBatchService`）；
//                  只多带两个字段：**报货日**（飞书自动字段）+ **录入数量**。
//
// 交易类型**只按行为编码认**（那两列在真表上是**关联 / 查表引用**，指到「行为管理」）：
//   · 销售明细 —— 关联（格里是行为记录 id）；
//   · 收款明细 —— 查表引用（格里是 `{ text }`）。
// 两种形状都收敛到同一个编码；本用例两种都覆盖。
//
// 时间窗：**最近 7 天**（上海自然日）；【预定】按**销售明细的销售日**、
// 【现货未收】按**收款明细的创建时间**。
// 缺字段的硬要求：**照推 + 记日志，绝不静默丢单**。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PendingPushCandidateService, REMINDER_WINDOW_DAYS } = require('../src/services/pendingPushCandidateService');
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { resolvePendingPushCandidateConfig } = require('../src/config/pendingPushCandidates');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');
const { SALES_MOVEMENTS } = require('../src/config/salesMovements');

const NOW = new Date('2026-10-08T02:00:00.000Z'); // 北京 10:00
// 一律用**上海自然日**表达（与生产同一套口径：服务器是 UTC）。
const atShanghai = (day) => Date.parse(`${day}T10:00:00+08:00`);

// ── 假 Base ─────────────────────────────────────────────────────────────────
// 语义字段名 → 真实字段名映射**与真 schema 一致**（写错字段名会当场露馅）。
// ⚠️ 「行为管理」那张表默认就在（真 Base 里也一样）：交易类型的判据是**行为编码**，
//    关联形状必须能换出编码来。要模拟"读不到行为表"就传 `behavior: []` 把它覆盖掉。
const behaviorRow = (recordId, code, name) => ({
  record_id: recordId, fields: { 行为编码: code, 行为名称: name },
});
const BEHAVIOR = {
  cash: behaviorRow('bhv_cash', 'SALE_CASH', '现货'),
  prepaid: behaviorRow('bhv_prepaid', 'SALE_PREPAID', '预定'),
};
const BEHAVIOR_ROWS = [BEHAVIOR.cash, BEHAVIOR.prepaid];

const fakeGateway = (seed = {}) => {
  const reads = [];
  const records = new Map(Object.entries({ behavior: BEHAVIOR_ROWS, ...seed }).map(([key, rows]) =>
    [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  return {
    reads,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => { reads.push(key); return records.get(key) || []; },
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id) || null,
  };
};

const captureLogs = () => {
  const lines = { info: [], warn: [] };
  const original = { log: console.log, warn: console.warn };
  console.log = (line) => lines.info.push(String(line));
  console.warn = (line) => lines.warn.push(String(line));
  return {
    lines,
    events: () => [...lines.info, ...lines.warn].map((line) => JSON.parse(line)),
    restore: () => { console.log = original.log; console.warn = original.warn; },
  };
};

// ── 造数的形状（与真表一致的字段名）────────────────────────────────────────────
// 「已入账」的判据是 `isPosted(postedOf(...))`，而 `postedOf` 读的是**「资金状态」**
// （见 config/salesStatusDimensions）——夹具按真表那一列填。
const entry = (recordId, extra = {}) => ({
  record_id: recordId,
  fields: { 销售单号: `XSD-${recordId}`, 资金状态: '已写入', ...extra },
});
// 「交易类型」= **关联「行为管理」**（格里是行为记录 id；`null` = 这一格没值）。
const detail = (recordId, entryId, productId, {
  status = '未交付', amount = 128, soldAt = null, size = 'sz_37', tradeType = 'bhv_prepaid',
} = {}) => ({
  record_id: recordId,
  fields: {
    销售单号: [entryId], 编号: [productId], 尺码: size ? [size] : [],
    履约状态: status, 成交金额: amount,
    销售日: soldAt === null ? atShanghai('2026-10-06') : soldAt,
    交易类型: tradeType === null ? undefined : (Array.isArray(tradeType) ? tradeType : [tradeType]),
  },
});
// 收款明细的「交易类型」在真表上是**查表引用**（格里是 `{ text }`）；
// 这里默认用关联形状（记录 id），要看查表引用那条路就传 `{ text: '现货' }`。
const payment = (recordId, entryId, {
  status = '未收款', amount = 128, tradeType = 'bhv_cash', createdAt = null,
} = {}) => ({
  record_id: recordId,
  fields: {
    关联销售单: [entryId], 收款金额: amount, 收款状态: status,
    交易类型: tradeType === null ? undefined : (Array.isArray(tradeType) ? tradeType : [tradeType]),
    创建时间: createdAt === null ? atShanghai('2026-10-06') : createdAt,
  },
});
const product = (recordId, itemNo, color = '黑色') => ({
  record_id: recordId, fields: { 货号: itemNo, 编号: itemNo, 颜色: color },
});
const batch = (recordId, batchNo, arrivalStatus, extra = {}) => ({
  record_id: recordId,
  fields: { 报货批次号: batchNo, 到货状态: arrivalStatus, 幂等键: `k_${recordId}`, ...extra },
});

// 尺码解析的桩：形状与 `SecondDeliveryService.resolveDetailSize(detail, detailFields)` 一致。
const sizeByRecordId = { sz_37: 37, sz_43: 43 };
const secondDeliveryStub = (itemIndex = {}) => ({
  loadItemIndex: async () => itemIndex,
  resolveDetailSize: async (detailRow, detailFields) => {
    const cell = detailRow?.fields?.[detailFields?.size];
    const id = Array.isArray(cell) ? cell[0] : cell;
    return id && sizeByRecordId[id] !== undefined ? String(sizeByRecordId[id]) : '';
  },
});

const ITEM_INDEX = {
  product: { labelField: '货号', colorField: '颜色', byId: new Map([
    ['prod_a', product('prod_a', 'B26002-52', '黑色')],
    ['prod_b', product('prod_b', '6A637-7', '白色')],
  ]) },
};
const PRODUCTS = [product('prod_a', 'B26002-52', '黑色'), product('prod_b', '6A637-7', '白色')];

const listCandidates = async (seed, { itemIndex = ITEM_INDEX, purchasePending, settings } = {}) =>
  new PendingPushCandidateService({
    gateway: fakeGateway(seed),
    secondDelivery: secondDeliveryStub(itemIndex),
    purchasePending,
    settings,
  }).listCandidates({ now: NOW });

// 一行的文字（渲染层就是把它按 `、` 连起来）。
const itemsOf = (row) => (row.facts || []).map((item) => `${item.itemNo} ${item.color} ${item.size}`);

// ═════════════════════════════════════════════════════════════════════════════
// ① 【预定】：销售明细里「交易类型 = 预定」且「履约状态 ≠ 已交付」，**一张销售单一行**
// ═════════════════════════════════════════════════════════════════════════════

test('①【预定】一单两件 ⇒ **只出一行**：两件的 货号 颜色 尺码 并列在同一行', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '未交付', size: 'sz_37' }),
      detail('d2', 'o1', 'prod_b', { status: '未交付', size: 'sz_43' }),
      // 已交付那一件**不进**【预定】
      detail('d3', 'o1', 'prod_b', { status: '已交付' }),
    ],
    paymentRecord: [],
    product: PRODUCTS,
  });
  assert.equal(sales.length, 1, '⭐ 一张销售单 = 一行（不是"一条明细一行"）');
  // 行身份 = **销售单 record id**（落盘 / 日志排查用）。
  assert.equal(sales[0].rowId, 'o1');
  assert.equal(sales[0].salesEntryRecordId, 'o1');
  assert.equal(sales[0].criterion, 'undelivered');
  assert.deepEqual(itemsOf(sales[0]), ['B26002-52 黑色 37', '6A637-7 白色 43']);
});

test('①【预定】一行里只列「预定 + 未交付」的件：现货那件 / 已交付那件都不列', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [
        detail('d1', 'o1', 'prod_a', { status: '未交付', tradeType: 'bhv_prepaid', size: 'sz_37' }),
        // 现货（`SALE_CASH`）那一件：交易类型判据不匹配 ⇒ 不进【预定】
        detail('d2', 'o1', 'prod_b', { status: '未交付', tradeType: 'bhv_cash', size: 'sz_43' }),
        // 预定但**已交付** ⇒ 也不进【预定】
        detail('d3', 'o1', 'prod_b', { status: '已交付', tradeType: 'bhv_prepaid', size: 'sz_43' }),
      ],
      paymentRecord: [],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.equal(result.sales.length, 1);
  assert.deepEqual(itemsOf(result.sales[0]), ['B26002-52 黑色 37']);
  // 读得到、判据不匹配的那一件要留一条 **info**（便于对账），而不是静默消失。
  const skipped = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.detail_skipped');
  assert.ok(skipped, '被判据排除的那件要留一条 info');
  assert.equal(skipped.detail_record_id, 'd2');
  assert.equal(skipped.reason, 'trade_type_not_prepaid');
  assert.deepEqual(skipped.trade_type_codes, ['SALE_CASH']);
});

test('①【预定】一单两条未收款 ⇒ 只出一行，金额是**该单所有未收款之和**（不是某一条）', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付' })],
    paymentRecord: [
      payment('p1', 'o1', { status: '未收款', amount: 60 }),
      payment('p2', 'o1', { status: '未收款', amount: 40 }),
      // 已收款 / 待平台结算的**不算**未收款。
      payment('p3', 'o1', { status: '已收款', amount: 500 }),
      payment('p4', 'o1', { status: '待平台结算', amount: 85.4 }),
    ],
    product: PRODUCTS,
  });
  assert.equal(sales.length, 1);
  assert.equal(sales[0].pendingAmount, 100, '60 + 40（不是 500、也不是成交额 − 已收）');
});

test('①【预定】金额逐单算：别的单的收款不冲抵这一单的未收款', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1'), entry('o2')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '未交付' }),
      detail('d2', 'o2', 'prod_b', { status: '未交付' }),
    ],
    paymentRecord: [
      payment('p_o2', 'o2', { status: '未收款', amount: 200 }),
      payment('p_o2_paid', 'o2', { status: '已收款', amount: 999 }),
    ],
    product: PRODUCTS,
  });
  assert.deepEqual(sales.map((row) => [row.salesEntryRecordId, row.pendingAmount]), [
    // o1 一分未收（没有收款明细）⇒ 合计 0 ⇒ 渲染层写「已付清」；这一行**照样在**。
    ['o1', 0],
    ['o2', 200],
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// ② 【现货未收】：收款明细里「交易类型 = 现货」且「收款状态 = 未收款」，**一张销售单一行**
// ═════════════════════════════════════════════════════════════════════════════

test('②【现货未收】一单两条未收款 ⇒ **只出一行**，金额是两条的合计', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
    paymentRecord: [
      payment('p1', 'o1', { status: '未收款', amount: 120.5, tradeType: 'bhv_cash' }),
      payment('p2', 'o1', { status: '未收款', amount: 80, tradeType: 'bhv_cash' }),
    ],
    product: PRODUCTS,
  });
  assert.equal(cash.length, 1, '⭐ 同一单的两条未收款也只有一个销售单号 ⇒ 一行');
  assert.equal(cash[0].rowId, 'o1');
  assert.equal(cash[0].criterion, 'delivered_unpaid');
  assert.equal(cash[0].pendingAmount, 200.5, '120.5 + 80 = 合计（不是其中一条）');
});

test('②【现货未收】按**行为编码**筛：「预定」那条 / 已收款 / 待平台结算都不进', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      // 这一单的明细都**已交付** ⇒ 不属于【预定】（但现货未收那条照样要出）。
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
      paymentRecord: [
        payment('p_cash', 'o1', { status: '未收款', amount: 300, tradeType: 'bhv_cash' }),
        payment('p_prepaid', 'o1', { status: '未收款', amount: 50, tradeType: 'bhv_prepaid' }),
        payment('p_paid', 'o1', { status: '已收款', amount: 10, tradeType: 'bhv_cash' }),
        payment('p_settle', 'o1', { status: '待平台结算', amount: 20, tradeType: 'bhv_cash' }),
      ],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.cash.map((row) => row.rowId), ['o1']);
  assert.deepEqual(result.sales, [], '明细都已交付 ⇒【预定】为空');
  // ⚠️ 金额口径是"**该销售单号下所有 `收款状态 = 未收款` 的金额之和**"（她的口径逐字）
  //    ⇒ 同一单里那笔"预定未收"的 50 **也在内**：这一行说的是"这一单还欠多少钱"。
  assert.equal(result.cash[0].pendingAmount, 350, '300（现货未收）+ 50（同一单的另一笔未收款）');
  const skipped = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.payment_skipped');
  assert.ok(skipped, '被判据排除的那条要留一条 info');
  assert.equal(skipped.payment_record_id, 'p_prepaid');
  assert.equal(skipped.reason, 'trade_type_not_cash');
  assert.deepEqual(skipped.trade_type_codes, ['SALE_PREPAID']);
});

test('②【现货未收】文字 = **该单的明细**（多件并列在同一行）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '已交付', size: 'sz_37' }),
      detail('d2', 'o1', 'prod_b', { status: '已交付', size: 'sz_43' }),
    ],
    paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 300 })],
    product: PRODUCTS,
  });
  assert.equal(cash.length, 1);
  assert.deepEqual(itemsOf(cash[0]), ['B26002-52 黑色 37', '6A637-7 白色 43']);
});

test('②【现货未收】收款明细的「交易类型」是**查表引用**（格里是文字）也认得出编码', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
    paymentRecord: [
      payment('p_ref_cash', 'o1', { status: '未收款', amount: 100, tradeType: { text: '现货' } }),
      payment('p_ref_prepaid', 'o1', { status: '未收款', amount: 20, tradeType: { text: '预定' } }),
    ],
    product: PRODUCTS,
  });
  assert.deepEqual(cash.map((row) => row.rowId), ['o1'], '查表引用形状照进【现货未收】');
  assert.equal(cash[0].pendingAmount, 120, '同一单两条未收款之和（100 + 20）');
});

test('② 判据读得到但**按文字认不出编码** ⇒ 进候选 + 记 warn（宁可不丢单）', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
      // 真表上出现一个**没见过的**说法（换过名字 / 新加的行为）⇒ 编码认不出来。
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 66, tradeType: { text: '门市' } })],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.cash.map((row) => row.rowId), ['o1']);
  assert.ok(logs.events().some((log) => log.event === 'sales.pending_deal_push.candidate.trade_type_unreadable'));
});

// ═════════════════════════════════════════════════════════════════════════════
// ③ 【采购】：未到货的报货批次 + 报货日 + 录入数量
// ═════════════════════════════════════════════════════════════════════════════

test('③【采购】候选来自 `PurchasePendingBatchService`（未到货），并带上报货日 / 录入数量', async () => {
  const calls = [];
  const purchasePending = {
    listPendingBatches: async () => {
      calls.push('listPendingBatches');
      return [{
        batchNo: 'CGD-20261007-0001',
        recordId: 'bat_1',
        suppliers: ['金猴'],
        reportedAt: atShanghai('2026-10-05'),
        quantity: '12',
      }];
    },
  };
  const { purchase } = await listCandidates({ salesEntry: [], salesDetail: [], paymentRecord: [] }, { purchasePending });
  assert.deepEqual(calls, ['listPendingBatches']);
  assert.equal(purchase.length, 1);
  assert.equal(purchase[0].suppliers[0], '金猴');
  assert.equal(purchase[0].quantity, '12');
  assert.equal(purchase[0].reportedAt, atShanghai('2026-10-05'));
});

test('③ 采购读表失败：**不拖垮**销售那半边（记 warn + 采购当空）', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付' })],
      paymentRecord: [],
      product: PRODUCTS,
    }, {
      purchasePending: { listPendingBatches: async () => { throw new Error('模拟：读「报货批次」失败'); } },
    });
  } finally {
    logs.restore();
  }
  assert.equal(result.sales.length, 1, '销售候选照常');
  assert.deepEqual(result.purchase, []);
  assert.ok(logs.events().some((log) => log.event === 'sales.pending_deal_push.purchase_candidates_failed'));
});

// ═════════════════════════════════════════════════════════════════════════════
// ④ 时间窗：最近 7 天（上海自然日），两块按各自的日期列判
// ═════════════════════════════════════════════════════════════════════════════

test('④【预定】按**销售明细的销售日**判 7 天窗口：第 7 天在、第 8 天不在', async () => {
  const inWindow = atShanghai('2026-10-02'); // 10-08 往前数第 7 个自然日（含今天）
  const outOfWindow = atShanghai('2026-10-01');
  assert.equal(REMINDER_WINDOW_DAYS, 7, '窗口口径与「二次交付成交提醒」同一个数（7 天）');
  const { sales } = await listCandidates({
    salesEntry: [entry('o1'), entry('o2')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '未交付', soldAt: inWindow }),
      detail('d2', 'o2', 'prod_b', { status: '未交付', soldAt: outOfWindow }),
    ],
    paymentRecord: [],
    product: PRODUCTS,
  });
  assert.deepEqual(sales.map((row) => row.salesEntryRecordId), ['o1']);
});

test('④【现货未收】按**收款明细的创建时间**判 7 天窗口（不是销售日）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付', soldAt: atShanghai('2026-09-01') })],
    paymentRecord: [
      payment('p_in', 'o1', { status: '未收款', amount: 10, createdAt: atShanghai('2026-10-03') }),
      payment('p_out', 'o1', { status: '未收款', amount: 20, createdAt: atShanghai('2026-09-30') }),
    ],
    product: PRODUCTS,
  });
  // 销售日是 09-01（早就出了 7 天窗）但收款创建时间在窗内 ⇒ **照进**。
  assert.deepEqual(cash.map((row) => row.rowId), ['o1']);
  // ⚠️ 窗口只管"这单出不出现在这一块"；**金额**仍是"该销售单号下所有未收款之和"
  //    （她的口径逐字，没有加窗口限定）⇒ 窗口外那 20 也算在这一单的未收款里。
  assert.equal(cash[0].pendingAmount, 30);
});

// ═════════════════════════════════════════════════════════════════════════════
// ⑤ 缺字段：**照推 + 记日志，绝不静默丢单**（她的硬要求）
// ═════════════════════════════════════════════════════════════════════════════

test('⑤【预定】交易类型**那一格没值** ⇒ 照进候选 + 一条 warn（不静默丢单）', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付', tradeType: null })],
      paymentRecord: [],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.equal(result.sales.length, 1, '读不到判据字段 ≠ 不符合判据：照进');
  assert.deepEqual(itemsOf(result.sales[0]), ['B26002-52 黑色 37']);
  const warned = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.trade_type_unreadable');
  assert.ok(warned, '读不到就要留一条 warn');
  assert.deepEqual(warned.detail_record_ids, ['d1']);
  assert.equal(warned.trade_type_field, '交易类型');
});

test('⑤【现货未收】交易类型**那一格没值** ⇒ 照进候选 + 一条 warn（不静默丢单）', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 66, tradeType: null })],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.cash.map((row) => row.rowId), ['o1'], '读不到判据字段 ≠ 不符合判据：照进');
  assert.equal(result.cash[0].pendingAmount, 66);
  const warned = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.trade_type_unreadable');
  assert.ok(warned, '读不到就要留一条 warn');
  assert.deepEqual(warned.payment_record_ids, ['p1']);
});

test('⑤「行为管理」读不到（关联形状换不出编码）⇒ 照样照推 + warn，绝不静默丢单', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      // ⚠️ `behavior: []` = 这张表这一轮读回来是空的（真表被改名 / 读挂了那种形态）。
      behavior: [],
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付' })],
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 66 })],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.equal(result.sales.length, 1);
  assert.deepEqual(result.cash.map((row) => row.rowId), ['o1']);
  assert.ok(logs.events().some((log) => log.event === 'sales.pending_deal_push.candidate.trade_type_unreadable'));
});

test('⑤ 未收款那笔的金额读不出来 ⇒ 行**照出**、金额留空（null）+ 一条 warn', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付' })],
      // 未收款那一笔没填金额 ⇒ 合计算不出来（少算一笔也是错的）。
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: '' })],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.equal(result.sales.length, 1, '这一行**照样出**（金额整段不渲染交给渲染层）');
  assert.equal(result.sales[0].pendingAmount, null);
  const warned = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.amount_unavailable');
  assert.ok(warned);
  assert.deepEqual(warned.sales_entry_record_ids, ['o1']);
});

test('⑤ 货号取不到 ⇒ 那一行仍然产出（`facts` 为空，渲染层给占位）+ 一条汇总 warn', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      // 明细指向一条**在货品表里不存在**的编号 ⇒ 取不到货号。
      salesDetail: [detail('d1', 'o1', 'prod_missing', { status: '未交付' })],
      paymentRecord: [],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.equal(result.sales.length, 1, '取不到货号也不许把这一行丢掉');
  assert.deepEqual(result.sales[0].facts, []);
  assert.equal(result.sales[0].pendingAmount, 0);
  assert.ok(logs.events().some((log) => log.event === 'sales.pending_deal_push.candidate.items_incomplete'));
});

test('⑤ 货品表读挂了 ⇒ 照推（这一轮没有货号事实）+ 一条 warn', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付' })],
      paymentRecord: [],
      product: PRODUCTS,
    }, {
      itemIndex: null,
    });
  } finally {
    logs.restore();
  }
  // `loadItemIndex` 返回 null ⇒ 事实全取不到，但**行照出**。
  assert.equal(result.sales.length, 1);
  assert.deepEqual(result.sales[0].facts, []);
  assert.ok(logs.events().some((log) => log.event === 'sales.pending_deal_push.candidate.items_incomplete'));
});

// ═════════════════════════════════════════════════════════════════════════════
// ⑥ 两块的边界：售后件不进、未入账不进、空就是空（**空块整块不出现**）
// ═════════════════════════════════════════════════════════════════════════════

test('⑥ 售后件（已退货 / 已换货 / 已赔货）整单不进两块候选，记 reason=after_sales_fulfillment', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [
        detail('d1', 'o1', 'prod_a', { status: '已换货', amount: 0 }),
        detail('d2', 'o1', 'prod_b', { status: '已交付', amount: 100 }),
      ],
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100 })],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.sales, []);
  assert.deepEqual(result.cash, [], '整单不进（含收款那一条）');
  const skipped = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.order_skipped');
  assert.equal(skipped.reason, 'after_sales_fulfillment');
});

test('⑥ 未入账的销售单不进候选（没写明细，推了也没有货号）', async () => {
  const { sales, cash } = await listCandidates({
    salesEntry: [entry('o1', { 资金状态: '未写入' })],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付' })],
    paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100 })],
    product: PRODUCTS,
  });
  assert.deepEqual(sales, []);
  assert.deepEqual(cash, []);
});

test('⑥ 两块都没有候选 ⇒ 两块都是空；**空块整块不出现**（渲染层拿到 0 个区块）', async () => {
  const result = await listCandidates({ salesEntry: [], salesDetail: [], paymentRecord: [] });
  assert.deepEqual(result, { sales: [], cash: [], purchase: [] });
  // `buildSections` 是纯分组（只读 settings）—— 用一个只挂 settings 的实例直接调它，
  // 免得为了这一条断言去建 client / 落盘目录。
  const service = Object.create(PendingDealPushService.prototype);
  service._settings = resolvePendingDealPushConfig({});
  assert.deepEqual(service.buildSections(result.sales.concat(result.cash)), [],
    '没有行 ⇒ 一个区块都不产出（空块不出现；区块渲染的完整用例在 pendingDealPush*.test.js）');
});

test('⑥ 只有【现货未收】有行时，【预定】那一块**整块不出现**', async () => {
  const { sales, cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
    paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100 })],
    product: PRODUCTS,
  });
  assert.deepEqual(sales, [], '【预定】没有候选');
  assert.equal(cash.length, 1);
  const service = Object.create(PendingDealPushService.prototype);
  service._settings = resolvePendingDealPushConfig({});
  assert.deepEqual(service.buildSections([...sales, ...cash]).map((section) => section.key), ['cash_pending'],
    '只有有行的那一块在；【预定】那块整块不出现');
});

test('⑥ 没有任何销售候选时**不去读货品表 / 尺码表**（省掉那次额外请求）', async () => {
  const calls = [];
  await new PendingPushCandidateService({
    gateway: fakeGateway({ salesEntry: [], salesDetail: [], paymentRecord: [] }),
    secondDelivery: {
      loadItemIndex: async () => { calls.push('loadItemIndex'); return ITEM_INDEX; },
      resolveDetailSize: async () => { calls.push('resolveDetailSize'); return '37'; },
    },
  }).listCandidates({ now: NOW });
  assert.deepEqual(calls, []);
});

test('⑥ 交易类型是**查表引用文字**时不去读「行为管理」（编码按文字就认得出来）', async () => {
  const gateway = fakeGateway({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付', tradeType: { text: '现货' } })],
    paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100, tradeType: { text: '现货' } })],
    product: PRODUCTS,
  });
  await new PendingPushCandidateService({
    gateway, secondDelivery: secondDeliveryStub(ITEM_INDEX),
  }).listCandidates({ now: NOW });
  assert.equal(gateway.reads.includes('behavior'), false, '文字能认出编码 ⇒ 不多读一张表');
});

// ═════════════════════════════════════════════════════════════════════════════
// ⑦ 配置先行：判据是**行为编码**（不是中文）、且不写死在逻辑里
// ═════════════════════════════════════════════════════════════════════════════

test('⑦ 判据取值来自配置：交易类型是**行为编码**，履约/收款状态沿用既有常量', () => {
  const defaults = resolvePendingPushCandidateConfig({});
  assert.equal(defaults.undeliveredStatus, '未交付');
  assert.equal(defaults.deliveredStatus, '已交付');
  assert.equal(defaults.unpaidPaymentStatus, '未收款');
  assert.equal(defaults.platformPendingPaymentStatus, '待平台结算');
  assert.equal(defaults.prepaidTradeTypeCode, 'SALE_PREPAID');
  assert.equal(defaults.cashTradeTypeCode, 'SALE_CASH');
  // 编码与「行为管理」注册表**同一处**（不新造编码）。
  assert.deepEqual(Object.keys(SALES_MOVEMENTS).sort(), ['SALE_CASH', 'SALE_PREPAID']);
  assert.ok(SALES_MOVEMENTS[defaults.prepaidTradeTypeCode]);
  assert.ok(SALES_MOVEMENTS[defaults.cashTradeTypeCode]);
});

test('⑦ 判据按编码比：把两个编码对调，两块跟着换（逻辑里没有写死）', async () => {
  const seed = {
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付', tradeType: 'bhv_prepaid' })],
    paymentRecord: [
      payment('p_cash', 'o1', { status: '未收款', amount: 10, tradeType: 'bhv_cash' }),
      payment('p_prepaid', 'o1', { status: '未收款', amount: 20, tradeType: 'bhv_prepaid' }),
    ],
    product: PRODUCTS,
  };
  const defaults = await listCandidates(seed);
  assert.deepEqual(defaults.sales.map((row) => row.rowId), ['o1'], '预定那件进【预定】');
  assert.deepEqual(defaults.cash.map((row) => row.rowId), ['o1'], '现货那笔进【现货未收】');

  // 把两个编码对调（模拟"行为表里的编码改了、配置跟着改"）。
  const swapped = resolvePendingPushCandidateConfig({});
  const { sales, cash } = await listCandidates(seed, {
    settings: { ...swapped, prepaidTradeTypeCode: 'SALE_CASH', cashTradeTypeCode: 'SALE_PREPAID' },
  });
  assert.deepEqual(sales, [], '没有 `SALE_CASH` 的明细 ⇒【预定】空');
  assert.deepEqual(cash.map((row) => row.rowId), ['o1'], '`SALE_PREPAID` 那笔未收款改由【现货未收】收');
});

test('⑦ 报货日 / 录入数量：`PurchasePendingBatchService` 只多带字段，不改候选判据', async () => {
  const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
  const service = new PurchasePendingBatchService({
    gateway: fakeGateway({
      purchaseOrderBatch: [
        batch('b1', 'CGD-1', '未到货', { 报货日: atShanghai('2026-10-05'), 录入数量: 12 }),
        batch('b2', 'CGD-2', '已到货', { 报货日: atShanghai('2026-10-05'), 录入数量: 3 }),
        batch('b3', 'CGD-3', '未到货'),
      ],
    }),
  });
  const pending = await service.listPendingBatches();
  assert.deepEqual(pending.map((row) => row.batchNo), ['CGD-1', 'CGD-3']);
  assert.equal(pending[0].quantity, '12');
  assert.equal(pending[0].reportedAt, atShanghai('2026-10-05'));
  // 读不到就是空（渲染层给占位），**不是**跳过这一批。
  assert.equal(pending[1].reportedAt, '');
  assert.equal(pending[1].quantity, '');
});

test('⑦ 报货日 → 上海自然日：跨 UTC 日界的那个凌晨仍算**当天**', () => {
  const service = new PendingPushCandidateService({ gateway: fakeGateway({}) });
  // 北京 2026-10-05 00:30 = UTC 2026-10-04 16:30（用服务器本地时区算会变成 10-04）。
  assert.equal(service.formatReportedAt(Date.parse('2026-10-05T00:30:00+08:00')), '2026-10-05');
  assert.equal(service.formatReportedAt(''), '', '读不到 ⇒ 空串（渲染层给占位）');
  assert.equal(service.formatReportedAt(undefined), '');
});
