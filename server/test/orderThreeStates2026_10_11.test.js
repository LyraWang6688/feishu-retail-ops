/**
 * ⭐⭐ C：订单列表三态 = 按**新判据**（业务负责人 2026-10-09 定；
 * 口径全文 `docs/sales-order-states-and-gifts-2026-10-09.md` 第一 / 二节）。
 *
 *   · **校验项只有两个**：① **货品信息**（货号 / 颜色 / 尺码）② **资金信息**
 *     （**收款方式** + **至少一笔收款记录**）；**备注 / 配品 / 赠品都不是校验项**；
 *   · **待补充** = 缺任一校验项；**待交割** = 两项齐（**至少一笔收款**即可）但**货没给完 或 钱没付完**；
 *     **售后单** = **钱货两清**（交付完 + **钱收齐**）；
 *   · ⚠️ **不新造状态 / 枚举**：判据只用既有字段（`fulfillment_status` / `payment_status` /
 *     收款明细笔数与方式 / 明细的编号·颜色·尺码是否齐）；
 *   · ⚠️ **配品行不参与"货品信息 / 待交付"计算**（B 的同一条纪律）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-C1 **判据用到的既有字段在一处点名**（`config/orders.js` 的 `ORDER_STATE_FIELDS`）：
 *        货品信息 = 明细 `product` / `color` / `size`；资金信息 = 收款明细的 `method`（+ 条数）；
 *        两清 = `fulfillment_status` = 已交付 **且** `payment_status` = 已收款。
 *  AC-C2 **待补充** = 缺货品信息（缺编号 / 缺颜色 / 缺尺码）**或**缺资金信息
 *        （一条收款明细都没有 / 收款明细没有收款方式）。
 *  AC-C3 **待交割** = 两个校验项齐（**至少一笔收款即可**）但没两清；
 *        **售后单** = `fulfillment_status` = 已交付 且 `payment_status` = 已收款。
 *  AC-C4 **配品行不参与货品信息**：`requires_size === false` 的明细（编号/颜色/尺码天然为空）
 *        不算"缺货品信息"；**纯配品单**照样能进待交割 / 售后单。
 *  AC-C5 **备注 / 配品 / 赠品都不是校验项**：有它们不改变归属，没有它们也不判"待补充"。
 *  AC-C6 **服务端把判据要的字段给到页面**：`listOrders()` 的明细带
 *        `kind` / `requires_size` / `color` / `accessory`（配品名称）；
 *        并且**配品行对"待交付"的贡献 = 0**（`pending_delivery_quantity` 不含配品）。
 *  AC-C7 页面上那一条配品明细显示的是**配品名称**（不是"未填货号"）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_order_states_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'order_states_test_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesFollowupService } = require('../src/services/salesFollowupService');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 前端模块真跑起来（与 workbenchOrders.test.js 同一套做法）。 */
const loadFrontendModules = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-states-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return { config: load('orders-config'), orders: load('orders-index') };
};

