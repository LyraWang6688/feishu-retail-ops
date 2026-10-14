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

// ⚠️ 2026-10-14 夹具整体**后移 14 天**（本文件所有"日期世界"一起移，相对关系一字不变）：
//   改前逐字：`const NOW = new Date('2026-10-08T02:00:00.000Z');`
//   改后逐字：`const NOW = new Date('2026-10-22T02:00:00.000Z');`
//   依据：她 2026-10-14 逐字「**数据从 20261015 开始**」＋「**存量行不用管，就看增量**」
//     ⇒ 判据已接进候选取数（`withinLookupWindowSince` = 既有 7 天窗口 && `isOnOrAfterSince`），
//       原来那些 10-01 ~ 10-08 的夹具**全部落在起点之前**、被**正确**过滤掉 ⇒
//       **把夹具日期移到 2026-10-15 之后**（不是改判据、不是 skip）。
//   ⭐ 为什么整体移 14 天：让「窗口外」那一条（`outOfWindow`，见下）也落在 10-15 **当天**，
//     这样它被排除的**唯一**理由仍是"7 天窗口" ✓（判别据没被新起点顶掉）、而窗口内那条 = 10-16。
const NOW = new Date('2026-10-22T02:00:00.000Z'); // 北京 10:00
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
// ⚠️ 2026-10-14：默认销售日也跟着整体后移 14 天（改前逐字 `atShanghai('2026-10-06')`）。
const detail = (recordId, entryId, productId, {
  status = '未交付', amount = 128, soldAt = null, size = 'sz_37', tradeType = 'bhv_prepaid',
} = {}) => ({
  record_id: recordId,
  fields: {
    销售单号: [entryId], 编号: [productId], 尺码: size ? [size] : [],
    履约状态: status, 实收金额: amount,
    销售日: soldAt === null ? atShanghai('2026-10-20') : soldAt,
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
    创建时间: createdAt === null ? atShanghai('2026-10-20') : createdAt,
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

test('①【预定】一单两条未收款 ⇒ 只出一行；金额 = **现算待收**（不是未收款行合计）', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付', amount: 200 })],
    paymentRecord: [
      payment('p1', 'o1', { status: '未收款', amount: 60 }),
      payment('p2', 'o1', { status: '未收款', amount: 40 }),
      // 已收款 / 待平台结算 = **已经算进来的钱**（现算待收要把它们扣掉）。
      payment('p3', 'o1', { status: '已收款', amount: 20 }),
      payment('p4', 'o1', { status: '待平台结算', amount: 30 }),
    ],
    product: PRODUCTS,
  });
  assert.equal(sales.length, 1);
  // ⚠️ 2026-10-11 晚**改写**：改前金额 = 「该单未收款行合计」= 60 + 40 = **100**；
  //    改后 = **现算待收** = Σ实收 200 − 已收 20 − 待平台结算 30 = **150**。
  //    理由：「未付」档不再自动写那条【未收款】⇒ 拿行合计当金额会算成 0 / 偏小。
  assert.equal(sales[0].pendingAmount, 150, '现算待收 150（不是未收款行合计 100）');
});

test('①【预定】金额**逐单**算：别的单的收款不冲抵这一单的待收', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1'), entry('o2')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '未交付', amount: 128 }),
      detail('d2', 'o2', 'prod_b', { status: '未交付', amount: 500 }),
    ],
    paymentRecord: [
      payment('p_o2', 'o2', { status: '未收款', amount: 300 }),
      payment('p_o2_paid', 'o2', { status: '已收款', amount: 200 }),
    ],
    product: PRODUCTS,
  });
  assert.deepEqual(sales.map((row) => [row.salesEntryRecordId, row.pendingAmount]), [
    // ⚠️ 2026-10-11 晚改写：o1 一分未收、连收款明细都没有 ⇒ 现算待收 = 实收 128
    //    （**改前是 0** ⇒ 渲染层会给这一行写「已付清」，那是错的）。
    ['o1', 128],
    // o2：实收 500 − 已收 200 = 300（o1 的收款绝不会被拿来冲 o2）
    ['o2', 300],
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// ② 【现货未收】：收款明细里「交易类型 = 现货」且「收款状态 = 未收款」，**一张销售单一行**
// ═════════════════════════════════════════════════════════════════════════════

test('②【现货未收】一单多笔未收款 ⇒ **只出一行**（金额 = 现算待收）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付', amount: 200.5 })],
    paymentRecord: [
      payment('p1', 'o1', { status: '未收款', amount: 120.5, tradeType: 'bhv_cash' }),
      payment('p2', 'o1', { status: '未收款', amount: 80, tradeType: 'bhv_cash' }),
    ],
    product: PRODUCTS,
  });
  assert.equal(cash.length, 1, '⭐ 同一单多笔未收款也只有一个销售单号 ⇒ 一行');
  assert.equal(cash[0].rowId, 'o1');
  assert.equal(cash[0].criterion, 'delivered_unpaid');
  // ⚠️ 2026-10-11 晚改写：判据从"收款行里有一条未收款"改成"**明细里有现货件 且 还没收清**"，
  //    金额从"未收款行合计"改成"现算待收"（这里两者恰好都是 200.5 —— 数据自洽时应当相等）。
  assert.equal(cash[0].pendingAmount, 200.5, '现算待收 = Σ实收 200.5 − 已收 0');
});

