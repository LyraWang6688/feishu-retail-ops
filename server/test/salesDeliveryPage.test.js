'use strict';

/**
 * 「销售 · 交割单」原型页验收（2026-10-29 批注后）：
 *   ① 纯函数：data 归一化 / filter 并集+货号筛选 / items 逐条构建 / group 销售日分组 / sort / format；
 *   ② 三 tab：货未清 / 钱未清 / 钱货都未清（钱货都未清只进第三 tab，不重复）；
 *   ③ 页面：无标题/返回链接/排序控件；货号筛选；按销售日分组；卡片一行（日期只在分组头）；
 *   ④ 原型边界：样例数据、零接口请求、零写请求；文件 ≤200 行、CSS 只用 tokens、入口接上。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SERVER_DIR = path.resolve(__dirname, '..');
const WB = path.join(SERVER_DIR, 'public', 'workbench');
const MODULE_DIR = path.join(WB, 'features', 'sales-delivery');
const read = (relative) => fs.readFileSync(path.join(WB, relative), 'utf8');
const lineCount = (relative) => read(relative).split('\n').length;

/** 纯函数层 + 样例 + 配置拷进同一临时目录（模块间 `./x.js` 相对 import 原样可用）。 */
const loadPureModules = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-delivery-pure-'));
  for (const name of ['format.js', 'data.js', 'filter.js', 'items.js', 'group.js', 'sort.js']) {
    fs.copyFileSync(path.join(MODULE_DIR, name), path.join(dir, name));
  }
  fs.copyFileSync(path.join(WB, 'config', 'sales-delivery.js'), path.join(dir, 'sales-delivery-config.mjs'));
  try {
    return {
      format: await import(pathToFileURL(path.join(dir, 'format.js')).href),
      data: await import(pathToFileURL(path.join(dir, 'data.js')).href),
      filter: await import(pathToFileURL(path.join(dir, 'filter.js')).href),
      items: await import(pathToFileURL(path.join(dir, 'items.js')).href),
      group: await import(pathToFileURL(path.join(dir, 'group.js')).href),
      sort: await import(pathToFileURL(path.join(dir, 'sort.js')).href),
      config: await import(pathToFileURL(path.join(dir, 'sales-delivery-config.mjs')).href),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** 页面纯函数链的测试夹具（接口同形数据；不依赖样例文件）。 */
const FIXTURE_ORDERS = [
  { order_no: 'XSD-20261020-0001', record_id: 'o-goods-1', stock_quantity: 0, recorded_at: '2026-10-20T10:00:00+08:00', paid_amount: 398, pending_amount: 0, receivable_amount: 398, pending_delivery_quantity: 1,
    details: [
      { record_id: 'd-g1', stock_quantity: 1, product: 'XHB8095', color: '黑色', size: '41', fulfillment_status: '未交付', sold_at: '2026-10-20T10:00:00+08:00', actual_amount: 199 },
      { record_id: 'd-g2', stock_quantity: 0, product: 'XHB8095', color: '黑色', size: '42', fulfillment_status: '已交付', sold_at: '2026-10-20T10:00:00+08:00', actual_amount: 199 },
    ], payments: [{ record_id: 'p-g1', stock_quantity: 0, method: '微信扫码', amount: 398, status: '已收款' }] },
  { order_no: 'XSD-20261019-0003', record_id: 'o-goods-2', stock_quantity: 0, recorded_at: '2026-10-19T10:00:00+08:00', paid_amount: 259, pending_amount: 0, receivable_amount: 259, pending_delivery_quantity: 1,
    details: [{ record_id: 'd-g3', stock_quantity: 0, product: 'QPL-8957', color: '咖色', size: '37', fulfillment_status: '未交付', sold_at: '2026-10-19T10:00:00+08:00', actual_amount: 259 }],
    payments: [{ record_id: 'p-g2', stock_quantity: 0, method: '支付宝', amount: 259, status: '已收款' }] },
  { order_no: 'XSD-20261018-0002', record_id: 'o-money-1', stock_quantity: 0, recorded_at: '2026-10-18T10:00:00+08:00', paid_amount: 0, pending_amount: 99, receivable_amount: 99,
    details: [{ record_id: 'd-m1', stock_quantity: 0, product: '9A196B-0', color: '黑色', size: '41', fulfillment_status: '已交付', sold_at: '2026-10-18T10:00:00+08:00', actual_amount: 99 }],
    payments: [{ record_id: 'p-m1', stock_quantity: 0, method: '', amount: 99, status: '未收款' }] },
  { order_no: 'XSD-20261017-0005', record_id: 'o-money-2', stock_quantity: 0, recorded_at: '2026-10-17T10:00:00+08:00', paid_amount: 100, pending_amount: 100, receivable_amount: 200,
    details: [{ record_id: 'd-m2', stock_quantity: 0, product: '66133-15', color: '咖色', size: '37', fulfillment_status: '已交付', sold_at: '2026-10-17T10:00:00+08:00', actual_amount: 200 }],
    payments: [{ record_id: 'p-m2', stock_quantity: 0, method: '现金', amount: 100, status: '已收款' }, { record_id: 'p-m3', method: '', amount: 100, status: '未收款' }] },
  { order_no: 'XSD-20261016-0001', record_id: 'o-both-1', stock_quantity: 0, recorded_at: '2026-10-16T10:00:00+08:00', paid_amount: 0, pending_amount: 199, receivable_amount: 199, pending_delivery_quantity: 1,
    details: [{ record_id: 'd-b1', stock_quantity: 0, product: 'XHB8095', color: '白色', size: '40', fulfillment_status: '未交付', sold_at: '2026-10-16T10:00:00+08:00', actual_amount: 199 }],
    payments: [{ record_id: 'p-b1', stock_quantity: 0, method: '', amount: 199, status: '未收款' }] },
  { order_no: 'XSD-20261015-0002', record_id: 'o-both-2', stock_quantity: 0, recorded_at: '2026-10-15T10:00:00+08:00', paid_amount: 259, pending_amount: 259, receivable_amount: 518, pending_delivery_quantity: 1,
    details: [
      { record_id: 'd-b2', stock_quantity: 1, product: 'QPL-8957', color: '黑色', size: '42', fulfillment_status: '未交付', sold_at: '2026-10-15T10:00:00+08:00', actual_amount: 259 },
      { record_id: 'd-b3', stock_quantity: 1, product: 'QPL-8957', color: '黑色', size: '43', fulfillment_status: '已交付', sold_at: '2026-10-15T10:00:00+08:00', actual_amount: 259 },
    ], payments: [{ record_id: 'p-b2', stock_quantity: 0, method: '微信扫码', amount: 259, status: '已收款' }, { record_id: 'p-b3', method: '', amount: 259, status: '未收款' }] },
  { order_no: 'XSD-20261014-0006', record_id: 'o-settled', stock_quantity: 0, recorded_at: '2026-10-14T10:00:00+08:00', paid_amount: 199, pending_amount: 0, receivable_amount: 199,
    details: [{ record_id: 'd-s1', stock_quantity: 0, product: 'XHB8095', color: '黑色', size: '39', fulfillment_status: '已交付', sold_at: '2026-10-14T10:00:00+08:00', actual_amount: 199 }],
    payments: [{ record_id: 'p-s1', stock_quantity: 0, method: '微信扫码', amount: 199, status: '已收款' }] },
  { order_no: 'XSD-20261013-0001', record_id: 'o-platform', stock_quantity: 0, recorded_at: '2026-10-13T10:00:00+08:00', paid_amount: 0, pending_amount: 99, receivable_amount: 99,
    details: [{ record_id: 'd-p1', stock_quantity: 0, product: '9A196B-0', color: '白色', size: '40', fulfillment_status: '已交付', sold_at: '2026-10-13T10:00:00+08:00', actual_amount: 99 }],
    payments: [{ record_id: 'p-pl1', stock_quantity: 0, method: '微信扫码', amount: 99, status: '待平台结算' }] },
  { order_no: 'XSD-UNKNOWN-DATE', record_id: 'o-nodate', stock_quantity: 0, recorded_at: null, paid_amount: 199, pending_amount: 0, receivable_amount: 199, pending_delivery_quantity: 1,
    details: [{ record_id: 'd-n1', stock_quantity: 1, product: 'XHB8095', color: '黑色', size: '38', fulfillment_status: '未交付', sold_at: null, actual_amount: 199 }],
    payments: [{ record_id: 'p-n1', stock_quantity: 0, method: '微信扫码', amount: 199, status: '已收款' }] },
];

/** 用页面同一份配置归一化夹具数据，再按页面同一套判据构建三 tab 事项。 */
const loadData = async () => {
  const mods = await loadPureModules();
  const orders = mods.data.normalizeOrders(FIXTURE_ORDERS, mods.config.SALES_DELIVERY_FIELDS);
  const groups = mods.filter.buildDeliveryGroups(orders, mods.config.SALES_DELIVERY_STATUSES);
  const itemsByTab = mods.items.buildTabItems(groups, mods.config.SALES_DELIVERY_STATUSES, mods.config.SALES_DELIVERY_TABS);
  return { ...mods, orders, groups, itemsByTab };
};

const tabCountsOf = (itemsByTab) => Object.fromEntries(Object.entries(itemsByTab).map(([key, list]) => [key, list.length]));
// 业务负责人 2026-10-29 批注：tab 显示按明细数（双）统计，不是卡片数。
const tabDetailCountsOf = (itemsByTab) => Object.fromEntries(Object.entries(itemsByTab)
  .map(([key, list]) => [key, list.reduce((total, item) => total + (item.details || []).length, 0)]));
const orderNosOf = (itemsByTab, key) => [...new Set((itemsByTab[key] || []).map((item) => item.orderNo))];

// ═══════════════════════════════════════════════════════════════════════════
// ① 格式化 / 归一化
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SD-M1 format：金额 / 明细文本 / 短日期 / 分组日期 key', async () => {
  const { format } = await loadPureModules();
  assert.equal(format.formatMoney(12.5), '¥12.50');
  assert.equal(format.formatMoney(null), '¥0.00');
  assert.equal(format.formatMoneyCompact(100), '¥100');
  assert.equal(format.formatMoneyCompact(99.5), '¥99.50');
  assert.equal(format.detailTextOf({ product: 'XHB8095', color: '黑色', size: '41' }), 'XHB8095 · 黑色 · 41 码');
  assert.equal(format.detailTextOf({}), '');
  assert.match(format.formatShortDate(Date.parse('2026-10-18T10:00:00+08:00')), /^10-18$/);
  assert.equal(format.dateKeyOf(Date.parse('2026-10-18T10:00:00+08:00')), '2026-10-18');
  assert.equal(format.dateKeyOf(null), '');
});

