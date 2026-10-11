/**
 * ⭐⭐ C：订单列表三态 = 按**新判据**（业务负责人 2026-10-09 定；
 * 口径全文 `docs/sales-order-states-and-gifts-2026-10-09.md` 第一 / 二节）。
 *
 *   · **校验项只有两个**：① **货品信息**（货号 / 颜色 / 尺码）② **资金信息**
 *     （**收款方式** + **至少一笔收款记录**）；**备注 / 配品 / 赠品都不是校验项**；
 *   · **待补充** = 缺任一校验项；**待交割** = 两项齐（**至少一笔收款**即可）但**货没给完 或 钱没付完**；
 *     **售后列表** = **钱货两清**（交付完 + **钱收齐**）；
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
 *        **售后列表** = `fulfillment_status` = 已交付 且 `payment_status` = 已收款。
 *  AC-C4 **配品行不参与货品信息**：`requires_size === false` 的明细（编号/颜色/尺码天然为空）
 *        不算"缺货品信息"；**纯配品单**照样能进待交割 / 售后列表。
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
  assert.deepEqual(front.SALES_SECTIONS.map((section) => section.key), ['supplement', 'pending', 'afterSales']);
  assert.deepEqual(front.SALES_SECTIONS.map((section) => section.tag), ['待补充', '待交割', '已两清']);
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
    assert.equal(m.salesSectionOf(order), 'supplement', `缺${label} ⇒ 待补充`);
  }
  const withoutSize = { ...ORDER, details: [{ ...ORDER.details[0], size: null }] };
  assert.equal(m.salesSectionOf(withoutSize), 'supplement', '缺尺码 ⇒ 待补充');
  const noDetails = { ...ORDER, details: [] };
  assert.equal(m.salesSectionOf(noDetails), 'supplement', '一条明细都没有 ⇒ 待补充');

  // ② 资金信息：收款方式 + 至少一笔收款记录
  assert.equal(m.salesSectionOf({ ...ORDER, payments: [] }), 'supplement', '一条收款记录都没有 ⇒ 待补充');
  assert.equal(m.salesSectionOf({
    ...ORDER, payments: [{ record_id: 'p1', amount: 100, status: '未收款', method: '' }],
  }), 'supplement', '只有一条"未收款"（没有收款方式）⇒ 资金信息还没齐');

  // ③ 两个校验项都齐 ⇒ 不再是待补充（哪怕状态是"部分交付 / 部分收款"）
  assert.notEqual(m.salesSectionOf(ORDER), 'supplement');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C3 待交割 / 售后列表（至少一笔收款 → 待交割；收齐 → 售后列表）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C3 待交割 = 两项齐但没两清；售后列表 = 钱货两清（至少一笔 ⇒ 待交割，收齐 ⇒ 售后列表）', async () => {
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
  // 钱货两清 ⇒ 售后列表
  assert.equal(m.salesSectionOf({ ...ORDER, fulfillment_status: '已交付', payment_status: '已收款' }), 'afterSales');
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
  for (const key of ['supplement', 'pending', 'afterSales']) {
    assert.ok(html.includes(`data-sales-section="${key}"`), `缺 ${key} 这一段`);
  }
  const counts = html.split('data-sales-section="').slice(1)
    .map((chunk) => Number((chunk.match(/(\d+) 单/) || [])[1]));
  assert.deepEqual(counts, [1, 1, 1], '每一段各一单（不重不漏）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-C4 配品行不参与「货品信息」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-C4 配品行（requires_size=false）不算"缺货品信息"：纯配品单也能进待交割 / 售后列表', async () => {
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
    'afterSales', '纯配品单钱货两清 ⇒ 售后列表');
  // 混单：鞋那一行缺颜色 ⇒ 仍然待补充（配品行无辜，但鞋那一行是真的缺）
  assert.equal(m.salesSectionOf({
    ...ORDER, details: [accessoryLine, { ...ORDER.details[0], color: '' }],
  }), 'supplement');
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

test('AC-C6 listOrders 明细带 kind/requires_size/color/accessory；配品行对「待交付」的贡献 = 0', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { 资金状态: '已写入', 销售单号: 'XSD-ACC' } }],
    salesDetail: [
      // 鞋：未交付（待交付 +1）
      { record_id: 'detail_shoe', fields: {
        销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '未交付', 实收金额: 89,
      } },
      // 配品：已交付（既有口径）—— **不许**进待交付
      { record_id: 'detail_acc', fields: {
        销售单号: ['order_1'], 配品: ['acc_oil'], 履约状态: '已交付', 实收金额: 15,
      } },
    ],
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
    paymentRecord: [{ record_id: 'receipt_1', fields: { 关联销售单: ['order_1'], 收款金额: 50, 收款状态: '已收款', 收款方式: ['method_1'] } }],
    paymentMethod: [{ record_id: 'method_1', fields: { 收款方式: '微信' } }],
    product: [{ record_id: 'product_1', fields: { 编号: 'XHB8095', 货号: 'XHB8095', 颜色: { text: '黑色' } } }],
    accessory: [{ record_id: 'acc_oil', fields: { 名称: '15元鞋油', 单价: 15 } }],
  };
  const result = await new SalesFollowupService({ gateway: listOrdersGateway(records) }).listOrders();
  assert.equal(result.orders.length, 1);
  const order = result.orders[0];
  assert.equal(order.pending_delivery_quantity, 1, '只有鞋那一行待交付；配品行不参与');
  const byId = new Map(order.details.map((detail) => [detail.record_id, detail]));
  const shoe = byId.get('detail_shoe');
  const accessory = byId.get('detail_acc');
  // ① 鞋那一行：把"货品信息"三个字段都给她（编号 / 颜色 / 尺码）
  assert.equal(shoe.kind, 'shoe');
  assert.equal(shoe.requires_size, true);
  assert.equal(shoe.product, 'XHB8095');
  assert.equal(shoe.color, '黑色', '颜色必须给到页面（货品信息 = 货号/颜色/尺码）');
  assert.equal(shoe.size, 38);
  // ② 配品那一行：编号 / 颜色 / 尺码**本来就是空的**，但要**明说**这一行不需要尺码
  assert.equal(accessory.kind, 'accessory');
  assert.equal(accessory.requires_size, false);
  assert.equal(accessory.product, '', '配品行留空（她的口径）');
  assert.equal(accessory.color, '');
  assert.equal(accessory.size, null);
  assert.equal(accessory.accessory, '15元鞋油', '配品行显示的是「其他配品」的名称');
  assert.equal(accessory.accessory_record_id, 'acc_oil');
  // ③ 资金信息要的两个东西都在（方式 + 条数）
  assert.equal(order.payments.length, 1);
  assert.equal(order.payments[0].method, '微信');
});

test('AC-C6b 「其他配品」表没配置 ⇒ 订单列表照常出得来（配品行只是没有名称）', async () => {
  const records = {
    salesEntry: [{ record_id: 'order_1', fields: { 资金状态: '已写入', 销售单号: 'XSD-NOACC' } }],
    salesDetail: [{ record_id: 'detail_acc', fields: {
      销售单号: ['order_1'], 配品: ['acc_oil'], 履约状态: '已交付', 实收金额: 15,
    } }],
    sizeManagement: [],
    paymentRecord: [],
    paymentMethod: [],
    product: [],
    // ⚠️ 没有 accessory 这张表（未配置）——读它必须被**跳过**，不许把整页打成 500
  };
  const gateway = {
    table: (key) => (key === 'accessory'
      ? { ...V1_BITABLE_SCHEMA.tables.accessory, tableId: '' }
      : V1_BITABLE_SCHEMA.tables[key]),
    listAll: async (key) => {
      if (key === 'accessory') throw new Error('未配置「其他配品」表的 table_id');
      return records[key] || [];
    },
  };
  const result = await new SalesFollowupService({ gateway }).listOrders();
  assert.equal(result.orders.length, 1);
  const accessory = result.orders[0].details[0];
  assert.equal(accessory.kind, 'accessory', '配品行照样认得出来（属性来自可售品配置，不靠那张表）');
  assert.equal(accessory.accessory, '', '读不到名称就留空（不编）');
});

// ═══════════════════════════════════════════════════════════════════════════
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