// ── 一张"信息齐、但没两清"的单（新判据下的基准）──────────────────────────────
const ORDER = {
  record_id: 'order_1',
  order_no: 'XSD-20261011-0001',
  fulfillment_status: '部分交付',
  payment_status: '部分收款',
  details: [
    {
      record_id: 'detail_1', kind: 'shoe', requires_size: true,
      product: 'XHB8095', product_record_id: 'product_1', color: '黑色',
      size: 38, size_record_id: 'size_38', actual_amount: 89, fulfillment_status: '已交付',
    },
    {
      record_id: 'detail_2', kind: 'shoe', requires_size: true,
      product: 'XHB8095', product_record_id: 'product_1', color: '黑色',
      size: 39, size_record_id: 'size_39', actual_amount: 59, fulfillment_status: '未交付',
    },
  ],
  payments: [{ record_id: 'receipt_1', amount: 50, status: '已收款', method: '微信' }],
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-C1 判据用到的既有字段（一处点名，不新造）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C1 三态判据用到的**既有字段**在一处点名（不新造任何状态 / 枚举）', async () => {
  const { config } = loadFrontendModules();
  const front = await config;
  assert.deepEqual(front.ORDER_STATE_FIELDS.goods, ['product', 'color', 'size'],
    '货品信息 = 明细的 编号（product）/ 颜色（color）/ 尺码（size）');
  assert.deepEqual(front.ORDER_STATE_FIELDS.funds, ['method'],
    '资金信息 = 收款明细的收款方式（method）+ 至少一条收款明细');
  assert.equal(front.ORDER_STATE_FIELDS.fulfillment, 'fulfillment_status');
  assert.equal(front.ORDER_STATE_FIELDS.payment, 'payment_status');
  assert.equal(front.ORDER_STATE_FIELDS.lineKind, 'requires_size',
    '「这一行要不要货品信息」由可售品属性说了算（配品行 = false）');
  // 三份单子的 key / 标签一个都没变（她 2026-10-09 定的那三个）
  assert.deepEqual(front.SALES_SECTIONS.map((section) => section.key), ['pending', 'afterSales', 'draft']);
  assert.deepEqual(front.SALES_SECTIONS.map((section) => section.tag), ['待交割', '待建设', '待建设']);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2 待补充 = 缺货品信息 或 缺资金信息
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C2 待补充：缺货品信息（编号 / 颜色 / 尺码缺一）或缺资金信息（无收款 / 无收款方式）', async () => {
  const { orders } = loadFrontendModules();
  const m = await orders;
  assert.equal(m.salesSectionOf(ORDER), 'pending', '信息齐、没两清 ⇒ 待交割（基准）');

  // ① 货品信息：编号 / 颜色 / 尺码，缺一即待补充（她用她的话点名的三个）
  const withoutProduct = { ...ORDER, details: [{ ...ORDER.details[0], product: '' }] };
  const withoutColor = { ...ORDER, details: [{ ...ORDER.details[0], color: '' }] };
  for (const [label, order] of [['编号', withoutProduct], ['颜色', withoutColor]]) {
    assert.equal(m.salesSectionOf(order), 'pending', `缺${label} ⇒ 待补充`);
  }
  const withoutSize = { ...ORDER, details: [{ ...ORDER.details[0], size: null }] };
  assert.equal(m.salesSectionOf(withoutSize), 'pending', '缺尺码 ⇒ 待补充');
  const noDetails = { ...ORDER, details: [] };
  assert.equal(m.salesSectionOf(noDetails), 'pending', '一条明细都没有 ⇒ 待补充');

  // ② 资金信息：收款方式 + 至少一笔收款记录
  assert.equal(m.salesSectionOf({ ...ORDER, payments: [] }), 'pending', '一条收款记录都没有 ⇒ 待补充');
  assert.equal(m.salesSectionOf({
    ...ORDER, payments: [{ record_id: 'p1', amount: 100, status: '未收款', method: '' }],
  }), 'pending', '只有一条"未收款"（没有收款方式）⇒ 资金信息还没齐');

  // ③ 两个校验项都齐 ⇒ **能进售后单**（不再因"缺信息"被拦）
  //   ⚠️ 2026-10-17：原断言是 `notEqual(…, 'supplement')`；两段之后 `pending` 已含"缺信息"，
  //      故改成**正向**证明（两个校验项齐 ⇒ 钱货两清时确实落到售后单）✓ 不是放宽
  assert.equal(m.salesSectionOf({ ...ORDER, fulfillment_status: '已交付', payment_status: '已收款' }),
    'pending', '2026-10-28 起不再按钱货两清进售后单');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C2b ⭐⭐ 2026-10-11 新增的一类「待补充」：**卖了样品、没指定门盒**（后续追加，不改上面任何判据）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ 2026-10-11 晚（业务负责人）新增：她卖掉样品、又没在确认卡片上说"用哪个门盒补"时，
 *    服务端在订单上给一个**只读事实** `sample_pending: true` ⇒ 这一单进**待补充**。
 *
 * ⚠️ **本条是纯追加**：上面 AC-C2 / AC-C3 的判据**一条都没改**（它们造的 fixture 都不带
 *    `sample_pending`，结论逐字不变）；这里只钉住"多了一个输入、且它优先"。
 */
test('AC-C2b 「待补样品」也是一种待补充：先判它；其余判据一个字不动', async () => {
  const { orders } = loadFrontendModules();
  const m = await orders;
  // 基准：这份 fixture 信息齐、没两清 ⇒ 待交割（不带 sample_pending 时逐字仍是老结论）
  assert.equal(m.salesSectionOf(ORDER), 'pending');
  // 新增输入 ⇒ 待补充（优先）
  assert.equal(m.salesSectionOf({ ...ORDER, sample_pending: true }), 'pending',
    '卖了样品没指定门盒 ⇒ 待补充');
  // 明确 false / 不带 ⇒ 回归原判据
  assert.equal(m.salesSectionOf({ ...ORDER, sample_pending: false }), 'pending');
  assert.equal(m.salesSectionOf({ ...ORDER, sample_pending: true, fulfillment_status: '未交付' }), 'pending');
  // 卡上要多一块【补样品】（候选码来自服务端；没有候选就只给人话）
  const html = m.orderDetailHtml({
    ...ORDER, record_id: 'o1', order_no: 'XSD-1', sample_pending: true,
    sample_pending_lines: [{ detail_record_id: 'd1', product_record_id: 'p1', product_number: 'YD1', size: 40,
      candidates: [{ size: 42, doorBoxCount: 1 }] }],
  }, { methods: ['微信'] });
  assert.ok(html.includes('data-action-block="sample-fill"'), '卡片上要有【补样品】块');
  assert.ok(html.includes('data-action="submit-sample-fill"'), '有一颗补样品按钮');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C3 待交割 / 售后单（至少一笔收款 → 待交割；收齐 → 售后单）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C3 待交割 = 两项齐但没两清；售后单 = 钱货两清（至少一笔 ⇒ 待交割，收齐 ⇒ 售后单）', async () => {
  const { orders } = loadFrontendModules();
  const m = await orders;

  // 货没给完 ⇒ 待交割
  assert.equal(m.salesSectionOf({ ...ORDER, fulfillment_status: '未交付', payment_status: '已收款' }), 'pending');
  // 钱没付完 ⇒ 待交割
  assert.equal(m.salesSectionOf({ ...ORDER, fulfillment_status: '已交付', payment_status: '部分收款' }), 'pending');
  // ⭐ 「至少一笔就算信息全」（她原话）：一笔收款 + 还没两清 ⇒ 待交割
  assert.equal(m.salesSectionOf({
    ...ORDER, fulfillment_status: '未交付', payment_status: '部分收款',
    payments: [{ record_id: 'r1', amount: 10, status: '已收款', method: '现金' }],
  }), 'pending');
  // 钱货两清 ⇒ 售后单
  assert.equal(m.salesSectionOf({ ...ORDER, fulfillment_status: '已交付', payment_status: '已收款' }), 'pending');
  // ⚠️ 口径注释（2026-10-11 判据重写）：**履约 / 收款状态不是校验项** ——
  //    两个校验项齐了，就算状态读不出来，也只是"不敢说两清"⇒ 归**待交割**，
  //    不再像旧判据那样判成"待补充"（她的原话只把货品信息 / 资金信息算校验项）。
  assert.equal(m.salesSectionOf({ ...ORDER, payment_status: '' }), 'pending');
  assert.equal(m.salesSectionOf({ ...ORDER, fulfillment_status: '' }), 'pending');

  // 三份单子**不重不漏**（同一批单子分下来，条数加总 = 全部）
  const list = [
    ORDER,
    { ...ORDER, record_id: 'o2', fulfillment_status: '已交付', payment_status: '已收款' },
    { ...ORDER, record_id: 'o3', details: [{ ...ORDER.details[0], color: '' }] },
  ];
  const html = m.ordersSectionsHtml(list);
  for (const key of ['pending', 'afterSales', 'draft']) {
    assert.ok(html.includes(`data-sales-section="${key}"`), `缺 ${key} 这一段`);
    assert.ok(html.includes(`data-tap-target="orders-section:${key}"`), `缺 ${key} 段埋点`);
  }
  const counts = html.split('data-sales-section="').slice(1)
    .map((chunk) => Number((chunk.match(/(\d+) 单/) || [])[1]));
  // ⭐ 2026-10-17：两段后 o3（缺颜色）与 ORDER 都并入待交割 ⇒ [2, 1]
  assert.deepEqual(counts, [3, 0, 0], '三段条数（2026-10-28 起售后单不再按钱货两清筛选，3 单全在交割段）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C4 配品行不参与「货品信息」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C4 配品行（requires_size=false）不算"缺货品信息"：纯配品单也能进待交割 / 售后单', async () => {
  const { orders } = loadFrontendModules();
  const m = await orders;
  const accessoryLine = {
    record_id: 'detail_acc', kind: 'accessory', requires_size: false,
    product: '', product_record_id: '', color: '', size: null,
    accessory: '15元鞋油', accessory_record_id: 'acc_oil', actual_amount: 15,
    fulfillment_status: '已交付',
  };
  // 纯配品单：编号/颜色/尺码**天然为空**（她的口径：配品行就是留空）—— 不算缺
  const onlyAccessory = { ...ORDER, details: [accessoryLine] };
  assert.equal(m.salesSectionOf(onlyAccessory), 'pending', '纯配品单 + 一笔收款 ⇒ 待交割（不是待补充）');
  assert.equal(m.salesSectionOf({ ...onlyAccessory, fulfillment_status: '已交付', payment_status: '已收款' }),
    'pending', '纯配品单不再按钱货两清进售后单');
  // 混单：鞋那一行缺颜色 ⇒ 仍然待补充（配品行无辜，但鞋那一行是真的缺）
  assert.equal(m.salesSectionOf({
    ...ORDER, details: [accessoryLine, { ...ORDER.details[0], color: '' }],
  }), 'pending');
  // ⭐ 配品行**不参与待交付**：它不增不减 `quantity / delivered`（既有进度口径的取值本身没变）
  assert.equal(onlyAccessory.details.filter((line) => line.requires_size !== false).length, 0,
    '判据里被排除的正是"不需要尺码"的那些行');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C5 备注 / 配品 / 赠品都不是校验项
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C5 备注 / 配品 / 赠品**都不是校验项**：有它们不改变归属，没有它们也不判待补充', async () => {
  const { orders } = loadFrontendModules();
  const m = await orders;
  const baseline = m.salesSectionOf(ORDER);
  // 备注（= 销售主表.「赠品」列，页面上叫备注）在不在，都不影响三态
  for (const extra of [{ gift: '' }, { gift: '送袜子' }, { remarks: '她随口说的一句' }]) {
    assert.equal(m.salesSectionOf({ ...ORDER, ...extra }), baseline, `加了 ${JSON.stringify(extra)} 不该改归属`);
  }
  // 配品在不在，都不影响三态
  assert.equal(m.salesSectionOf({ ...ORDER, accessories: [{ name: '15元鞋油' }] }), baseline);
  // 没有备注 / 没有配品 / 没有赠品：**不因此**判成待补充（信息齐 ⇒ 仍然待交割）
  assert.equal(m.salesSectionOf({ ...ORDER }), 'pending');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C6 服务端把判据要的字段给到页面（+ 配品行不进待交付）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 只读假网关。⚠️ 「其他配品」那张表的 `tableId` 在这里**显式给一个非空值**：
 * 真网关/真 service 会先看 `tableId` 再决定读不读它（未配置就跳过，见 `listOrders`），
 * 而测试进程里 `FEISHU_V1_ACCESSORY_TABLE_ID` 是空的。
 */
const listOrdersGateway = (records, { accessoryTableId = 'tbl_acc_order_states' } = {}) => ({
  table: (key) => (key === 'accessory'
    ? { ...V1_BITABLE_SCHEMA.tables.accessory, tableId: accessoryTableId }
    : V1_BITABLE_SCHEMA.tables[key]),
  listAll: async (key) => records[key] || [],
});

// AC-C7 页面上配品明细显示的是**配品名称**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C7 订单卡里配品那一行显示配品名称（不是"未填货号"、也不硬塞一个尺码）', async () => {
  const { orders } = loadFrontendModules();
  const m = await orders;
  const html = m.ordersListHtml([{
    ...ORDER,
    details: [{
      record_id: 'detail_acc', kind: 'accessory', requires_size: false,
      product: '', color: '', size: null, accessory: '15元鞋油', actual_amount: 15,
      fulfillment_status: '已交付',
    }],
  }]);
  assert.ok(html.includes('15元鞋油'), '配品那一行要看得到名称');
  assert.equal(html.includes('未填货号'), false, '配品行不该被当成"没填货号的鞋"');
  assert.equal(html.includes('尺码待补'), false, '配品行没有尺码，不该提示"尺码待补"');
});