test('AC-SD-M2 data 归一化：字段映射 + 日期取销售主表录单日（不看明细销售日）', async () => {
  const { data, config } = await loadPureModules();
  const order = data.normalizeOrder({
    order_no: 'XSD-1', record_id: 'o1', stock_quantity: 0, recorded_at: Date.parse('2026-10-19T10:00:00+08:00'),
    paid_amount: 40, pending_amount: 60, receivable_amount: 100, pending_delivery_quantity: 1,
    details: [{ record_id: 'd1', stock_quantity: 1, product: 'YD1', color: '黑', size: '40', fulfillment_status: '未交付', sold_at: Date.parse('2026-10-25T10:00:00+08:00'), actual_amount: 100 }],
    payments: [{ record_id: 'p1', stock_quantity: 0, method: '微信', amount: 40, status: '已收款' }],
  }, config.SALES_DELIVERY_FIELDS);
  assert.equal(order.orderNo, 'XSD-1');
  assert.equal(order.details[0].fulfillmentStatus, '未交付');
  // 业务负责人 2026-10-29：三个 tab 的日期统一取「销售主表.录单日」，不看明细销售日。
  assert.equal(order.soldAt, Date.parse('2026-10-19T10:00:00+08:00'));
  assert.equal(order.soldAtSource, 'sales_entry_recorded_at');
  const missing = data.normalizeOrder({
    order_no: 'XSD-2', record_id: 'o2', stock_quantity: 0, recorded_at: null,
    details: [{ record_id: 'd2', stock_quantity: 1, product: 'YD1', color: '黑', size: '40', fulfillment_status: '未交付', sold_at: Date.parse('2026-10-20T10:00:00+08:00'), actual_amount: 100 }],
    payments: [],
  }, config.SALES_DELIVERY_FIELDS);
  assert.equal(missing.soldAt, null);
  assert.equal(missing.soldAtSource, 'missing');
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 三 tab 逐条事项 + 销售日分组 + 货号筛选
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SD-M3 逐条事项：货未清 3 / 钱未清 2 / 钱货都未清 2；已两清与待平台结算不出现', async () => {
  const { groups, itemsByTab } = await loadData();
  assert.deepEqual(tabCountsOf(itemsByTab), { goods: 3, money: 2, both: 2 });
  assert.deepEqual(tabDetailCountsOf(itemsByTab), { goods: 3, money: 2, both: 2 });
  assert.equal(groups.length, 7);
  const all = groups.map((group) => group.orderNo);
  assert.equal(all.includes('XSD-20261014-0006'), false);
  assert.equal(all.includes('XSD-20261013-0001'), false);
  // 货未清 = 未交付明细逐条（一单两条明细但只有一条未交付 ⇒ 只出 1 张）。
  assert.equal(itemsByTab.goods.filter((item) => item.orderNo === 'XSD-20261020-0001').length, 1);
  assert.equal(itemsByTab.goods.every((item) => item.hasAmounts === false), true);
  assert.equal(itemsByTab.money.every((item) => item.hasAmounts === true), true);
});

