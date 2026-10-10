/**
 * ⭐⭐ 采购「验收到货」= **独立子页面**（业务负责人 **2026-10-10** 真机反馈）。
 *
 * 她的原话（逐字）：
 *   「现在不是已经有三张卡片了吗？一个是到货，一个是退货，一个是验收。目前你的"验收到货"子卡片，
 *    **并不是我点击完之后跳转到新页面，而是一点完之后，它直接在同一个 tab 页里下面出现了。我们不应该是跳转吗？**
 *    你也看一下那个按钮，它应该是去下面验收，而不应该是点完之后换了一个验收的屏幕吗？」
 *
 * ⇒ 本轮口径：
 *   · 采购子 tab 变成 **① 报货 ② 验收到货（独立子页）③ 退货** ＋ 现有两个占位页
 *     （采购订单列表 / 供应商往来款）；
 *   · 「报货 / 验收 / 退货」那一页里**删掉**：验收卡 · `embed` 内嵌宿主 · 任何"去下面验收"的措辞；
 *   · 报货 / 退货 仍走**飞书表单**（外部链接，URL 全部来自 `config/links.js`）；
 *   · 验收页 = **既有** `createOrdersModule({ mode: 'purchase' })`：
 *     **未到货的批次排在前面**，**已到货的折叠**在下面；
 *   · 既有验收逻辑 / 接口**一个字都不许改**（`verify-arrival` / `submit-arrival` →
 *     `POST /api/workbench/purchase/arrivals/confirm` → 既有入库链路）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-P1 采购子 tab 的顺序逐字 = **报货 · 验收到货 · 退货 · 采购订单列表 · 供应商往来款**
 *        （唯一来源 `config/domains.js`）。
 *  AC-P2 「验收到货」是**独立子页**（`kind:'orders'` / `mode:'purchase'`）：
 *        报货那一页里**不再有**验收卡 · `anchor` · `embed` 宿主；也不许再有
 *        「去下面验收 / 就在这一页下面 / 内嵌在本页」这类措辞。
 *  AC-P3 报货 / 退货 = 飞书表单**外链**（URL 逐字 = `config/links.js`），点卡片真的跳走。
 *  AC-P4 领域骨架按 `kind:'orders'` 挂**既有**模块（`createOrdersModule({ mode: page.mode })`）；
 *        `pages.js` / `index.js` 里不再有 `embed` 分支。
 *  AC-P5 验收页：**未到货的批次排在前面**；**已到货的折叠**在 `<details data-view="purchase-arrived">` 里；
 *        折叠头带条数。
 *  AC-P6 既有验收链路**一字未改**：按钮 / 表单字段 / 接口路径 / 提交载荷形状逐字还在，
 *        而且没有新增任何采购验收接口。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 去掉注释再对"代码里有没有某件事"下结论 —— 注释里提一句历史不算实现。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 把前端 ES 模块复制成 `.mjs` 平铺到临时目录，**只改 import 的文件名**（与既有工作台用例同一套做法）。 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-arrival-page-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/query/index.js', 'query-index.mjs', [
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/shared/placeholder.js', 'placeholder.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/domains/pages.js', 'domains-pages.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../shared/placeholder.js'", "from './placeholder.mjs'"],
  ]);
  copy('features/domains/nav.js', 'domains-nav.mjs', [
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../query/index.js'", "from './query-index.mjs'"],
    ["from './pages.js'", "from './domains-pages.mjs'"],
  ]);
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    links: load('links'),
    domains: load('domains'),
    domainPages: load('domains-pages'),
    domainNav: load('domains-nav'),
    ordersConfig: load('orders-config'),
    orders: load('orders-index'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC-P1 采购子 tab 的顺序（配置先行）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P1 采购子 tab 顺序逐字 = 报货 · 验收到货 · 退货 · 采购订单列表 · 供应商往来款', async () => {
  const modules = loadFrontendModules();
  const [domains, nav] = await Promise.all([modules.domains, modules.domainNav]);
  const purchase = domains.domainById('purchase');

  assert.deepEqual(purchase.pages.map((page) => page.label),
    ['报货', '验收到货', '退货', '采购订单列表', '供应商往来款'],
    '采购子 tab 的第一个名字是「验收到货」的独立页，不再是一页三卡');
  assert.deepEqual(purchase.pages.map((page) => page.id),
    ['purchase-report', 'purchase-arrival', 'purchase-return', 'purchase-orders', 'purchase-supplier-money']);

  // 子 tab 上真的点得到（渲染层不写死）
  const tabs = nav.domainSubTabsHtml(purchase);
  for (const label of ['报货', '验收到货', '退货', '采购订单列表', '供应商往来款']) {
    assert.ok(tabs.includes(`>${label}</button>`), `子 tab 上少了「${label}」`);
  }
  const labels = [...tabs.matchAll(/data-domain-page="[^"]*"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(labels, purchase.pages.map((page) => page.label), '子 tab 顺序 = 配置顺序');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P2 「验收到货」= 独立子页（不再有锚点卡 / 内嵌宿主 / "去下面"措辞）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P2 「验收到货」是独立子页：报货页里不再有验收卡 / anchor / embed /「去下面验收」措辞', async () => {
  const modules = loadFrontendModules();
  const [domains, pages] = await Promise.all([modules.domains, modules.domainPages]);
  const purchase = domains.domainById('purchase');
  const report = purchase.pages.find((page) => page.id === 'purchase-report');
  const arrival = purchase.pages.find((page) => page.id === 'purchase-arrival');

  // ① 独立页：既有订单模块的采购模式（独立渲染，不再内嵌在报货那一页下面）
  assert.equal(arrival.kind, 'orders', '「验收到货」= 独立子页（kind: orders）');
  assert.equal(arrival.mode, 'purchase', '用既有订单模块的 purchase 模式');
  assert.equal(arrival.embed, undefined, '独立页不再需要内嵌宿主');
  assert.equal(arrival.anchor, undefined);

  // ② 报货页：只剩"去飞书表单"的卡，没有锚点卡 / 没有内嵌
  assert.equal(report.kind, 'links');
  assert.equal(report.embed, undefined, '`embed` 配置必须删掉');
  assert.equal(report.cards.some((card) => card.anchor), false, '不许再有本页锚点卡');
  assert.deepEqual(report.cards.map((card) => card.title), ['报货'], '报货页上只剩报货那一张卡');
  assert.equal(report.cards.some((card) => card.title === '验收到货'), false, '验收卡从报货页删掉');

  // ③ 渲染出来也一个字都没有（锚点目标 / 内嵌宿主 / "去下面"）
  const html = pages.linksPageHtml(report);
  for (const gone of ['#purchase-arrival', 'data-embed-host', 'domain-embed', '去下面验收', '就在这一页下面']) {
    assert.equal(html.includes(gone), false, `报货页里不许再有「${gone}」`);
  }
  assert.equal(pages.linksPageHtml(report).includes('id="purchase-arrival"'), false,
    '锚点目标不该再存在（验收已经是另一个子页）');

  // ④ 渲染层 / 配置里也不许再留着"内嵌本页"的措辞（去注释后再判）
  const surface = ['config/domains.js', 'features/domains/pages.js', 'features/domains/index.js']
    .map((file) => stripComments(readWorkbench(file))).join('\n');
  for (const gone of ['去下面验收', '就在这一页下面', '内嵌在本页', '本页锚点', 'embed', 'embedHtml']) {
    assert.equal(surface.includes(gone), false, `领域配置 / 渲染层里不许再有「${gone}」`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P3 报货 / 退货 = 飞书表单外链（点卡片真的跳走）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P3 报货 / 退货仍是飞书表单外链（URL 逐字 = config/links.js）', async () => {
  const modules = loadFrontendModules();
  const [domains, pages, links] = await Promise.all([modules.domains, modules.domainPages, modules.links]);
  const purchase = domains.domainById('purchase');

  const report = purchase.pages.find((page) => page.id === 'purchase-report');
  const back = purchase.pages.find((page) => page.id === 'purchase-return');
  assert.deepEqual(report.cards.map((card) => card.href), [links.PURCHASE_REQUEST_FORM_URL], '报货 = 飞书表单');
  assert.deepEqual(back.cards.map((card) => card.href), [links.PURCHASE_RETURN_FORM_URL], '退货 = 飞书表单');
  // 真的是一颗可点的 <a>（跳走，不是本页展开）
  for (const page of [report, back]) {
    const html = pages.linksPageHtml(page);
    assert.ok(html.includes('<a class="entry-card" href='), '外链卡必须是 <a>');
    assert.ok(html.includes('rel="noopener"'));
  }
  assert.ok(pages.linksPageHtml(back).includes(links.PURCHASE_RETURN_FORM_URL));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P4 领域骨架：kind:'orders' 挂既有模块（一行新逻辑都没有）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P4 领域骨架按 kind:orders 挂既有订单模块；不再有 embed 分支', () => {
  const index = stripComments(readWorkbench('features/domains/index.js'));
  assert.ok(index.includes('if (page.kind === \'orders\') return void createOrdersModule({ mode: page.mode }).mount(host);'),
    '「验收到货」走既有的"独立页"分支（模式来自配置）');
  assert.equal(/page\.embed/.test(index), false, '领域骨架不许再认 embed');
  assert.ok(!/\bfetch\s*\(/.test(index), '领域骨架自己不发请求');

  const pages = stripComments(readWorkbench('features/domains/pages.js'));
  assert.equal(/embed/i.test(pages), false, '渲染层不许再画内嵌宿主');
  // 验收逻辑仍在**既有模块**里（不在领域骨架里新写一套）
  assert.ok(index.includes('createOrdersModule('));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P5 验收页：未到货在前 / 已到货折叠
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P5 验收页：未到货的批次排在前面，已到货的折叠在下面（带条数）', async () => {
  const modules = loadFrontendModules();
  const orders = await modules.orders;

  const rows = [
    // 故意把"已到货"的放在最前面 —— 渲染必须把它挪到后面并折叠
    { record_id: 'r1', batch_no: 'CGD-DONE-1', product_number: 'A1', size: 40, quantity: 1, arrival_status: '已到货' },
    { record_id: 'r2', batch_no: 'CGD-WAIT-1', product_number: 'B1', size: 41, quantity: 2, arrival_status: '未到货' },
    { record_id: 'r3', batch_no: 'CGD-DONE-2', product_number: 'C1', size: 42, quantity: 1, arrival_status: '已到货' },
    { record_id: 'r4', batch_no: 'CGD-WAIT-2', product_number: 'D1', size: 43, quantity: 1, arrival_status: '' },
  ];
  const html = orders.purchaseOrdersHtml(rows);

  const foldAt = html.indexOf('data-view="purchase-arrived"');
  assert.ok(foldAt > -1, '已到货的必须有一个折叠块（<details data-view="purchase-arrived">）');
  assert.match(html, /<details[^>]*data-view="purchase-arrived"/,
    '折叠块本身就是一个 <details>（默认收起）');
  // 未到货（含"状态空 ⇒ 按未到货显示"）在折叠块**之前**
  assert.ok(html.indexOf('CGD-WAIT-1') < foldAt, '未到货的批次必须排在已到货前面');
  assert.ok(html.indexOf('CGD-WAIT-2') < foldAt, '状态为空 ⇒ 按未到货处理，也要排前面');
  // 已到货的收在折叠块**里面**
  assert.ok(html.indexOf('CGD-DONE-1') > foldAt, '已到货的要收进折叠块');
  assert.ok(html.indexOf('CGD-DONE-2') > foldAt, '已到货的要收进折叠块');
  assert.match(html, /<summary[^>]*>已到货（2）<\/summary>/, '折叠头写清「已到货（几条）」');
  // 已到货的卡照旧有验收入口（不减少功能；幂等由后端兜底）
  assert.ok(html.includes('data-action="verify-arrival"'), '每张卡都仍有【验收到货】');
  assert.equal((html.match(/data-action="verify-arrival"/g) || []).length, 4, '四批都要有验收按钮');
  // 空列表的人话照旧
  assert.ok(orders.purchaseOrdersHtml([]).includes('purchase-empty'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P6 既有验收链路一字未改
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P6 既有验收链路一字未改（按钮 / 表单 / 接口 / 载荷形状）', async () => {
  const modules = loadFrontendModules();
  const [orders, ordersConfig] = await Promise.all([modules.orders, modules.ordersConfig]);

  // ① 接口路径逐字（唯一来源 config/orders.js，且只有一个验收接口）
  assert.equal(ordersConfig.ORDERS_API.arrivalConfirm, '/api/workbench/purchase/arrivals/confirm');
  const apiSource = readWorkbench('config/orders.js');
  const endpoints = new Set([...apiSource.matchAll(/\/api\/workbench\/purchase\/[a-z/]+/g)].map((m) => m[0]));
  assert.deepEqual([...endpoints].sort(),
    ['/api/workbench/purchase/arrivals/confirm', '/api/workbench/purchase/requests'],
    '采购只许有既有的那两个接口（不许新增验收接口）');

  // ② 前端验收逻辑的四个哨兵逐字还在，且提交载荷形状没变
  const source = readWorkbench('features/orders/index.js');
  for (const needle of [
    'data-action="verify-arrival"',
    'data-action="submit-arrival"',
    'data-field="arrival-amount"',
    'data-field="arrival-note"',
    'api.post(ORDERS_API.arrivalConfirm, {',
    'batchNo, actualAmount: Number(rawAmount), acceptanceText',
  ]) {
    assert.ok(source.includes(needle), `既有验收逻辑少了 ${needle}`);
  }
  // 金额 / 说明的既有校验（提交前后端还会再判一次）
  assert.ok(source.includes("if (!/^\\d+(\\.\\d+)?$/.test(rawAmount) || Number(rawAmount) <= 0)"));
  assert.ok(source.includes('if (!acceptanceText)'));

  // ③ 渲染出来的验收表单逐字（一张卡一颗按钮 + 一个折叠表单）
  const html = orders.purchaseOrdersHtml([
    { record_id: 'r1', batch_no: 'CGD-1', product_number: 'X1', size: 38, quantity: 2, arrival_status: '未到货' },
  ]);
  for (const needle of [
    'data-batch="CGD-1"', 'data-action-block="verify-arrival"', 'data-arrival-batch="CGD-1"',
  ]) {
    assert.ok(html.includes(needle), `验收卡少了 ${needle}`);
  }
});
