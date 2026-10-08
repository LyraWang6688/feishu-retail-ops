// 「9 点待处理单推送」三块候选的**取数口径**（验收标准，据 `docs/push-blocks-caliber-2026-10-08.md`）。
//
// 本文件**直接**盯着取数那一处（`PendingPushCandidateService` + `config/pendingPushCandidates`）——
// 渲染（标题 / 两栏 / 卡片标记）不在这里，那一份在 pendingDealPush*.test.js。
//
// 三块的口径（业务负责人 2026-10-08 逐字）：
//   ①【预定】      = 销售明细里 **履约状态 = 未交付** 的明细行（**逐件一行**）；
//                     金额 = **该销售单号的待收款**（走 `progressFromRecords`）。
//   ②【现货待收】  = 收款明细里 **收款状态 = 未收款** 且 **交易类型含「现货」**（一条一行）；
//                     金额 = **那一条收款明细自己的「收款金额」**（不折算、不汇总）。
//   ③【采购】      = 报货批次里 **到货状态 = 未到货**（沿用 `PurchasePendingBatchService`）；
//                     只多带两个字段：**报货日**（飞书自动字段）+ **录入数量**。
//
// 时间窗：**最近 7 天**（上海自然日）；【预定】按**销售明细的销售日**、
// 【现货待收】按**收款明细的创建时间**。
// 缺字段的硬要求：**照推 + 记日志，绝不静默丢单**。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PendingPushCandidateService, REMINDER_WINDOW_DAYS } = require('../src/services/pendingPushCandidateService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { resolvePendingPushCandidateConfig } = require('../src/config/pendingPushCandidates');

const NOW = new Date('2026-10-08T02:00:00.000Z'); // 北京 10:00
const DAY_MS = 24 * 60 * 60 * 1000;
// 一律用**上海自然日**表达（与生产同一套口径：服务器是 UTC）。
const atShanghai = (day) => Date.parse(`${day}T10:00:00+08:00`);

// 假 Base：语义字段名 → 真实字段名映射**与真 schema 一致**（写错字段名会当场露馅）。
const fakeGateway = (seed = {}) => {
  const records = new Map(Object.entries(seed).map(([key, rows]) =>
    [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  return {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records.get(key) || [],
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
  fields: { 销售单号: `XSD-${recordId}`, 资金状态: '已写入', 交易类型: ['b_cash'], ...extra },
});
const detail = (recordId, entryId, productId, { status = '未交付', amount = 128, soldAt = null, size = 'sz_37' } = {}) => ({
  record_id: recordId,
  fields: {
    销售单号: [entryId], 编号: [productId], 尺码: size ? [size] : [],
    履约状态: status, 成交金额: amount, 销售日: soldAt === null ? atShanghai('2026-10-06') : soldAt,
  },
});
const payment = (recordId, entryId, {
  status = '未收款', amount = 128, tradeType = '现货', createdAt = null,
} = {}) => ({
  record_id: recordId,
  fields: {
    关联销售单: [entryId], 收款金额: amount, 收款状态: status,
    交易类型: tradeType === null ? undefined : tradeType,
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

const listCandidates = async (seed, { itemIndex = ITEM_INDEX, purchasePending, settings } = {}) =>
  new PendingPushCandidateService({
    gateway: fakeGateway(seed),
    secondDelivery: secondDeliveryStub(itemIndex),
    purchasePending,
    settings,
  }).listCandidates({ now: NOW });

// ═════════════════════════════════════════════════════════════════════════════
// ① 【预定】：销售明细里 履约状态 = 未交付，**逐件一行**
// ═════════════════════════════════════════════════════════════════════════════

test('①【预定】逐件一行：一单里两件未交付 → 两行（同一单号的金额各带一份）', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '未交付', amount: 128, size: 'sz_37' }),
      detail('d2', 'o1', 'prod_b', { status: '未交付', amount: 228, size: 'sz_43' }),
      // 已交付那一件**不进**【预定】（它是成交/现货那一路的）
      detail('d3', 'o1', 'prod_b', { status: '已交付', amount: 99 }),
    ],
    paymentRecord: [],
    product: [product('prod_a', 'B26002-52', '黑色'), product('prod_b', '6A637-7', '白色')],
  });
  assert.equal(sales.length, 2, '两条未交付明细 → 两行');
  assert.deepEqual(sales.map((row) => row.rowId), ['d1', 'd2']);
  assert.deepEqual(sales.map((row) => row.facts.itemNo), ['B26002-52', '6A637-7']);
  assert.deepEqual(sales.map((row) => row.facts.size), ['37', '43']);
  // 金额 = **该销售单号的待收款** —— 口径是"**这一整单**还欠多少"，走 `progressFromRecords`：
  // 它把**这一单的全部明细**（含已交付那一件的 99）都算进成交额 ⇒ 128 + 228 + 99 = 455。
  // ⚠️ 所以两行**共用同一个数**：那是"这单欠多少"，**不是**"这一件多少钱"。
  //   （她原话：「还需要加上待收的金额（**同一笔销售单号的待收款**）」——就是整单的那个数。）
  assert.deepEqual(sales.map((row) => row.pendingAmount), [455, 455]);
  assert.equal(sales[0].criterion, 'undelivered');
});