test('AC-SD-M4 归类互斥：订单只进一个 tab；钱货都未清只在第三 tab；both 的产品行=未交付明细', async () => {
  const { itemsByTab } = await loadData();
  const goods = orderNosOf(itemsByTab, 'goods');
  const money = orderNosOf(itemsByTab, 'money');
  const both = orderNosOf(itemsByTab, 'both');
  for (const [left, right] of [[goods, money], [goods, both], [money, both]]) {
    assert.deepEqual(left.filter((value) => right.includes(value)), [], '不同 tab 不许重复');
  }
  assert.deepEqual(both.sort(), ['XSD-20261015-0002', 'XSD-20261016-0001']);
  assert.equal(itemsByTab.both.every((item) => item.kind === 'both'), true);
  assert.equal(itemsByTab.both.every((item) => item.details.every((line) => line.fulfillmentStatus === '未交付')), true);
});

test('AC-SD-M4b 售后状态（已换货/已退货/已赔货）不算“货没交清”，已两清不展示', async () => {
  const { data, filter } = await loadPureModules();
  const orders = data.normalizeOrders([
    { order_no: 'XSD-AS-1', record_id: 'o-as1', stock_quantity: 0, details: [{ record_id: 'd-as1', product: 'XHB8095', color: '黑色', size: '41', fulfillment_status: '已换货', sold_at: '2026-10-20T10:00:00+08:00', actual_amount: 199 }], payments: [{ record_id: 'p-as1', method: '微信扫码', amount: 199, status: '已收款' }] },
    { order_no: 'XSD-AS-2', record_id: 'o-as2', stock_quantity: 0, details: [{ record_id: 'd-as2', product: 'XHB8095', color: '黑色', size: '41', fulfillment_status: '已退货', sold_at: '2026-10-21T10:00:00+08:00', actual_amount: 199 }], payments: [{ record_id: 'p-as2', method: '微信扫码', amount: 199, status: '已收款' }] },
    { order_no: 'XSD-AS-3', record_id: 'o-as3', stock_quantity: 0, details: [{ record_id: 'd-as3', product: 'XHB8095', color: '黑色', size: '41', fulfillment_status: '已赔货', sold_at: '2026-10-22T10:00:00+08:00', actual_amount: 199 }], payments: [{ record_id: 'p-as3', method: '微信扫码', amount: 199, status: '已收款' }] },
  ]);
  const groups = filter.buildDeliveryGroups(orders, { delivered: '已交付', undelivered: '未交付' });
  assert.deepEqual(groups, [], '售后状态按已结清算；已两清不展示');
});