test('②【现货未收】按**明细的**行为编码筛：预定件不进，并留一条 detail_skipped', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      // 两件都**已交付** ⇒ 都不属于【预定】；只有**现货**那一件让这一单进【现货未收】。
      salesDetail: [
        detail('d_cash', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付', amount: 300 }),
        detail('d_prepaid', 'o1', 'prod_b', { tradeType: 'bhv_prepaid', status: '已交付', amount: 0 }),
      ],
      paymentRecord: [
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
  // ⚠️ 2026-10-11 晚改写：判据从"**收款明细**里有一条未收款（交易类型=现货）"改成
  //    "**明细**里有现货件 且 该单还没收清" ⇒ 金额 = 现算待收（300 − 已收 10 − 待结算 20 = 270）。
  assert.equal(result.cash[0].pendingAmount, 270, '300 − 10 − 20 = 270');
  const skipped = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.detail_skipped');
  assert.ok(skipped, '被判据排除的那**件**要留一条 info');
  assert.equal(skipped.detail_record_id, 'd_prepaid');
  assert.equal(skipped.reason, 'trade_type_not_cash');
  assert.deepEqual(skipped.trade_type_codes, ['SALE_PREPAID']);
});

test('②【现货未收】文字 = **该单的明细**（多件并列在同一行）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付', amount: 100, size: 'sz_37' }),
      detail('d2', 'o1', 'prod_b', { tradeType: 'bhv_cash', status: '已交付', amount: 200, size: 'sz_43' }),
    ],
    // ⚠️ 2026-10-11 晚起判据看**明细**（不再看收款行）⇒ 这里连一条收款明细都不需要。
    paymentRecord: [],
    product: PRODUCTS,
  });
  assert.equal(cash.length, 1);
  assert.deepEqual(itemsOf(cash[0]), ['B26002-52 黑色 37', '6A637-7 白色 43']);
});

test('②【现货未收】**明细**的「交易类型」是查表引用（格里是文字）也认得出编码', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { tradeType: { text: '现货' }, status: '已交付', amount: 100 }),
      detail('d2', 'o1', 'prod_b', { tradeType: { text: '预定' }, status: '已交付', amount: 30 }),
    ],
    paymentRecord: [],
    product: PRODUCTS,
  });
  assert.deepEqual(cash.map((row) => row.rowId), ['o1'], '查表引用形状照进【现货未收】');
  assert.equal(cash[0].pendingAmount, 130, '现算待收 = 100 + 30（两件都没收钱）');
});