test('①【预定】只算这一单：别的单的收款不冲抵这一单的待收（金额口径逐单）', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1'), entry('o2')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '未交付', amount: 100 }),
      detail('d2', 'o2', 'prod_b', { status: '未交付', amount: 200 }),
    ],
    paymentRecord: [
      // 另一张单收到 200：**不许**把它算到 o1 头上。
      payment('p_o2', 'o2', { status: '已收款', amount: 200 }),
    ],
    product: [product('prod_a', 'B26002-52'), product('prod_b', '6A637-7')],
  });
  assert.deepEqual(sales.map((row) => [row.salesEntryRecordId, row.pendingAmount]), [
    ['o1', 100],
    ['o2', 0],
  ]);
  // 「已收清」的那一笔待收为 0 ⇒ 交给渲染层写「已付清」（这一行**照样在**，是她说要的口径）。
  assert.equal(sales[1].pendingAmount, 0);
});

test('①【预定】待收 = 成交额 − 已收 − 待平台结算（`progressFromRecords` 的口径）', async () => {
  const { sales } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付', amount: 500 })],
    paymentRecord: [
      payment('p1', 'o1', { status: '已收款', amount: 200, tradeType: '现货' }),
      payment('p2', 'o1', { status: '待平台结算', amount: 85.4, tradeType: '现货' }),
      payment('p3', 'o1', { status: '未收款', amount: 214.6, tradeType: '现货' }),
    ],
    product: [product('prod_a', 'B26002-52')],
  });
  assert.equal(sales.length, 1);
  assert.equal(sales[0].pendingAmount, 214.6);
});

// ═════════════════════════════════════════════════════════════════════════════
// ② 【现货待收】：收款明细里 未收款 且 交易类型含「现货」，一条一行
// ═════════════════════════════════════════════════════════════════════════════

test('②【现货待收】只收「未收款」+「交易类型含现货」：预定那条 / 已收款那条**都不进**', async () => {
  const { sales, cash } = await listCandidates({
    salesEntry: [entry('o1')],
    // 这一单的明细都**已交付** ⇒ 不属于【预定】（但现货待收那条照样要出）。
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付', amount: 300 })],
    paymentRecord: [
      payment('p_cash', 'o1', { status: '未收款', amount: 300, tradeType: '现货' }),
      payment('p_prepaid', 'o1', { status: '未收款', amount: 50, tradeType: '预定' }),
      payment('p_paid', 'o1', { status: '已收款', amount: 10, tradeType: '现货' }),
      payment('p_settle', 'o1', { status: '待平台结算', amount: 20, tradeType: '现货' }),
    ],
    product: [product('prod_a', 'B26002-52')],
  });
  assert.deepEqual(cash.map((row) => row.rowId), ['p_cash']);
  assert.deepEqual(sales, [], '三件都已交付 ⇒【预定】为空');
  assert.equal(cash[0].criterion, 'delivered_unpaid');
});

test('②【现货待收】金额 = **那一条收款明细自己的「收款金额」**（不折算、不汇总）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付', amount: 900 })],
    paymentRecord: [
      payment('p1', 'o1', { status: '未收款', amount: 120.5, tradeType: '现货' }),
      payment('p2', 'o1', { status: '未收款', amount: 80, tradeType: '现货' }),
    ],
    product: [product('prod_a', 'B26002-52')],
  });
  // 两条各一行、各拿自己的数（不是 200.5 / 也不是差额）。
  assert.deepEqual(cash.map((row) => row.pendingAmount), [120.5, 80]);
});

test('②【现货待收】文字里的货号/颜色/尺码取**它关联销售单下的明细**（多件并列）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [
      detail('d1', 'o1', 'prod_a', { status: '已交付', size: 'sz_37' }),
      detail('d2', 'o1', 'prod_b', { status: '已交付', size: 'sz_43' }),
    ],
    paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 300, tradeType: '现货' })],
    product: [product('prod_a', 'B26002-52', '黑色'), product('prod_b', '6A637-7', '白色')],
  });
  assert.equal(cash.length, 1);
  assert.deepEqual(cash[0].facts.map((item) => `${item.itemNo} ${item.color} ${item.size}`),
    ['B26002-52 黑色 37', '6A637-7 白色 43']);
});