test('AC-SD-M5 按销售日分组：组顺序远→近、无日期组排最后；同日内按货号升序', async () => {
  const { group, itemsByTab } = await loadData();
  const goodsGroups = group.groupItemsBySoldDate(itemsByTab.goods, '销售日未填');
  assert.deepEqual(goodsGroups.map((item) => item.label), ['10-19', '10-20', '销售日未填']);
  assert.deepEqual(goodsGroups.map((item) => item.key), ['2026-10-19', '2026-10-20', '']);
  assert.deepEqual(goodsGroups[0].items.map((item) => item.orderNo), ['XSD-20261019-0003']);
  assert.deepEqual(goodsGroups[2].items.map((item) => item.orderNo), ['XSD-UNKNOWN-DATE']);
});

test('AC-SD-M6 货号筛选：空 = 全部；选中只留该货号；认不出 = 空列表', async () => {
  const { filter, itemsByTab } = await loadData();
  assert.equal(filter.filterItemsByProduct(itemsByTab.goods, '').length, 3);
  const picked = filter.filterItemsByProduct(itemsByTab.goods, 'QPL-8957');
  assert.equal(picked.length, 1);
  assert.equal(picked[0].orderNo, 'XSD-20261019-0003');
  assert.deepEqual(filter.filterItemsByProduct(itemsByTab.goods, 'NOPE'), []);
});