test('② 判据读得到但**按文字认不出编码** ⇒ 进候选 + 记 warn（宁可不丢单）', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      // 真表上出现一个**没见过的**说法（换过名字 / 新加的行为）⇒ 编码认不出来。
      salesDetail: [detail('d1', 'o1', 'prod_a', {
        status: '已交付', amount: 66, tradeType: { text: '门市' },
      })],
      paymentRecord: [],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.cash.map((row) => row.rowId), ['o1'], '认不出编码 ⇒ 照进（不静默丢单）');
  assert.equal(result.cash[0].pendingAmount, 66);
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
        // ⚠️ 2026-10-14：报货日从 `2026-10-05` 移到 `2026-10-19`（+14 天，其余一字不变）——
        //   依据：她 2026-10-14 夜追加的裁决「**采购「未到货」那半也按 2026-10-15 切**」
        //   ⇒ 判据已接进本 service 的采购半（`keepPurchaseBatchSince`），
        //     10-05 那种夹具**落在起点之前**、被**正确**过滤 ⇒ **把夹具日期移到起点之后**
        //     （不是改判据、不是 skip）。
        reportedAt: atShanghai('2026-10-19'),
        quantity: '12',
      }];
    },
  };
  const { purchase } = await listCandidates({ salesEntry: [], salesDetail: [], paymentRecord: [] }, { purchasePending });
  assert.deepEqual(calls, ['listPendingBatches']);
  assert.equal(purchase.length, 1);
  assert.equal(purchase[0].suppliers[0], '金猴');
  assert.equal(purchase[0].quantity, '12');
  // 改前逐字：`assert.equal(purchase[0].reportedAt, atShanghai('2026-10-05'));`
  assert.equal(purchase[0].reportedAt, atShanghai('2026-10-19'));
});

// ⭐⭐ 2026-10-14 **夜**（业务负责人**追加**的裁决，覆盖 Lead 先前那条保守口径 ⓑ）：
//   【采购】未到货那半**也**按数据起点「2026-10-15」切。
//   她的原话（转述自王颖对"待裁口径"的答复）：「**采购「未到货」那半也按 2026-10-15 切**」。
//   🔴 **硬边界**：`报货日`**读不到** ⇒ **仍然出**（本文件/那个 service 都写着
//      「读不到 ≠ 不符合判据 ⇒ 照出 + 占位」）—— 否则她会**静默看不到还在等处理的待办**。
test('⭐⭐ 数据起点（采购）：注入 10-14 与 10-15 两批 ⇒ **只有 10-15 被挑出来**', async () => {
  const listWith = async (rows) => (await listCandidates(
    { salesEntry: [], salesDetail: [], paymentRecord: [] },
    { purchasePending: { listPendingBatches: async () => rows } },
  )).purchase;

  const before = await listWith([
    { batchNo: 'CGD-B', recordId: 'b_before', suppliers: [], reportedAt: atShanghai('2026-10-14'), quantity: '1' },
  ]);
  assert.deepEqual(before, [], '10-14（起点之前）= 存量 ⇒ **不挑**');

  const onSince = await listWith([
    { batchNo: 'CGD-S', recordId: 'b_since', suppliers: [], reportedAt: atShanghai('2026-10-15'), quantity: '1' },
  ]);
  assert.deepEqual(onSince.map((batch) => batch.batchNo), ['CGD-S'], '10-15（起点当天，含）⇒ **挑**');

  // 两批同时注入：只留下起点那批（原样保留其余字段 —— 筛选**只**按报货日）。
  const both = await listWith([
    { batchNo: 'CGD-B', recordId: 'b_before', suppliers: ['金猴'], reportedAt: atShanghai('2026-10-14'), quantity: '1' },
    { batchNo: 'CGD-S', recordId: 'b_since', suppliers: ['奥康'], reportedAt: atShanghai('2026-10-15'), quantity: '2' },
  ]);
  assert.deepEqual(both.map((batch) => batch.batchNo), ['CGD-S']);
  assert.deepEqual(both[0].suppliers, ['奥康']);
  assert.equal(both[0].quantity, '2');
});