test('②「含现货」是**包含**匹配：一格写着「现货,预定」也进候选', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
    paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100, tradeType: '预定,现货' })],
    product: [product('prod_a', 'B26002-52')],
  });
  assert.deepEqual(cash.map((row) => row.rowId), ['p1']);
});

test('② 交易类型**读得到但不含现货** ⇒ 真的不进候选，并记一条可对账的 info', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100, tradeType: '预定' })],
      product: [product('prod_a', 'B26002-52')],
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.cash, []);
  const skipped = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.payment_skipped');
  assert.ok(skipped, '被判据排除的那条要留一条 info');
  assert.equal(skipped.payment_record_id, 'p1');
  assert.equal(skipped.reason, 'trade_type_not_cash');
  assert.equal(skipped.trade_type, '预定');
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
      product: [product('prod_a', 'B26002-52')],
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
    product: [product('prod_a', 'B26002-52'), product('prod_b', '6A637-7')],
  });
  assert.deepEqual(sales.map((row) => row.salesEntryRecordId), ['o1']);
});

test('④【现货待收】按**收款明细的创建时间**判 7 天窗口（不是销售日）', async () => {
  const { cash } = await listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付', soldAt: atShanghai('2026-09-01') })],
    paymentRecord: [
      payment('p_in', 'o1', { status: '未收款', amount: 10, tradeType: '现货', createdAt: atShanghai('2026-10-03') }),
      payment('p_out', 'o1', { status: '未收款', amount: 20, tradeType: '现货', createdAt: atShanghai('2026-09-30') }),
    ],
    product: [product('prod_a', 'B26002-52')],
  });
  // 销售日是 09-01（早就出了 7 天窗）但收款创建时间在窗内 ⇒ **照进**。
  assert.deepEqual(cash.map((row) => row.rowId), ['p_in']);
});

// ═════════════════════════════════════════════════════════════════════════════
// ⑤ 缺字段：**照推 + 记日志，绝不静默丢单**（她的硬要求）
// ═════════════════════════════════════════════════════════════════════════════

test('⑤ 交易类型**读不到**（列没值）⇒ 未收款那条**照进候选** + 一条 warn（不静默丢单）', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
      // `交易类型: undefined` = 这一格没有值（真表上关联悬空 / 没填就是这种形状）。
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 66, tradeType: null })],
      product: [product('prod_a', 'B26002-52')],
    });
  } finally {
    logs.restore();
  }
  assert.deepEqual(result.cash.map((row) => row.rowId), ['p1'], '读不到判据字段 ≠ 不符合判据：照进');
  assert.equal(result.cash[0].pendingAmount, 66);
  const warned = logs.events().find((log) => log.event === 'sales.pending_deal_push.candidate.trade_type_unreadable');
  assert.ok(warned, '读不到就要留一条 warn');
  assert.deepEqual(warned.payment_record_ids, ['p1']);
  assert.equal(warned.trade_type_field, '交易类型');
});

test('⑤ 金额算不出来（数据不自洽）⇒ 行**照出**、金额留空（null）+ 一条 warn', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      salesDetail: [detail('d1', 'o1', 'prod_a', { status: '未交付', amount: 100 })],
      // 收款比成交多 ⇒ `progressFromRecords` 抛「累计收款…超过成交金额」。
      paymentRecord: [payment('p1', 'o1', { status: '已收款', amount: 999, tradeType: '现货' })],
      product: [product('prod_a', 'B26002-52')],
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

test('⑤ 货号取不到 ⇒ 那一行仍然产出（`facts` 为 null，渲染层给占位）+ 一条汇总 warn', async () => {
  const logs = captureLogs();
  let result;
  try {
    result = await listCandidates({
      salesEntry: [entry('o1')],
      // 明细指向一条**在货品表里不存在**的编号 ⇒ 取不到货号。
      salesDetail: [detail('d1', 'o1', 'prod_missing', { status: '未交付' })],
      paymentRecord: [],
      product: [product('prod_a', 'B26002-52')],
    });
  } finally {
    logs.restore();
  }
  assert.equal(result.sales.length, 1, '取不到货号也不许把这一行丢掉');
  assert.equal(result.sales[0].facts, null);
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
      product: [product('prod_a', 'B26002-52')],
    }, {
      itemIndex: null,
    });
  } finally {
    logs.restore();
  }
  // `loadItemIndex` 返回 null ⇒ 事实全取不到，但**行照出**。
  assert.equal(result.sales.length, 1);
  assert.equal(result.sales[0].facts, null);
  assert.ok(logs.events().some((log) => log.event === 'sales.pending_deal_push.candidate.items_incomplete'));
});