test('AC-SD-M7 排序纯函数：旧→新 / 新→旧，无销售日的排最后', async () => {
  const { sort, itemsByTab } = await loadData();
  assert.deepEqual(sort.sortDeliveryGroups(itemsByTab.goods, 'asc').map((item) => item.orderNo),
    ['XSD-20261019-0003', 'XSD-20261020-0001', 'XSD-UNKNOWN-DATE']);
  assert.deepEqual(sort.sortDeliveryGroups(itemsByTab.goods, 'desc').map((item) => item.orderNo),
    ['XSD-20261020-0001', 'XSD-20261019-0003', 'XSD-UNKNOWN-DATE']);
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 页面结构 / 配置 / 原型边界
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SD-M8 fetchDeliveryData：调用只读接口并归一化 methods/orders', async () => {
  const { data, config } = await loadPureModules();
  const calls = [];
  const fakeApi = { get: async (path) => { calls.push(path); return { methods: ['微信扫码', '现金'], orders: FIXTURE_ORDERS }; } };
  const out = await data.fetchDeliveryData(fakeApi, config.SALES_DELIVERY_CONFIG, config.SALES_DELIVERY_FIELDS);
  assert.deepEqual(calls, ['/api/workbench/sales/delivery']);
  assert.deepEqual(out.methods, ['微信扫码', '现金']);
  assert.equal(out.orders.length, FIXTURE_ORDERS.length);
  assert.equal(out.orders[0].orderNo, 'XSD-20261020-0001');
});

