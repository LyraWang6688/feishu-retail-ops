/**
 * ⭐⭐ 工作台「入口精简 + 点一次就到」的验收标准（业务负责人 **2026-10-12**，**先写后做**）。
 *
 * 她的原话（逐字）：
 *   「在工作台来说的话，销售它**就没有『销售建单』**，它有的就是：**订单列表 · 销售查询 · 客户往来款**」
 *   「**库存里面的单款查询不需要了**……系统里保留**全仓的查询**和**手工的调整**就行」
 *   「**采购里面的验收到货也不需要了**，因为**验收到货我们在扫码页也做了**，所以目前我们的采购页
 *    就先保持『**订单列表**』和『**供应商往来款**』」
 *   「麻烦把『**采购订单列表**』这个子 tab 页**改为『订单列表』**，把『**采购**』**两个字去掉**」
 *   「点击了『销售查询』这个按钮之后，**系统可以直接自动跳转到我们的多维表格页面**，
 *    **不需要让我再去点一下那个消息查询的卡片**」「**库存的全仓查询**也是」
 *   「我们『**货品**』的 tab 页里面……点击『**货品上新**』之后，**它能直接跳转到我的表单链接**」
 *   「『销售查询』和『全仓查询』**(乙) 飞书【端内】打开（AppLink，手机体验更好）**」
 *   「**如果它和扫码页共用一条链路，那这条链路是不能删的**；但如果没有共用链路，工作台的这条链路就可以删掉」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准
 *   AC1 **三个入口退场**（只删入口）：销售无「销售建单」· 库存无「单款查询」· 采购无「验收到货」；
 *       三个领域的子 tab 列表**逐字**。
 *   AC2 **三个子 tab「点一次就到」**：销售查询 · 全仓查询 · 货品上新 ——
 *       点一次就跳她的外链，**不再渲染中间卡片**；目标 URL **逐字 = 现有配置**。
 *   AC3 **AppLink（乙）格式逐字正确**（`mode` + `url` 的 `encodeURIComponent`）；
 *       并有**一键回落开关**（显式布尔）⇒ 普通跳转。
 *   AC4 `href` 为空 ⇒ **不许死链**（不产生目标；回落成不可点的卡 + 人话）。
 *   AC5 回归：其余子 tab / 大 tab / 标签打印入口 / 模块接线**一条不少**。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const SRC = path.join(__dirname, '../src');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 与既有用例同一套做法：把前端模块复制成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）。 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-direct-jump-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/tabs.js', 'tabs.mjs');
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('core/tabs.js', 'core-tabs.mjs', [["from '../config/tabs.js'", "from './tabs.mjs'"]]);
  copy('core/formatters.js', 'formatters.mjs');
  copy('features/query/index.js', 'query-index.mjs', [
    ["from '../../config/links.js'", "from './links.mjs'"],
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
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    tabs: load('tabs'),
    links: load('links'),
    query: load('query'),
    domains: load('domains'),
    coreTabs: load('core-tabs'),
    queryIndex: load('query-index'),
    domainPages: load('domains-pages'),
    domainNav: load('domains-nav'),
  };
}

const labelsOf = (domain) => domain.pages.map((page) => page.label);
const idsOf = (domain) => domain.pages.map((page) => page.id);
const pageById = (domain, id) => domain.pages.find((page) => page.id === id);

// ═══════════════════════════════════════════════════════════════════════════
// AC1 三个入口退场（只删入口）
// ═══════════════════════════════════════════════════════════════════════════

test('AC1a 销售子 tab 逐字 = 订单列表 · 销售查询 · 客户往来款（不再有「销售建单」）', async () => {
  const modules = loadFrontendModules();
  const domains = await modules.domains;
  const sales = domains.domainById('sales');

  assert.deepEqual(labelsOf(sales), ['订单列表', '销售查询', '客户往来款']);
  assert.deepEqual(idsOf(sales), ['sales-orders', 'sales-query', 'sales-customer-money']);
  assert.equal(pageById(sales, 'sales-create'), undefined, '「销售建单」入口整个退场');
  assert.equal(JSON.stringify(sales).includes('from=sales'), false,
    '工作台配置里不再有指向扫码页销售领域的入口（录入走扫码页）');
});

test('AC1b 库存子 tab 逐字 = 全仓查询 · 手工调整（不再有「单款查询」）', async () => {
  const modules = loadFrontendModules();
  const domains = await modules.domains;
  const inventory = domains.domainById('inventory');

  assert.deepEqual(labelsOf(inventory), ['全仓查询', '手工调整']);
  assert.deepEqual(idsOf(inventory), ['inventory-all', 'inventory-adjust']);
  assert.equal(pageById(inventory, 'inventory-single'), undefined, '「单款查询」入口退场（她用扫一扫）');
  assert.equal(JSON.stringify(inventory).includes('from=inventory'), false,
    '工作台配置里不再有指向扫码页库存领域的入口');
});

test('AC1c 采购子 tab 逐字 = 订单列表 · 供应商往来款（不再有「验收到货」）', async () => {
  const modules = loadFrontendModules();
  const domains = await modules.domains;
  const purchase = domains.domainById('purchase');

  // ⚠️ 2026-10-12 她逐字：「把『采购订单列表』这个子 tab 页改为『订单列表』，把『采购』两个字去掉」
  assert.deepEqual(labelsOf(purchase), ['验收', '订单列表', '供应商往来款']);
  assert.deepEqual(idsOf(purchase), ['purchase-acceptance', 'purchase-orders', 'purchase-supplier-money']);
  assert.equal(pageById(purchase, 'purchase-arrival'), undefined,
    '「验收到货」入口退场（扫码页已做验收）');
  assert.equal(purchase.pages.some((page) => page.kind === 'orders'), false,
    '采购 tab 下不再挂既有订单模块');
});

test('AC1d 子 tab 是按配置渲染的：少一条就真的少一颗按钮（三处都核）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav] = await Promise.all([modules.domains, modules.domainNav]);
  const buttonsOf = (id) => [...nav.domainSubTabsHtml(domains.domainById(id))
    .matchAll(/>([^<]+)<\/button>/g)].map((match) => match[1]);

  assert.deepEqual(buttonsOf('sales'), ['订单列表', '销售查询', '客户往来款']);
  assert.deepEqual(buttonsOf('inventory'), ['全仓查询', '手工调整']);
  assert.deepEqual(buttonsOf('purchase'), ['验收', '订单列表', '供应商往来款']);
  assert.deepEqual(buttonsOf('product'), ['货品上新', '标签打印']);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 点一次就到（不再渲染中间卡片）
// ═══════════════════════════════════════════════════════════════════════════

test('AC2a 三个直跳子 tab：目标 URL 逐字 = 现有配置（多维表格两条 + 货品上新表单）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, links] = await Promise.all([modules.domains, modules.domainNav, modules.links]);
  const applink = (url) => `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${encodeURIComponent(url)}`;

  assert.equal(nav.directJumpUrlForPage(pageById(domains.domainById('sales'), 'sales-query')),
    applink(links.SALES_QUERY_PAGE_URL), '销售查询 → 她 2026-10-08 给的销售页 URL');
  assert.equal(nav.directJumpUrlForPage(pageById(domains.domainById('inventory'), 'inventory-all')),
    applink(links.INVENTORY_QUERY_PAGE_URL), '全仓查询 → 同一条配置里的库存页 URL');
  assert.equal(nav.directJumpUrlForPage(pageById(domains.domainById('product'), 'product-new')),
    applink(links.PRODUCT_NEW_FORM_URL), '货品上新 → 现有配置里的飞书表单 URL');
});

test('AC2b 点一次就到（动作层）：三个直跳页的动作是「跳转」，其它子 tab 仍是「切页」', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, links] = await Promise.all([modules.domains, modules.domainNav, modules.links]);
  const applink = (url) => `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${encodeURIComponent(url)}`;

  const cases = [
    ['sales', 'sales-query', links.SALES_QUERY_PAGE_URL],
    ['inventory', 'inventory-all', links.INVENTORY_QUERY_PAGE_URL],
    ['product', 'product-new', links.PRODUCT_NEW_FORM_URL],
  ];
  for (const [domainId, pageId, href] of cases) {
    const action = nav.resolveTabClick(pageById(domains.domainById(domainId), pageId));
    assert.equal(action.jump, applink(href), `${pageId}：一次点击 → 直接跳她配的页面`);
    assert.equal(action.activate, undefined, `${pageId}：不再走「切到本页」（免得又出现中间卡片一次）`);
  }

  // 非直跳的子 tab 一律照旧切页
  assert.deepEqual(nav.resolveTabClick(pageById(domains.domainById('sales'), 'sales-orders')), { activate: 'sales-orders' });
  assert.deepEqual(nav.resolveTabClick(pageById(domains.domainById('inventory'), 'inventory-adjust')), { activate: 'inventory-adjust' });
  assert.deepEqual(nav.resolveTabClick(pageById(domains.domainById('product'), 'product-labels')), { activate: 'product-labels' });
  assert.deepEqual(nav.resolveTabClick(pageById(domains.domainById('sales'), 'sales-customer-money')), { activate: 'sales-customer-money' });

  // 接线：领域骨架点击时用的就是它，并且真的跳走（`window.location.assign`）
  const index = stripComments(read('features/domains/index.js'));
  assert.ok(index.includes('resolveTabClick'), '领域骨架点击时用 resolveTabClick 决定"跳 or 切页"');
  assert.ok(/window\.location\.assign\(/.test(index), '跳转就是一次 window.location.assign（点一次就到）');
});

test('AC2c 三个直跳页**不再渲染中间卡片**（渲染出来是空的）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav] = await Promise.all([modules.domains, modules.domainNav]);
  const pages = [
    pageById(domains.domainById('sales'), 'sales-query'),
    pageById(domains.domainById('inventory'), 'inventory-all'),
    pageById(domains.domainById('product'), 'product-new'),
  ];
  for (const page of pages) {
    assert.equal(nav.domainPageHtml(page), '', `${page.label}：直跳页不渲染中间卡片`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 (乙) AppLink + 一键回落
// ═══════════════════════════════════════════════════════════════════════════

test('AC3a 默认就是 (乙) 端内 AppLink，`mode` 是显式配置', async () => {
  const modules = loadFrontendModules();
  const [links, queryIndex] = await Promise.all([modules.links, modules.queryIndex]);
  assert.equal(links.LINK_APPLINK_ENABLED, true, '默认开 AppLink（显式布尔）');
  assert.equal(typeof links.LINK_APPLINK_ENABLED, 'boolean');
  assert.equal(links.LINK_APPLINK_MODE, 'sidebar-semi', '当前容器模式（官方文档：这是 PC 端模式，手机上不生效）');
  assert.equal(links.LINK_DIRECT_JUMP_ENABLED, true, '默认点一次就到（显式布尔）');
  assert.equal(links.FEISHU_APPLINK_WEB_URL_OPEN, 'https://applink.feishu.cn/client/web_url/open',
    'AppLink 基址的单一来源 = config/links.js');
  assert.equal(queryIndex.applinkEnabled({ applinkEnabled: false }), false, '显式 false ⇒ 回落');
  assert.equal(queryIndex.applinkEnabled({ applinkEnabled: 'true' }), false, '只有显式 true 才算开');
});

test('AC3b (乙) 格式逐字 + `url` 必须 encodeURIComponent（含 & / ? / 中文的极端例）', async () => {
  const modules = loadFrontendModules();
  const queryIndex = await modules.queryIndex;

  const url = 'https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnY3ZG9LAjrArEe5RzfS8UGh';
  assert.equal(queryIndex.buildDirectJumpUrl(url),
    `https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=${encodeURIComponent(url)}`);

  // mode 可配（官方三个枚举的另两个）
  assert.equal(queryIndex.buildDirectJumpUrl(url, { appLinkMode: 'window' }),
    `https://applink.feishu.cn/client/web_url/open?mode=window&url=${encodeURIComponent(url)}`);
  assert.equal(queryIndex.buildDirectJumpUrl(url, { appLinkMode: 'appCenter' }),
    `https://applink.feishu.cn/client/web_url/open?mode=appCenter&url=${encodeURIComponent(url)}`);

  // 带 query / 中文的目标 URL：**整条 encodeURIComponent**（AGENTS §13 的官方示例口径）
  const tricky = 'https://open.feishu.cn?key1=value1&key2=中文#position2345';
  const built = queryIndex.buildDirectJumpUrl(tricky);
  assert.ok(built.endsWith(`url=${encodeURIComponent(tricky)}`), 'url 参数是整条编码过的');
  assert.ok(!built.slice(built.indexOf('url=')).includes('&key2='), '目标 URL 里的 & 不许漏成 AppLink 的参数');
});

test('AC3c 一键回落：`LINK_APPLINK_ENABLED=false` ⇒ 普通跳转（目标 URL 逐字不加加工）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, links] = await Promise.all([modules.domains, modules.domainNav, modules.links]);
  const page = pageById(domains.domainById('sales'), 'sales-query');

  assert.equal(nav.directJumpUrlForPage(page, { applinkEnabled: false }), links.SALES_QUERY_PAGE_URL,
    '回落路：原样返回配置里的 URL（同窗口，与现有卡片同一条导航）');
  assert.equal(nav.resolveTabClick(page, { applinkEnabled: false }).jump, links.SALES_QUERY_PAGE_URL);
  // 回落路的 URL 里不许再出现 applink 那一段
  assert.equal(nav.directJumpUrlForPage(page, { applinkEnabled: false }).includes('applink'), false);
});

test('AC3d 关掉直跳 ⇒ 回到老路：卡片照渲（href = 配置值）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, links] = await Promise.all([modules.domains, modules.domainNav, modules.links]);
  const salesQuery = pageById(domains.domainById('sales'), 'sales-query');

  assert.equal(nav.directJumpUrlForPage(salesQuery, { enabled: false }), '', '关了就不跳');
  assert.equal(nav.resolveTabClick(salesQuery, { enabled: false }).activate, 'sales-query', '关了就走切页');
  const html = nav.domainPageHtml(salesQuery, { enabled: false });
  assert.ok(html.includes(links.SALES_QUERY_PAGE_URL), '老路的卡 href 仍逐字 = 配置值');
  assert.ok(html.includes('entry-card'), '老路仍是那张卡');

  // 货品上新那条老路也还在（同一张卡）
  const productNew = pageById(domains.domainById('product'), 'product-new');
  assert.ok(nav.domainPageHtml(productNew, { enabled: false }).includes(links.PRODUCT_NEW_FORM_URL));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 href 为空 ⇒ 不许死链
// ═══════════════════════════════════════════════════════════════════════════

test('AC4a 空 href 一律不产生目标（空串 / 纯空白 / undefined 都算没配）', async () => {
  const modules = loadFrontendModules();
  const queryIndex = await modules.queryIndex;
  assert.equal(queryIndex.buildDirectJumpUrl(''), '');
  assert.equal(queryIndex.buildDirectJumpUrl('   '), '');
  assert.equal(queryIndex.buildDirectJumpUrl(undefined), '');
  assert.equal(queryIndex.buildDirectJumpUrl('', { applinkEnabled: false }), '', '回落那一支同样');
});

test('AC4b 空 href 的卡是「不可点 + 人话」，且整条面里没有 href=""', async () => {
  const modules = loadFrontendModules();
  const [queryIndex, nav, domains] = await Promise.all([modules.queryIndex, modules.domainNav, modules.domains]);
  const html = queryIndex.renderQueryEntries([{ id: 'sales-query', icon: '📈', title: '销售查询', href: '' }]);
  assert.ok(html.includes('disabled-card'));
  assert.ok(html.includes('链接待配置'));
  assert.ok(!/href\s*=\s*""/.test(html));
  assert.ok(!html.includes('<a'));

  const allPages = domains.DOMAIN_TABS.flatMap((domain) => domain.pages);
  const surface = allPages.map((page) => nav.domainPageHtml(page, { enabled: false })).join('\n');
  assert.ok(!/href\s*=\s*""/.test(surface), '回落渲染出来的整面也不许有空 href');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 回归：其余结构 / 功能一条不少（含"删入口不删共用链路"）
// ═══════════════════════════════════════════════════════════════════════════

test('AC5a 扫一扫（最前）+ 四个大 tab 逐字不变；货品子 tab 逐字不变', async () => {
  const modules = loadFrontendModules();
  const [domains, tabs, coreTabs] = await Promise.all([modules.domains, modules.tabs, modules.coreTabs]);
  const byId = new Map(domains.DOMAIN_TABS.map((domain) => [domain.id, domain]));

  assert.deepEqual(labelsOf(byId.get('product')), ['货品上新', '标签打印']);
  assert.deepEqual(tabs.MAIN_TABS.map((tab) => tab.label), ['扫一扫', '销售', '库存', '采购', '货品']);
  const buttons = [...coreTabs.mainTabsHtml().matchAll(/data-module="([^"]*)">([^<]*)</g)];
  assert.deepEqual(buttons.map((match) => match[2]), ['扫一扫', '销售', '库存', '采购', '货品']);
});

test('AC5b 「输入编号 → 打开既有页面」这条能力还在（只剩标签打印用它）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, pages] = await Promise.all([modules.domains, modules.domainNav, modules.domainPages]);
  const product = domains.domainById('product');
  const labels = pageById(product, 'product-labels');

  assert.equal(labels.kind, 'entry');
  assert.equal(labels.targetTemplate, '/workbench/label-print.html?keyword={itemNo}');
  const html = nav.domainPageHtml(labels);
  assert.ok(html.includes('data-entry-form') && html.includes('name="number"'), '标签打印仍能填编号');
  assert.equal(pages.entryTarget(labels.targetTemplate, 'YD6693-2|黑色|A'),
    '/workbench/label-print.html?keyword=YD6693-2', '标签打印仍认货号（第一段）');
});

test('AC5c 删入口不删共用链路：三个后端链路仍在（扫码建单 / 验收接口 / 订单模块）', () => {
  // ① 销售建单链路 = 扫码页的销售领域（`scanWriteService` 调的 `salesEntryService`）
  const scanWrite = readSrc('services/scanWriteService.js');
  assert.ok(/createSalesEntryWithOrderNo|salesEntryService/.test(scanWrite),
    '工作台的入口删了，但扫码建单链路（`salesEntryService`）仍在被调用');
  // ② 验收链路：接口本身是"验收这件事"，扫码验收 / 群话题核对共用 ⇒ 删入口不删链路
  const workbenchRoutes = readSrc('routes/workbench.js');
  assert.ok(workbenchRoutes.includes("'/purchase/arrivals/confirm'"),
    '采购验收接口仍在（`POST /api/workbench/purchase/arrivals/confirm`）');
  assert.ok(read('features/orders/index.js').includes('verify-arrival'),
    '订单模块里的验收台代码保留（只是工作台不再挂它这个入口）');
  assert.equal(read('config/orders.js').includes('/api/workbench/purchase/arrivals/confirm'), true,
    '验收接口的地址配置也保留（`config/orders.js`）');
  // ③ 订单列表模块（销售模式还在用）
  const index = stripComments(read('features/domains/index.js'));
  assert.ok(index.includes('createOrdersModule({ mode: page.mode })'), '订单列表仍是既有模块（销售模式）');
  assert.ok(index.includes('createInventoryAdjustmentModule()'), '库存手工调整仍是既有模块');
  assert.ok(!/data-subtab/.test(index), '领域骨架仍用 data-domain-page');
});

test('AC5d 移动端 44px 命中区没被这次改动碰掉', () => {
  const base = read('styles/base.css');
  const tokens = read('styles/tokens.css');
  assert.match(tokens, /--control-height:\s*44px;/);
  assert.match(base, /\.sub-tab\s*\{[^}]*min-height:\s*var\(--control-height\)/, '子 tab 仍 ≥44px');
  assert.match(base, /\.main-tab\s*\{[^}]*min-height:\s*var\(--control-height\)/, '大 tab 仍 ≥44px');
});