test('⭐⭐ 数据起点（采购）：**报货日读不到的批次仍然被挑出来**（不许"读不到就切"）', async () => {
  const listWith = async (rows) => (await listCandidates(
    { salesEntry: [], salesDetail: [], paymentRecord: [] },
    { purchasePending: { listPendingBatches: async () => rows } },
  )).purchase;

  // 真表形状：那一格为空 → `PurchasePendingBatchService` 给 `''`；没映射时给 `null` 也可能。
  for (const unreadable of ['', null, undefined]) {
    const kept = await listWith([
      { batchNo: 'CGD-X', recordId: 'b_x', suppliers: ['金猴'], reportedAt: unreadable, quantity: '' },
    ]);
    assert.deepEqual(kept.map((batch) => batch.batchNo), ['CGD-X'],
      `报货日 = ${JSON.stringify(unreadable)}（读不到）⇒ **照出**：那是"还在等他处理的待办"，不许静默丢`);
  }

  // 同一次里既有"读不到"又有"存量" ⇒ 读不到的留下、存量的切掉。
  const mixed = await listWith([
    { batchNo: 'CGD-NO-DATE', recordId: 'b_1', suppliers: [], reportedAt: '', quantity: '' },
    { batchNo: 'CGD-STALE', recordId: 'b_2', suppliers: [], reportedAt: atShanghai('2026-10-01'), quantity: '' },
    { batchNo: 'CGD-SINCE', recordId: 'b_3', suppliers: [], reportedAt: atShanghai('2026-10-15'), quantity: '' },
  ]);
  assert.deepEqual(mixed.map((batch) => batch.batchNo), ['CGD-NO-DATE', 'CGD-SINCE']);
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
  // ⚠️ 2026-10-14：两个夹具各后移 14 天（改前逐字 `atShanghai('2026-10-02')` / `atShanghai('2026-10-01')`）
  // —— `NOW` 也在同一天后移了 14 天，所以「第 7 天 / 第 8 天」这层关系**一个字没变**；
  // 而且窗口外那条（10-15）**恰好是数据起点当天**（`isOnOrAfterSince` = true）
  // ⇒ 它被排除的**唯一**理由仍是"7 天窗口" ✓（判别据没有被新起点顶掉）。
  const inWindow = atShanghai('2026-10-16'); // 10-22 往前数第 7 个自然日（含今天）
  const outOfWindow = atShanghai('2026-10-15');
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

test('④【现货未收】按**销售明细的销售日**判 7 天窗口（与【预定】同一列）', async () => {
  // ⚠️ 2026-10-11 晚**改写**：这一块原来看"**收款明细**的创建时间"判窗口；
  //    可"未付"档已经不再自动写那条【未收款】⇒ **没有收款行可看** ⇒ 改成与【预定】
  //    一样按**销售明细的销售日**判（同一张表、同一列，口径统一）。
  const { cash } = await listCandidates({
    salesEntry: [entry('o1'), entry('o2')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', {
        tradeType: 'bhv_cash', status: '已交付', amount: 10, soldAt: atShanghai('2026-10-16'),
      }),
      detail('d2', 'o2', 'prod_b', {
        tradeType: 'bhv_cash', status: '已交付', amount: 20, soldAt: atShanghai('2026-10-15'),
      }),
    ],
    paymentRecord: [],
    product: PRODUCTS,
  });
  assert.deepEqual(cash.map((row) => row.rowId), ['o1'], '第 7 天在、第 8 天不在（销售日判窗口）');
});

// ⭐⭐ 2026-10-14 她的数据口径：「**数据从 20261015 开始**」＋「**存量行不用管，就看增量**」
//   判据 = 既有的 7 天窗口 **且** `config/dataSince` 的 `isOnOrAfterSince`（合成在
//   `PendingPushCandidateService.withinLookupWindowSince` 一处）。
//   ⭐ 本用例就是那句话的验收判据：**注入 10-14 与 10-15 两行 ⇒ 只有 10-15 被挑出来**。
test('⭐⭐ 数据起点：注入 10-14 与 10-15 两行 ⇒ **只有 10-15 被挑出来**（两块共用同一处判据）', async () => {
  // "今天"取 10-20：它既在起点之后、又让 10-15 落在 7 天窗口内 ⇒ 差异**只**来自数据起点。
  const DAY = new Date(atShanghai('2026-10-20'));
  const run = (soldAt, over = {}) => new PendingPushCandidateService({
    gateway: fakeGateway({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { soldAt, ...over })],
      paymentRecord: [],
      product: PRODUCTS,
    }),
    secondDelivery: secondDeliveryStub(ITEM_INDEX),
  }).listCandidates({ now: DAY });

  // ── 【预定】（判据读「销售明细.销售日」）──
  const reserving = await run(atShanghai('2026-10-14'));
  assert.deepEqual(reserving.sales, [], '10-14（起点之前）= 存量 ⇒ **不挑**');
  const onSince = await run(atShanghai('2026-10-15'));
  assert.deepEqual(onSince.sales.map((row) => row.rowId), ['o1'], '10-15（起点当天，含）= **挑出来**');

  // ── 【现货未收】（与【预定】同一列、同一处合成判据）──
  const cashOf = async (soldAt) => (await run(soldAt, {
    tradeType: 'bhv_cash', status: '已交付', amount: 10,
  })).cash.map((row) => row.rowId);
  assert.deepEqual(await cashOf(atShanghai('2026-10-14')), [], '10-14 是存量 ⇒ 不进【现货未收】');
  assert.deepEqual(await cashOf(atShanghai('2026-10-15')), ['o1'], '10-15 起 ⇒ 进【现货未收】');
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