test('AC-SD-M9 一单一卡：同一销售单号两双未交付只出一张卡、两行明细', async () => {
  const { data, filter, items, config } = await loadPureModules();
  const orders = data.normalizeOrders([
    {
      order_no: 'XSD-CARD-1', record_id: 'o-card-1', stock_quantity: 0, recorded_at: '2026-10-20T10:00:00+08:00',
      details: [
        { record_id: 'd-c1', stock_quantity: 1, product: 'XHB8095', color: '黑色', size: 41, fulfillment_status: '未交付', actual_amount: 199 },
        { record_id: 'd-c2', stock_quantity: 1, product: 'XHB8095', color: '黑色', size: 42, fulfillment_status: '未交付', actual_amount: 199 },
      ],
      // 钱已清：货未清 tab 一卡两行。
      payments: [{ record_id: 'p-c1', stock_quantity: 0, method: '微信扫码', amount: 398, status: '已收款' }],
    },
    {
      order_no: 'XSD-CARD-2', record_id: 'o-card-2', stock_quantity: 0, recorded_at: '2026-10-21T10:00:00+08:00',
      details: [
        { record_id: 'd-c3', stock_quantity: 1, product: 'QPL-8957', color: '咖色', size: 42, fulfillment_status: '未交付', actual_amount: 259 },
        { record_id: 'd-c4', stock_quantity: 1, product: 'QPL-8957', color: '咖色', size: 43, fulfillment_status: '未交付', actual_amount: 259 },
      ],
      payments: [{ record_id: 'p-c2', stock_quantity: 0, method: '现金', amount: 259, status: '未收款' }],
    },
  ], config.SALES_DELIVERY_FIELDS);
  const itemsByTab = items.buildTabItems(filter.buildDeliveryGroups(orders, config.SALES_DELIVERY_STATUSES), config.SALES_DELIVERY_STATUSES, config.SALES_DELIVERY_TABS);
  assert.equal(itemsByTab.goods.length, 1, '货未清：一单只一张卡');
  assert.equal(itemsByTab.goods[0].details.length, 2, '卡里两行未交付明细');
  assert.equal(itemsByTab.both.length, 1, '钱货都未清：一单只一张卡');
  assert.equal(itemsByTab.both[0].details.length, 2, 'both 卡里两行未交付明细');
});

test('AC-SD-M10 货未清按库存分区域：有库存/无库存拆成两张卡，可交付/不可交付', async () => {
  const { data, filter, items, config } = await loadPureModules();
  const orders = data.normalizeOrders([{
    order_no: 'XSD-STOCK-1', record_id: 'o-stock-1', recorded_at: '2026-10-20T10:00:00+08:00',
    details: [
      { record_id: 'd-s1', product: 'XHB8095', color: '黑色', size: 41, stock_quantity: 1, fulfillment_status: '未交付', actual_amount: 199 },
      { record_id: 'd-s2', product: 'XHB8095', color: '黑色', size: 42, stock_quantity: 0, fulfillment_status: '未交付', actual_amount: 199 },
    ],
    payments: [{ record_id: 'p-s1', method: '微信扫码', amount: 398, status: '已收款' }],
  }], config.SALES_DELIVERY_FIELDS);
  const itemsByTab = items.buildTabItems(filter.buildDeliveryGroups(orders, config.SALES_DELIVERY_STATUSES), config.SALES_DELIVERY_STATUSES, config.SALES_DELIVERY_TABS);
  assert.equal(itemsByTab.goods.length, 2, '同一单两行按库存拆成两张卡');
  assert.deepEqual(itemsByTab.goods.map((item) => item.region).sort(), ['available', 'unavailable']);
  assert.deepEqual(itemsByTab.goods.find((item) => item.region === 'available').details.map((line) => line.size), ['41']);
  assert.deepEqual(itemsByTab.goods.find((item) => item.region === 'unavailable').details.map((line) => line.size), ['42']);
});

test('AC-SD-P1 配置：三 tab key/label/顺序/默认/空态；固定远→近排序；货号筛选文案', async () => {
  const { config } = await loadPureModules();
  assert.deepEqual(config.SALES_DELIVERY_TABS.map((tab) => tab.key), ['goods', 'money', 'both']);
  assert.deepEqual(config.SALES_DELIVERY_TABS.map((tab) => tab.label), ['货未清', '钱未清', '钱货都未清']);
  assert.equal(config.SALES_DELIVERY_DEFAULT_TAB, 'goods');
  for (const tab of config.SALES_DELIVERY_TABS) assert.ok(tab.empty, `${tab.key} 必须有空态文案`);
  assert.equal(config.SALES_DELIVERY_CONFIG.sortDirection, 'asc', '页面固定销售日远→近（旧→新）');
  assert.equal(config.SALES_DELIVERY_TEXTS.productFilterLabel, '货号');
  assert.equal(config.SALES_DELIVERY_TEXTS.allProducts, '全部货号');
  assert.equal(config.SALES_DELIVERY_CONFIG.dataSource, 'api');
  assert.equal(config.SALES_DELIVERY_CONFIG.api.delivery, '/api/workbench/sales/delivery');
});