// ═════════════════════════════════════════════════════════════════════════════
// ⑥ 两块的边界：售后件不进、未入账不进、空就是空
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
      paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100, tradeType: '现货' })],
      product: [product('prod_a', 'B26002-52'), product('prod_b', '6A637-7')],
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
    paymentRecord: [payment('p1', 'o1', { status: '未收款', amount: 100, tradeType: '现货' })],
    product: [product('prod_a', 'B26002-52')],
  });
  assert.deepEqual(sales, []);
  assert.deepEqual(cash, []);
});

test('⑥ 三块都没有候选 ⇒ 三块都是空（不报错、也不编行）', async () => {
  const result = await listCandidates({ salesEntry: [], salesDetail: [], paymentRecord: [] });
  assert.deepEqual(result, { sales: [], cash: [], purchase: [] });
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

// ═════════════════════════════════════════════════════════════════════════════
// ⑦ 配置先行：判据取值可配、且不写死在逻辑里
// ═════════════════════════════════════════════════════════════════════════════

test('⑦ 判据取值来自配置（可换），service 里没有第二份中文字面量', () => {
  const defaults = resolvePendingPushCandidateConfig({});
  assert.equal(defaults.undeliveredStatus, '未交付');
  assert.equal(defaults.unpaidPaymentStatus, '未收款');
  assert.equal(defaults.platformPendingPaymentStatus, '待平台结算');
  assert.equal(defaults.cashTradeTypeKeyword, '现货');
  // 环境变量能换关键词（她哪天要把「现货」换个说法，不用改代码）。
  assert.equal(resolvePendingPushCandidateConfig({ PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD: '门市' })
    .cashTradeTypeKeyword, '门市');
  // ⚠️ 显式空串 ⇒ **用默认值**（这一项是"叫什么名字"的取值，不是开关）——
  //    写死空串会让判据永远不匹配、整块**静默变空**，那正是最难查的那类事故。
  assert.equal(resolvePendingPushCandidateConfig({ PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD: '' })
    .cashTradeTypeKeyword, '现货');

  // 换成「门市」之后，判据跟着换（逻辑里没有写死「现货」）。
  return listCandidates({
    salesEntry: [entry('o1')],
    salesDetail: [detail('d1', 'o1', 'prod_a', { status: '已交付' })],
    paymentRecord: [
      payment('p_cash', 'o1', { status: '未收款', amount: 1, tradeType: '现货' }),
      payment('p_shop', 'o1', { status: '未收款', amount: 2, tradeType: '门市' }),
    ],
    product: [product('prod_a', 'B26002-52')],
  }, { settings: resolvePendingPushCandidateConfig({ PENDING_PUSH_CASH_TRADE_TYPE_KEYWORD: '门市' }) })
    .then(({ cash }) => assert.deepEqual(cash.map((row) => row.rowId), ['p_shop']));
});

test('⑦ 报货日 / 录入数量：`PurchasePendingBatchService` 只多带字段，不改候选判据', async () => {
  const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
  const settings = resolvePendingPushCandidateConfig({});
  const service = new PurchasePendingBatchService({
    gateway: fakeGateway({
      purchaseOrderBatch: [
        batch('b1', 'CGD-1', '未到货', { 报货日: atShanghai('2026-10-05'), 录入数量: 12 }),
        batch('b2', 'CGD-2', '已到货', { 报货日: atShanghai('2026-10-05'), 录入数量: 3 }),
        batch('b3', 'CGD-3', '未到货'),
      ],
      purchaseReport: [],
    }),
  });
  const pending = await service.listPendingBatches();
  assert.deepEqual(pending.map((row) => row.batchNo), ['CGD-1', 'CGD-3']);
  assert.equal(pending[0].quantity, '12');
  assert.equal(pending[0].reportedAt, atShanghai('2026-10-05'));
  // 读不到就是空（渲染层给占位），**不是**跳过这一批。
  assert.equal(pending[1].reportedAt, '');
  assert.equal(pending[1].quantity, '');
  assert.equal(settings.undeliveredStatus, '未交付');
});

test('⑦ 报货日 → 上海自然日：跨 UTC 日界的那个凌晨仍算**当天**', () => {
  const { PendingPushCandidateService: Service } = require('../src/services/pendingPushCandidateService');
  // 北京 2026-10-05 00:30 = UTC 2026-10-04 16:30（用服务器本地时区算会变成 10-04）。
  const service = new Service({ gateway: fakeGateway({}) });
  assert.equal(service.formatReportedAt(Date.parse('2026-10-05T00:30:00+08:00')), '2026-10-05');
  assert.equal(service.formatReportedAt(''), '', '读不到 ⇒ 空串（渲染层给占位）');
  assert.equal(service.formatReportedAt(undefined), '');
});