test('⑤【现货未收】**明细**的交易类型那一格没值 ⇒ 照进候选 + 一条 warn（不静默丢单）', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { tradeType: null, status: '已交付', amount: 66 })],
      paymentRecord: [],
      product: PRODUCTS,
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.cash.map((row) => row.rowId), ['o1'], '读不到判据字段 ≠ 不符合判据：照进');
  assert.equal(result.cash[0].pendingAmount, 66);
  const warned = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.trade_type_unreadable');
  assert.ok(warned, '读不到就要留一条 warn');
  assert.deepEqual(warned.detail_record_ids, ['d1']);
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

test('⑤ 金额**算不出来**（收款状态认不出）⇒ 行照出、金额留空（null）+ 一条 warn', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付', amount: 128 })],
      // ⚠️ 2026-10-11 晚**改写**：改前"金额读不出来"指的是"那条未收款行没填金额"；
      //    现在金额走 `progressFromRecords`（现算待收），它遇到**认不出的收款状态**会当场抛
      //    ⇒ 这一行金额留空（**绝不吞成 0**，也绝不说「已付清」）。
      paymentRecord: [payment('p1', 'o1', { status: '说不清的状态', amount: 10 })],
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
  // ⚠️ 2026-10-11 晚改写：改前这里断言 0（未收款行合计）；现在金额 = 现算待收 = 实收 128。
  assert.equal(result.sales[0].pendingAmount, 128);
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
    salesDetail: [
      // 现货那一件（已交付）+ 预定那一件（**也已交付**）⇒【预定】没有候选。
      detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付', amount: 100 }),
      detail('d2', 'o1', 'prod_b', { tradeType: 'bhv_prepaid', status: '已交付', amount: 0 }),
    ],
    paymentRecord: [],
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

test('⑦ 判据按编码比：把两个编码对调，两块跟着换（逻辑里没有写死）', async () => {
  const seed = {
    salesEntry: [entry('o1')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '未交付', tradeType: 'bhv_prepaid', amount: 30 }),
      detail('d2', 'o1', 'prod_b', { status: '已交付', tradeType: 'bhv_cash', amount: 10 }),
    ],
    paymentRecord: [],
    product: PRODUCTS,
  };
  const defaults = await listCandidates(seed);
  assert.deepEqual(defaults.sales.map((row) => row.rowId), ['o1'], '预定那件进【预定】');
  assert.deepEqual(defaults.cash.map((row) => row.rowId), ['o1'], '现货那件进【现货未收】');

  // 把两个编码对调（模拟"行为表里的编码改了、配置跟着改"）。
  const swapped = resolvePendingPushCandidateConfig({});
  const { sales, cash } = await listCandidates(seed, {
    settings: { ...swapped, prepaidTradeTypeCode: 'SALE_CASH', cashTradeTypeCode: 'SALE_PREPAID' },
  });
  // 对调之后：`SALE_CASH` 那件成了"预定"，但它**已交付** ⇒【预定】空；
  // `SALE_PREPAID` 那件成了"现货"（未交付也算现货件）⇒ 由【现货未收】收。
  assert.deepEqual(sales, [], '按新编码：`SALE_CASH` 那件是"预定"但已交付 ⇒【预定】空');
  assert.deepEqual(cash.map((row) => row.rowId), ['o1'], '`SALE_PREPAID` 那件改由【现货未收】收');
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

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-11 晚（业务负责人真机卡住之后）：**金额口径从「未收款行合计」改成「现算待收」**
//
// 起因（逐字）：2026-10-11 晚扫码建单的「未付」档改成**不再自动写那条【未收款】**，
//   而这两块候选的金额一直取"该单未收款行之和" ⇒ **未付的单会算成 0、在推送里显示成
//   「已付清」**（`pendingDealPushService` 的 `amountValueOf`：0 ⇒ `paidUpText`）。
//   ⚠️ 9 点推送是业务负责人明确要保住的功能（她：「每天 9 点定时推送的卡片还是需要啊！」）
//   ⇒ **不能让推送给她错的信息**。
//
// 改后口径（唯一权威）：
//   · **金额** = `progressFromRecords(...).pendingAmount`（**与工作台订单列表同一个口径**：
//     Σ销售明细「实收金额」− 已收 − 待平台结算）；
//   · 【现货未收】的**判据** = 该单在 7 天窗口内**有现货件**（`SALE_CASH`）**且还有待收**
//     —— 不再看"有没有那条未收款行"；
//   · 实收留空 / 数据脏 ⇒ 金额算不出来 ⇒ **行照出、金额段不渲染**（**绝不说「已付清」**）。
// ═══════════════════════════════════════════════════════════════════════════

test('⭐ 2026-10-11【现货未收】：未付的单（**一条未收款行都没有**）⇒ 照样进提醒，金额 = 现算待收', async () => {
  // 她现场的形状：一条现货明细、实收 128、**收款明细一条都没有**（未付档不再写【未收款】）
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付', amount: 128 })],
    paymentRecord: [],
  });
  assert.equal(cash.length, 1,
    '未付（没有未收款行）的单**必须照样进**【现货未收】—— 改前它算不出未收款合计、这一块直接没有它');
  assert.equal(cash[0].pendingAmount, 128,
    '金额 = 现算待收（Σ实收 128 − 已收 0），**不是**未收款行合计（0 ⇒ 会被渲染成「已付清」）');
});