test('AC-SD-P2 模块化：文件都在、每个 ≤200 行；HTML 薄壳；无标题/返回/排序控件', () => {
  const files = [
    'sales-delivery.html',
    'config/sales-delivery.js',
    'features/sales-delivery/index.js',
    'features/sales-delivery/data.js',
    'features/sales-delivery/filter.js',
    'features/sales-delivery/items.js',
    'features/sales-delivery/group.js',
    'features/sales-delivery/sort.js',
    'features/sales-delivery/format.js',
    'features/sales-delivery/render.js',
    'features/sales-delivery/actions.js',
    'features/sales-delivery/sales-delivery.css',
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(WB, file)), `缺文件：${file}`);
    assert.ok(lineCount(file) <= 200, `${file} 超过 200 行（当前 ${lineCount(file)}）`);
  }
  const html = read('sales-delivery.html');
  assert.match(html, /mountSalesDeliveryPage/);
  assert.doesNotMatch(html, /返回工作台|sd-header|sd-back/, 'HTML 薄壳');
  const index = read('features/sales-delivery/index.js');
  assert.doesNotMatch(index, /sd-header|sd-back|返回工作台|backPath/, '页头标题与返回链接已按批注删除');
  assert.match(index, /fetchDeliveryData/);
  assert.doesNotMatch(index, /setInterval/, '不做定时刷新（每次打开/刷新拉一次）');
  const render = read('features/sales-delivery/render.js');
  assert.doesNotMatch(render, /sd-sort|formatShortDate\(line|sd-item-date/, '排序控件与卡内日期已删除（日期只在分组头）');
});

test('AC-SD-P3 写边界：只允许交付/付款两个 POST；CSS 只用 tokens（无 hex/rgb/inline）', () => {
  const allowedPosts = new Set([
    "'/api/workbench/sales/delivery/deliveries'",
    "'/api/workbench/sales/delivery/payments'",
  ]);
  for (const file of ['index.js', 'data.js', 'filter.js', 'items.js', 'group.js', 'sort.js', 'render.js', 'actions.js', 'format.js']) {
    const source = read(`features/sales-delivery/${file}`);
    const posts = [...source.matchAll(/api\.post\(\s*([^,\n]+)/g)].map((match) => match[1].trim());
    assert.ok(posts.every((target) => allowedPosts.has(target)), `${file}：只许交付/付款两个写接口`);
    assert.doesNotMatch(source, /sample-data|sampleBanner/, `${file}：不许样例数据`);
    assert.doesNotMatch(source, /'已交付'|'未收款'|'待平台结算'|'货未清'|'钱未清'|'钱货都未清'/, `${file} 不许写死状态 / tab 文案`);
    assert.doesNotMatch(source, /style=/, `${file} 不许写内联 style`);
  }
  const css = read('features/sales-delivery/sales-delivery.css');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'CSS 里不许写死 hex 颜色');
  assert.doesNotMatch(css, /\brgba?\(/, 'CSS 里不许写死 rgb/rgba 颜色');
});

test('AC-SD-P4 工作台入口：「交割单」卡片跳独立页，供应验收 mode=purchase 不受影响', () => {
  const config = read('config/orders.js');
  assert.match(config, /SALES_DELIVERY_PAGE\s*=\s*'\/workbench\/sales-delivery\.html'/);
  const orders = read('features/orders/index.js');
  assert.match(orders, /SALES_DELIVERY_PAGE/);
  assert.match(orders, /mode !== 'purchase'/);
  assert.match(orders, /sectionCard\.dataset\.ordersSection === 'pending'[\s\S]{0,200}window\.location\.href = SALES_DELIVERY_PAGE/);
});