test('⭐ 2026-10-11【现货未收】：真的收清了（实收 = 已收）⇒ **不进**提醒（也就不会显示"已付清"）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付', amount: 128 })],
    paymentRecord: [payment('p1', 'o1', { status: '已收款', amount: 128, tradeType: 'bhv_cash' })],
  });
  assert.deepEqual(cash, [], '收清了 ⇒ 不进【现货未收】（"已付清"只在 pendingAmount === 0 时才该出现）');
});

test('⭐ 2026-10-11【现货未收】：部分付 ⇒ 金额 = **剩余待收**（不是全款）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付', amount: 300 })],
    paymentRecord: [
      payment('p1', 'o1', { status: '已收款', amount: 200, tradeType: 'bhv_cash' }),
      payment('p2', 'o1', { status: '未收款', amount: 100, tradeType: 'bhv_cash' }),
    ],
  });
  assert.equal(cash.length, 1);
  assert.equal(cash[0].pendingAmount, 100, '待收 = 300 − 200 = 100（剩余那部分）');
});

test('⭐ 2026-10-11【现货未收】：实收**留空**⇒ 行照出、金额**算不出来**（不渲染金额段，绝不说"已付清"）', async () => {
  const detailNoAmount = detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_cash', status: '已交付' });
  detailNoAmount.fields['实收金额'] = '';            // 方案甲：她没填 ⇒ 那一列留空
  const { cash } = await listCandidates({ salesEntry: [entry('o1')], salesDetail: [detailNoAmount], paymentRecord: [] });
  assert.equal(cash.length, 1, '还没填实收的单**更要提醒**（行照出）');
  assert.equal(cash[0].pendingAmount, null, '算不出来 ⇒ `null`（渲染层整段不渲染金额，**不是 0**）');
});

test('⭐ 2026-10-11【预定】：金额改成现算待收 ⇒ 未付（无未收款行）的单显示"还欠 X"，不再算成 0', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_prepaid', status: '未交付', amount: 128 })],
    paymentRecord: [],
  });
  assert.equal(sales.length, 1, '预定 + 未交付 ⇒ 照旧出一行');
  assert.equal(sales[0].pendingAmount, 128,
    '金额 = 现算待收（128），**不是**未收款行合计（0 ⇒ 「已付清」）');
});

test('⭐ 2026-10-11【预定】：部分付 ⇒ 显示**剩余待收**（现算，不是那一条未收款行的金额）', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { tradeType: 'bhv_prepaid', status: '未交付', amount: 500 })],
    paymentRecord: [
      payment('p1', 'o1', { status: '已收款', amount: 300, tradeType: 'bhv_prepaid' }),
      payment('p2', 'o1', { status: '未收款', amount: 200, tradeType: 'bhv_prepaid' }),
    ],
  });
  assert.equal(sales.length, 1);
  assert.equal(sales[0].pendingAmount, 200, '待收 = 500 − 300 = 200');
});
