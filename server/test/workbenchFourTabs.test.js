/**
 * ⭐⭐ 工作台**四个业务领域 tab** 的验收标准（业务负责人 **2026-10-09** 定的最终结构）。
 *
 * 她的原话（逐字）：
 *   「我们就按照**四个 tab 页**来规划：**销售、采购、库存和货品**……
 *    Tab 页的顺序从左往右是：**销售、库存、采购和货品**，
 *    我们现在的工作台**一定要对移动端友好**，而且我觉得现在这个**不太美观**」
 *   「在 4 个 tab 页里面，我们**都能扫同一个二维码**，但是**点击的按钮不同，触发的逻辑就不一样**」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC1 一级 tab **恰好 4 个**，顺序逐字 = **销售 · 库存 · 采购 · 货品**（文案唯一来源
 *      `config/tabs.js`；`index.html` 里不许再写一遍；默认打开的 = 第一个 = 销售）。
 *  AC2 **每个 tab 的子页面清单与映射**（`config/domains.js` 是唯一来源）——
 *      ⭐ **2026-10-09 下半场最新口径**（业务负责人改的那三件）：
 *      销售 = 销售建单 / 订单列表 / 销售查询 / ⭐**客户往来款（占位页）** ·
 *      库存 = 单款查询 / 全仓查询 / 手工调整（**不动**）·
 *      采购 = 报货 / 验收 / 退货 / ⭐**采购订单列表（占位页，未来放 AI 页面）** /
 *             ⭐**供应商往来款（占位页）** ·
 *      货品 = 货品上新 / 标签打印（**不动**）。
 *      每个子页面落的**还是既有实现**：扫码页（`?from=<领域>`）/ 既有订单模块 /
 *      既有多维表格外链 / 既有标签打印页；**URL 一个字都没换**。
 *      ⚠️ **采购订单列表从"可用的订单列表"变成占位页** ⇒ 「验收到货」的入口搬到
 *      「采购 → 报货 / 验收 / 退货」这一页里（内嵌既有 `features/orders` 的 `purchase` 模式，
 *      见 AC9）—— 既有模块**一个都没删**。
 *  AC3 **旧功能仍可达**：旧入口一个都没删，集中到**首页页脚那一行「其它 / 历史功能」**
 *      → `others.html`，上面能点到「信息录入（原常用功能）」「采购管理（原一级 tab）」
 *      与三个独立页；占位的三个模块如实列出；老链接 / 老页面文件都还在。
 *  AC4 **移动端哨兵**：viewport · 默认单列卡片 · **无 `<table>`** ·
 *      按钮 / 输入框 **≥44px**（`--control-height`）· **无固定 `min-width`** ·
 *      长文本 `overflow-wrap: anywhere` · `html, body` 不横向滚动；桌面（≥761px）才铺多列。
 *  AC5 **扫码页领域切换**：`GET /s/:number` 不变，顶部一颗领域按钮四个值
 *      `?from=sales|inventory|purchase|product`，**缺省 = 销售**；切到哪个领域就**只显示**
 *      那个领域的操作；认不出的值一律回落缺省（不报错、不白屏）；没 JS 时四块全显示（兜底）。
 *      ⚠️ 这一条**没有改 `routes/scanPage.js` / `config/scanPage.js`**：四块都渲染进 HTML，
 *      由 CSS 按 `<html data-realm>` 显示其中一块（细节见 `src/views/scanPageRealm.js`）。
 *  AC6 **主题变量集中在一处**：配色 / 间距 / 圆角 / 字号全在 `styles/tokens.css`；
 *      其余工作台 CSS **一个十六进制颜色都不许有**（只用 `var(--…)`）；
 *      扫码页在渲染时**把同一份令牌内联进 `:root`** ⇒ 改那一个文件，两边一起变。
 *  AC7 **既有扫码页与标签用例不受影响**：那几个用例文件还在，且它们钉住的 HTML 片段
 *      （库存表 / 两个写入口 / 结果页 / 标签打印页接线）逐字还在。
 *  AC8 ⭐ **三个占位页统一写「待建设」**（客户往来款 / 供应商往来款 / 采购订单列表）：
 *      简洁 = 标题 + 一句「待建设」+（可注明将来放什么）；有彩色小标签；
 *      仍然**一列卡片 / 无表格 / 无固定 min-width / 无写死颜色**（移动端哨兵同样适用）。
 *  AC9 ⭐ **「验收到货」的入口在「采购 → 报货 / 验收 / 退货」这一页里**：
 *      内嵌**既有** `createOrdersModule({ mode: 'purchase' })`（= 原来那套一批一批点的验收台），
 *      走的是**既有**接口与既有业务层 —— 一行新验收逻辑都没有。
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
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const workbenchHas = (relative) => fs.existsSync(path.join(WORKBENCH, relative));
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

/** 去掉注释再对"代码里有没有某件事"下结论 —— 注释里提一句历史不算实现。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const walk = (dir, extensions) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full, extensions);
  return extensions.some((extension) => entry.name.endsWith(extension)) ? [full] : [];
});

/**
 * 把要跑的前端模块复制成 `.mjs` 平铺到一个临时目录，**只把 import 的文件名改成复制后的名字**
 * （源码逻辑一个字不改）—— 与既有 `workbenchTwoTabsAndQueryEntries.test.js` 同一套做法。
 * 每一条替换都必须命中（命不中说明源码的 import 变了，测试要跟着更新）。
 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-four-tabs-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement, optional] of replacements) {
      if (!source.includes(needle)) {
        // `optional` = 这条 import 在改动前后不一定存在（同一个测试文件两边都能跑）。
        assert.ok(optional, `${from} 里没有找到要改的 import：${needle}`);
        continue;
      }
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/tabs.js', 'tabs.mjs');
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('config/domains.js', 'domains.mjs', [
    ["from './links.js'", "from './links.mjs'"],
    // ⚠️ 可选：这一条只在"按 id 引用查询板块"的写法下存在（现在由 features/domains/nav.js 解析 id）。
    ["from './query.js'", "from './query.mjs'", true],
  ]);
  copy('config/others.js', 'others-config.mjs');
  copy('config/home.js', 'home.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('core/tabs.js', 'core-tabs.mjs', [["from '../config/tabs.js'", "from './tabs.mjs'"]]);
  copy('core/formatters.js', 'formatters.mjs');
  copy('features/query/index.js', 'query-index.mjs', [
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/domains/pages.js', 'domains-pages.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    // ⭐ 占位页那一个「待建设」与既有占位模块**共用同一份文案**（统一口径）。
    ["from '../shared/placeholder.js'", "from './placeholder.mjs'"],
  ]);
  copy('features/shared/placeholder.js', 'placeholder.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/domains/nav.js', 'domains-nav.mjs', [
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../query/index.js'", "from './query-index.mjs'"],
    ["from './pages.js'", "from './domains-pages.mjs'"],
  ]);
  copy('features/others/index.js', 'others-index.mjs', [
    ["from '../../config/others.js'", "from './others-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../domains/pages.js'", "from './domains-pages.mjs'"],
  ]);
  copy('features/common/index.js', 'common.mjs', [
    ["from '../../config/home.js'", "from './home.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    tabs: load('tabs'),
    coreTabs: load('core-tabs'),
    links: load('links'),
    query: load('query'),
    domains: load('domains'),
    othersConfig: load('others-config'),
    home: load('home'),
    queryIndex: load('query-index'),
    domainPages: load('domains-pages'),
    domainNav: load('domains-nav'),
    placeholder: load('placeholder'),
    othersIndex: load('others-index'),
    common: load('common'),
    ordersConfig: load('orders-config'),
    orders: load('orders-index'),
  };
}

/** 用假容器渲染一个模块，返回它写进去的 HTML（`mount()` 只写 innerHTML，不需要真 DOM）。 */
async function render(modulePromise, factoryName) {
  const module = await modulePromise;
  const container = { innerHTML: '' };
  module[factoryName]().mount(container);
  return container.innerHTML;
}

const pageLabels = (domain) => domain.pages.map((page) => page.label);

// ═══════════════════════════════════════════════════════════════════════════
// AC1 一级 tab：恰好 4 个，顺序 = 销售 / 库存 / 采购 / 货品
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 一级 tab 恰好 4 个，顺序逐字 = 销售 · 库存 · 采购 · 货品（配置先行）', async () => {
  const modules = loadFrontendModules();
  const [tabs, coreTabs] = await Promise.all([modules.tabs, modules.coreTabs]);

  assert.deepEqual(tabs.MAIN_TABS, [
    { module: 'sales', label: '销售' },
    { module: 'inventory', label: '库存' },
    { module: 'purchase', label: '采购' },
    { module: 'product', label: '货品' },
  ], '正好四个 tab，顺序 = 她念的顺序（销售 · 库存 · 采购 · 货品）——唯一来源 config/tabs.js');

  const html = coreTabs.mainTabsHtml();
  const buttons = [...html.matchAll(/<button class="([^"]*)" type="button" data-module="([^"]*)">([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 4, 'nav 里正好 4 个 tab 按钮（不多不少）');
  assert.deepEqual(buttons.map((button) => button[3]), ['销售', '库存', '采购', '货品'], '文案逐字、顺序逐字');
  assert.deepEqual(buttons.map((button) => button[2]), ['sales', 'inventory', 'purchase', 'product'], 'data-module 与领域 id 一致');
  assert.ok(buttons[0][1].includes('active'), '默认打开的 tab = 第一个 = 销售');
  assert.deepEqual(buttons.slice(1).map((button) => button[1].includes('active')), [false, false, false], '只有第一个带 active');
  // 旧文案一个新 tab 里都不许再出现（它们去了「其它 / 历史功能」页）
  for (const gone of ['信息录入', '信息查询', '订单列表']) {
    assert.ok(!tabs.MAIN_TABS.some((tab) => tab.label === gone), `一级 tab 上不许再有旧文案「${gone}」`);
  }
});

test('AC1b index.html：nav 留空（文案不在这里再写一遍）+ 有「其它 / 历史功能」页脚入口', () => {
  const html = readWorkbench('index.html');
  const nav = html.match(/<nav id="main-tabs"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'index.html 必须仍有 <nav id="main-tabs">');
  assert.ok(!/<button/.test(nav[0]) && !/data-module=/.test(nav[0]),
    'index.html 里不许再硬编码 main-tab 按钮 —— 文案的单一来源是 config/tabs.js（配置先行）');
  assert.match(html, /href="\/workbench\/others\.html"/, '页脚要有「其它 / 历史功能」那一行（她的硬要求）');
  assert.match(html, /features\/domains\/domains\.css/, '四个领域的样式要加载');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 每个 tab 的子页面清单与映射
// ═══════════════════════════════════════════════════════════════════════════

test('AC2 四个 tab 的子页面清单与她要的映射逐条对上（config/domains.js 是唯一来源）', async () => {
  const modules = loadFrontendModules();
  const [domains, links] = await Promise.all([modules.domains, modules.links]);
  const { DOMAIN_TABS } = domains;

  // ① 领域 id / 顺序与一级 tab 完全一致（两处配置不许各说各的）
  const tabs = await modules.tabs;
  assert.deepEqual(DOMAIN_TABS.map((domain) => domain.id), tabs.MAIN_TABS.map((tab) => tab.module),
    '领域的 id 与顺序必须与 config/tabs.js 的 MAIN_TABS 一致');

  // ② 子页面清单逐字（她 2026-10-09 最新口径：销售多一个客户往来款、采购改成三段）
  const byId = new Map(DOMAIN_TABS.map((domain) => [domain.id, domain]));
  assert.deepEqual(pageLabels(byId.get('sales')), ['销售建单', '订单列表', '销售查询', '客户往来款']);
  assert.deepEqual(pageLabels(byId.get('inventory')), ['单款查询', '全仓查询', '手工调整']);
  assert.deepEqual(pageLabels(byId.get('purchase')), ['报货 / 验收 / 退货', '采购订单列表', '供应商往来款']);
  assert.deepEqual(pageLabels(byId.get('product')), ['货品上新', '标签打印']);

  // ③ 销售：建单 → 扫码页的**销售领域**（共用同一套业务处理层）；订单列表 = 既有模块的销售模式；
  //    销售查询 = 她配的那条多维表格外链（URL 从 config/links.js 来，没换）
  const sales = byId.get('sales');
  const salesCreate = sales.pages.find((page) => page.id === 'sales-create');
  assert.equal(salesCreate.kind, 'entry');
  assert.equal(salesCreate.targetTemplate, '/s/{number}?from=sales', '销售建单 = 扫码页的销售领域');
  assert.equal(sales.pages.find((page) => page.id === 'sales-orders').mode, 'sales', '订单列表只看销售（领域已分好）');
  const salesQuery = sales.pages.find((page) => page.id === 'sales-query');
  assert.equal(salesQuery.kind, 'query');
  assert.equal(salesQuery.sectionId, 'sales-query');
  // ⭐ 客户往来款 = 占位页（她 2026-10-09 最新口径）
  const customerMoney = sales.pages.find((page) => page.id === 'sales-customer-money');
  assert.equal(customerMoney.kind, 'placeholder', '客户往来款 = 占位页');
  assert.equal(customerMoney.label, '客户往来款');

  // ④ 库存：单款查询 → 扫码页的**库存领域**；全仓查询 = 同一条多维表格外链（改的是名字，不是 URL）；
  //    手工调整 = 既有「库存手工调整」模块（内嵌）
  const inventory = byId.get('inventory');
  const single = inventory.pages.find((page) => page.id === 'inventory-single');
  assert.equal(single.targetTemplate, '/s/{number}?from=inventory', '单款查询 = 扫码页的库存领域');
  const warehouse = inventory.pages.find((page) => page.id === 'inventory-all');
  assert.equal(warehouse.kind, 'query');
  assert.equal(warehouse.sectionId, 'inventory-query');
  assert.equal(inventory.pages.find((page) => page.id === 'inventory-adjust').kind, 'inventory-adjustment');

  // ⑤ 采购：报货 / 退货 = 两个飞书表单（URL 逐字 = config/links.js 里的既有两条）；
  //    ⭐ 验收 = **内嵌在本页**（既有订单模块的 purchase 模式，见 AC9）——
  //       她要求「验收」在①报货/验收/退货里，所以给一张锚点卡直接跳到下面那一块；
  //    ⭐ 采购订单列表 = **占位页（未来放 AI 页面）**；供应商往来款 = 占位页
  const purchase = byId.get('purchase');
  const report = purchase.pages.find((page) => page.id === 'purchase-report');
  assert.deepEqual(report.cards.map((card) => card.href).filter((href) => href && !href.startsWith('#')),
    [links.PURCHASE_REQUEST_FORM_URL, links.PURCHASE_RETURN_FORM_URL], '报货 / 退货还是她给的那两个表单');
  assert.deepEqual(report.cards.filter((card) => card.anchor).map((card) => [card.title, card.anchor]),
    [['验收到货', '#purchase-arrival']], '验收 = 跳到本页下面的验收块（不另做一套验收）');
  assert.equal(report.embed?.module, 'orders', '验收块 = 内嵌既有订单模块');
  assert.equal(report.embed?.mode, 'purchase', '内嵌的是 purchase 模式（一张报货批次一张卡 + 验收到货）');
  const purchaseOrders = purchase.pages.find((page) => page.id === 'purchase-orders');
  assert.equal(purchaseOrders.kind, 'placeholder', '采购订单列表 = 占位页（她原话：占位页，未来放 AI 页面）');
  const supplierMoney = purchase.pages.find((page) => page.id === 'purchase-supplier-money');
  assert.equal(supplierMoney.kind, 'placeholder', '供应商往来款 = 占位页');

  // ⑥ 货品：上新 = 飞书表单外链（URL 提到 config/links.js，单一来源）；标签打印 = 单个（带编号）
  //    + 批量（既有标签打印页），**没有重做打印**
  const product = byId.get('product');
  const newProduct = product.pages.find((page) => page.id === 'product-new');
  assert.deepEqual(newProduct.cards.map((card) => card.href), [links.PRODUCT_NEW_FORM_URL]);
  const labels = product.pages.find((page) => page.id === 'product-labels');
  assert.equal(labels.targetTemplate, '/workbench/label-print.html?keyword={itemNo}', '单个 = 把货号带进既有标签打印页');
  assert.deepEqual(labels.links.map((link) => link.href), ['/workbench/label-print.html'], '批量 = 打开既有标签打印页');
});

test('AC2b 领域子 tab 是渲染出来的（不是写死的 HTML）：按钮 / 选中态 / 三种静态子页', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, pagesModule, queryIndex] = await Promise.all([
    modules.domains, modules.domainNav, modules.domainPages, modules.queryIndex,
  ]);
  const sales = domains.domainById('sales');

  const subTabs = nav.domainSubTabsHtml(sales, 'sales-orders');
  const buttons = [...subTabs.matchAll(/<button class="([^"]*)" type="button"\s*data-domain-page="([^"]*)"[^>]*>([^<]*)</g)];
  assert.deepEqual(buttons.map((button) => button[3]), ['销售建单', '订单列表', '销售查询', '客户往来款']);
  assert.deepEqual(buttons.map((button) => button[2]), ['sales-create', 'sales-orders', 'sales-query', 'sales-customer-money']);
  assert.ok(buttons[1][1].includes('active'), '传进来的那个子页 = 选中态');
  assert.ok(!buttons[0][1].includes('active'), '没选中的子页不许带 active');
  // ⚠️ 用 `data-domain-page`（不是 data-subtab）：内嵌的既有模块自己也在用 data-subtab
  assert.ok(subTabs.includes('data-domain-page='));
  assert.ok(!subTabs.includes('data-subtab='), '领域子 tab 不许用 data-subtab（会和内嵌模块的内部子 tab 打架）');

  // 「输入编号 → 打开既有页面」：模板替换 + URL 编码（编号里有 `|` 与中文）
  const target = pagesModule.entryTarget('/s/{number}?from=sales', 'YD6693-2|黑色|A');
  assert.equal(target, `/s/${encodeURIComponent('YD6693-2|黑色|A')}?from=sales`);
  assert.equal(pagesModule.entryTarget('/workbench/label-print.html?keyword={itemNo}', 'YD6693-2|黑色|A'),
    '/workbench/label-print.html?keyword=YD6693-2', '标签打印认的是货号（第一段）');
  assert.equal(pagesModule.entryTarget('/s/{number}?from=sales', '   '), '', '空编号不拼 URL（页面会提示先填）');

  // 三种静态子页都能渲染；入口页里有表单、外链页里有卡片 + 内嵌验收宿主、外链 URL 逐字来自配置
  const create = pagesModule.entryPageHtml(sales.pages[0]);
  assert.ok(create.includes('data-entry-form') && create.includes('name="number"'), '销售建单页必须有编号输入 + 打开表单');
  const linkPage = pagesModule.linksPageHtml(domains.domainById('purchase').pages[0]);
  assert.ok(linkPage.includes('href="#purchase-arrival"'), '「验收」那张卡锚到本页下面的验收块');
  assert.ok(linkPage.includes('data-embed-host="purchase-arrival"'), '验收块有一个"既有模块挂进来"的宿主');
  assert.ok(linkPage.includes('rel="noopener"'), '外链卡带 rel="noopener"');
  const queryPage = nav.domainPageHtml(domains.domainById('inventory').pages[1]);
  assert.ok(queryPage.includes('全仓查询'), '库存的外链子页标题 = 全仓查询');
  assert.ok(!queryPage.includes('销售查询'), '销售查询只在销售 tab 里（各回各的领域）');
  assert.ok(queryIndex.renderQueryEntries([{ id: 'inventory-query', icon: '📦', title: '全仓查询', desc: 'd', href: 'https://example.com/x' }])
    .includes('https://example.com/x'), '外链卡的 href 就是配置值（渲染层不加工）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2c / AC2d 领域骨架不写业务逻辑 · 订单列表的三份单子
// ═══════════════════════════════════════════════════════════════════════════

test('AC2c 领域骨架只接线：不发请求 / 不写库 / 不出现 data-subtab；工作台所有相对 import 都能解析', () => {
  // ① 领域骨架（index.js）只负责"挂既有模块 / 画静态子页"——不许自己发请求或碰业务
  const index = stripComments(readWorkbench('features/domains/index.js'));
  assert.ok(index.includes('createOrdersModule({ mode: page.mode })'), '订单列表 = 既有模块（按领域传 mode）');
  assert.ok(index.includes('createInventoryAdjustmentModule()'), '手工调整 = 既有模块');
  assert.ok(!/\bfetch\s*\(/.test(index) && !/\bapi\.(get|post)\s*\(/.test(index), '领域骨架一次网络调用都没有');
  assert.ok(!/\bgateway\b|applySale|applyPurchase/.test(index), '领域骨架不许碰业务写入');
  assert.ok(!/data-subtab/.test(index), '领域骨架用 data-domain-page（内嵌模块自己才用 data-subtab）');

  // ② 工作台的相对 import **一个都不能是孤儿路径**（新加的模块没有别的用例会加载它）
  const files = walk(path.join(WORKBENCH), ['.js']);
  let checked = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s+'(\.[^']*)'/g)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      assert.equal(fs.existsSync(resolved), true, `${path.relative(WORKBENCH, file)} 引用了不存在的 ${match[1]}`);
      checked += 1;
    }
  }
  assert.ok(checked > 30, `只核到 ${checked} 条相对 import，walk 大概坏了`);
});

test('AC2d 订单列表的三份单子：补充信息单 / 待交割单 / 售后列表（判据只用既有字段）', async () => {
  const modules = loadFrontendModules();
  const [frontConfig, orders] = await Promise.all([modules.ordersConfig, modules.orders]);

  assert.deepEqual(frontConfig.SALES_SECTIONS.map((section) => [section.key, section.label]), [
    ['supplement', '补充信息单'], ['pending', '待交割单'], ['afterSales', '售后列表'],
  ], '三份单子与顺序 = 业务负责人 2026-10-09 给的那一行');

  const base = {
    record_id: 'order_1',
    order_no: 'XSD-20261009-0001',
    fulfillment_status: '部分交付',
    payment_status: '部分收款',
    details: [{ record_id: 'd1', product: 'XHB8095', size: 38, actual_amount: 89, fulfillment_status: '已交付' }],
  };
  // 钱货两清（履约「已交付」且收款「已收款」）→ 售后列表
  assert.equal(orders.salesSectionOf({ ...base, fulfillment_status: '已交付', payment_status: '已收款' }), 'afterSales');
  // 信息齐、但货 / 钱没结清 → 待交割单
  assert.equal(orders.salesSectionOf(base), 'pending');
  // 信息还没填全（缺成交金额 / 缺尺码 / 状态读不出来）→ 补充信息单（她说的"可后续补"就落这里）
  assert.equal(orders.salesSectionOf({ ...base, details: [{ record_id: 'd1', product: 'X', size: 38 }] }), 'supplement');
  assert.equal(orders.salesSectionOf({ ...base, details: [{ record_id: 'd1', product: 'X', actual_amount: 1 }] }), 'supplement');
  assert.equal(orders.salesSectionOf({ ...base, payment_status: '' }), 'supplement');

  // 三份单子**不重不漏**：一份一份渲染出来，条数加总 = 全部
  const list = [
    base, { ...base, record_id: 'o2', fulfillment_status: '已交付', payment_status: '已收款' },
    { ...base, record_id: 'o3', details: [{ record_id: 'd3', product: 'X', size: 40 }] },
  ];
  const html = orders.ordersSectionsHtml(list);
  for (const key of ['supplement', 'pending', 'afterSales']) {
    assert.ok(html.includes(`data-sales-section="${key}"`), `缺 ${key} 这一段`);
  }
  // 每一段的条数（只看**段头**那一个 `· N 单`；待交割单里面还有三类小标题，别数错）
  const counts = html.split('data-sales-section="').slice(1)
    .map((chunk) => Number((chunk.match(/· (\d+) 单/) || [])[1]));
  assert.deepEqual(counts, [1, 1, 1], '每一段各一单（不重不漏）');
  // ⭐ 三份单子各带一个**彩色小标签**（她 2026-10-09：状态用彩色小标签）
  assert.deepEqual(frontConfig.SALES_SECTIONS.map((section) => section.tag), ['待补充', '待交割', '已两清']);
  for (const tag of ['待补充', '待交割', '已两清']) {
    assert.ok(new RegExp(`class="tag[^"]*"[^>]*>\\s*${tag}`).test(html), `段头上要有「${tag}」小标签`);
  }
  // 「待交割单」里保留既有的三类细分（她 2026-10-09 上半场定的那三类没丢）
  assert.ok(html.includes('data-sales-group="undelivered"') || html.includes('data-sales-group="unpaid"') || html.includes('data-sales-group="both"'));
  assert.ok(!/<table/i.test(html), '三份单子也不用表格（移动端）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 旧功能仍可达（「其它 / 历史功能」页）
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 旧功能一个都没丢：页脚 →「其它 / 历史功能」页里能点到（含原「信息录入」首页与「采购管理」）', async () => {
  const modules = loadFrontendModules();
  const [config, othersHtml, home, commonHtml] = await Promise.all([
    modules.othersConfig,
    render(modules.othersIndex, 'createOthersModule'),
    modules.home,
    render(modules.common, 'createCommonModule'),
  ]);

  // ① 清单里就是这些遗留入口，且 **href 逐字**（老链接照旧）
  assert.deepEqual(config.LEGACY_ENTRIES.map((entry) => entry.href), [
    '/workbench/common.html',
    '/workbench/purchase.html',
    '/workbench/inventory-adjustment.html',
    '/workbench/purchase-return.html',
    '/workbench/label-print.html',
  ], '五个遗留入口都在「其它」页里（信息录入首页 / 采购管理 / 三个独立页）');

  // ② 渲染出来真的能点（是 <a href>，不是死文案）
  for (const entry of config.LEGACY_ENTRIES) {
    assert.ok(othersHtml.includes(`href="${entry.href}"`), `「其它」页里必须有能点的 ${entry.href}`);
  }
  assert.ok(othersHtml.includes('其它 / 历史功能'), '页面标题');

  // ③ 那个独立页真的存在、也真的注册进了既有启动器（不是只写了个链接）
  for (const page of ['others.html', 'purchase.html', 'common.html', 'inventory-adjustment.html', 'purchase-return.html', 'label-print.html']) {
    assert.equal(workbenchHas(page), true, `${page} 必须存在（旧入口不许因为换 tab 就失效）`);
  }
  const standalone = readWorkbench('standalone.js');
  for (const view of ["others: () => createOthersModule()", "purchase: () => createPurchaseModule()", 'common:', "'inventory-adjustment':", "'purchase-return':", "'label-print': () => createLabelPrintModule()"]) {
    assert.ok(standalone.includes(view), `standalone.js 必须注册 ${view}`);
  }
  assert.ok(!standalone.includes("'sales-query'") && !standalone.includes("'inventory':"),
    '自建的销售 / 库存查询视图仍然不许回来（她 2026-10-08：那两个接口顺手删掉）');

  // ④ 原「信息录入（常用功能）」的内容逐字还在（报货与退货 / 库存手工调整 / 鞋盒标签打印）
  assert.deepEqual(home.COMMON_ENTRIES.map((entry) => entry.title), ['报货与退货', '库存手工调整', '鞋盒标签打印']);
  assert.deepEqual((commonHtml.match(/<h3>([\s\S]*?)<\/h3>/g) || []).map((item) => item.replace(/<\/?h3>/g, '')),
    ['报货与退货', '库存手工调整', '鞋盒标签打印'], '旧首页渲染出来的卡片一张都没少');

  // ⑤ 占位的三个模块：模块代码仍在 main.js（`modules` 表里），「其它」页如实列出，两边文案一致
  const main = readWorkbench('main.js');
  for (const module of config.PLANNED_MODULES) {
    assert.ok(main.includes(`'${module.id}', createPlaceholderModule({`), `main.js 里 ${module.id} 的占位模块必须保留（代码不删）`);
    assert.ok(main.includes(module.desc), `${module.id} 的说明要与 config/others.js 逐字一致`);
    assert.ok(othersHtml.includes(module.title), `「其它」页要列出 ${module.title}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 移动端哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 移动端哨兵：viewport / 默认单列 / 无 table / ≥44px / 无固定 min-width / 断行 / 桌面自适应', async () => {
  const indexHtml = readWorkbench('index.html');
  assert.match(indexHtml, /<meta name="viewport" content="width=device-width, initial-scale=1[^"]*">/, '必须有移动端 viewport');

  const base = readWorkbench('styles/base.css');
  const domainsCss = readWorkbench('features/domains/domains.css');
  const ordersCss = readWorkbench('features/orders/orders.css');

  // ① 移动优先：**默认**就是单列，桌面才铺多列（反过来写会漏掉手机）
  assert.match(base, /\.quick-entries,\s*\.domain-cards\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    'base.css 默认必须是单列（移动优先）');
  assert.match(base, /@media\s*\(min-width:\s*761px\)/, '桌面自适应要有 @media (min-width: 761px) 那一层');
  assert.match(base, /html,\s*body\s*\{\s*max-width:\s*100%;\s*overflow-x:\s*hidden;\s*\}/, '整页不许横向滚动');

  // ② 按钮 / 输入框 ≥44px（值在主题里：--control-height）
  const tokens = readWorkbench('styles/tokens.css');
  assert.match(tokens, /--control-height:\s*44px;/, '44px 命中区必须来自主题变量');
  assert.match(base, /min-height:\s*var\(--control-height\)/, 'base.css 的控件要用这个变量');
  assert.match(base, /\.btn,\s*input,\s*select\s*\{[^}]*min-height:\s*var\(--control-height\)/,
    '按钮 / 输入框 ≥44px 命中区（值来自主题变量）');
  assert.match(domainsCss, /\.card-button/, '「跳到另一个子页」的卡片也要是整行可点的按钮');

  // ③ 长文本断行、无固定 min-width、无表格版式
  assert.match(base, /overflow-wrap:\s*anywhere/, '长单号 / 长货号必须能断行');
  for (const [name, css] of [['base.css', base], ['domains.css', domainsCss], ['orders.css', ordersCss]]) {
    // ⚠️ 先去媒体查询的前导（`@media (min-width: 761px)` 里的断点不算"写死的 min-width"）
    const noMedia = css.replace(/@media[^{]+\{/g, '{');
    assert.ok(!/min-width:\s*\d{3,}px/.test(noMedia), `${name} 不许有 ≥100px 的固定 min-width（会挤横向滚动条）`);
  }
  // 四个领域与订单列表**一律不用表格**（base.css 里那几条 table 规则是给「其它」里的旧查询页用的）
  for (const [name, css] of [['domains.css', domainsCss], ['orders.css', ordersCss]]) {
    assert.ok(!/<table|table\s*\{/.test(css), `${name} 不许出现表格版式`);
  }

  // ④ 渲染出来的领域页里也没有 <table> / 超宽内联宽度
  const modules = loadFrontendModules();
  const [domains, nav, pagesModule] = await Promise.all([modules.domains, modules.domainNav, modules.domainPages]);
  const html = domains.DOMAIN_TABS.flatMap((domain) => [
    nav.domainSubTabsHtml(domain),
    ...domain.pages.filter((page) => ['entry', 'links', 'query'].includes(page.kind)).map((page) => nav.domainPageHtml(page)),
  ]).join('\n');
  assert.ok(html.length > 500, '四个领域的静态子页都渲染了');
  assert.ok(!/<table/i.test(html), '领域页不许用 <table>（手机上会横向滚动）');
  assert.ok(!/min-width:\s*\d{3,}px/.test(html), '领域页不许内联超宽固定宽度');
  assert.ok(pagesModule.entryPageHtml(domains.domainById('sales').pages[0]).includes('entry-open'), '入口页用单列表单');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 扫码页领域切换（?from= 四个值 + 缺省销售）
// ═══════════════════════════════════════════════════════════════════════════

const SCAN_VIEW = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }, { count: 0 }, { count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 0 }, { count: 0 }, { count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ count: 1 }, { count: 1 }, { count: 0 }], total: 2, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: ['缺码说明'],
  updated_at_text: '2026-10-08 20:30',
};

/** 一个最小的 write 上下文（字段名 / 动作 / 文案都照 config/scanWrite.js 的形状）。 */
const SCAN_WRITE = {
  enabled: true,
  texts: {
    saleHeading: '销售（可以连着扫，最后一起提交）',
    draftHeading: '本单现在 {count} 双',
    draftEmpty: '本单还没有鞋',
    draftItem: '{itemNo} {size} 码',
    sizeLabel: '尺码',
    sizePlaceholder: '这一款没有可用尺码',
    amountLabel: '成交金额',
    amountPlaceholder: '不填按单价算',
    giftLabel: '赠品',
    addButton: '加入本单',
    paymentLabel: '收款方式',
    paymentAmountLabel: '收款金额',
    paymentAmountPlaceholder: '不填就是还没收钱',
    submitButton: '提交这一单',
    fundsPendingNote: '资金不是必填，之后可以在订单列表里补',
    clearButton: '清空本单',
    replenishHeading: '补货报单（勾选要补的尺码）',
    replenishHint: '缺码的尺码已经勾上了',
    replenishQuantityLabel: '数量',
    replenishButton: '提交补货',
  },
  fields: {
    action: 'action',
    submitKey: 'submit_key',
    size: 'size',
    amount: 'amount',
    gift: 'gift',
    paymentMethod: 'payment_method',
    paymentAmount: 'payment_amount',
    replenishSizes: 'sizes',
    replenishQuantityPrefix: 'qty_',
  },
  actions: { addLine: 'add_line', submitOrder: 'submit_order', clearDraft: 'clear_draft', replenish: 'replenish' },
  postAction: '/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA',
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  notice: '',
};

test('AC5 扫码页领域切换：?from= 四个值 + 缺省销售，切到哪个领域只显示那个领域的操作', () => {
  const { renderScanPage, STYLE } = require('../src/views/scanPageRenderer');
  const { REALMS, DEFAULT_REALM, resolveRealm, labelPrintUrls } = require('../src/views/scanPageRealm');
  const { SCAN_PAGE } = require('../src/config/scanPage');

  // ① 路由没变：GET /s/:number
  assert.equal(SCAN_PAGE.route.basePath, '/s');
  assert.equal(SCAN_PAGE.route.path, '/:number');

  // ② 四个领域 = 与一级 tab 同序；缺省 = 销售；认不出的值一律回落（不报错）
  assert.deepEqual(REALMS.map((realm) => realm.id), ['sales', 'inventory', 'purchase', 'product']);
  assert.deepEqual(REALMS.map((realm) => realm.label), ['销售', '库存', '采购', '货品']);
  assert.equal(DEFAULT_REALM, 'sales', '缺省 = 销售（她的口径）');
  for (const id of ['sales', 'inventory', 'purchase', 'product']) assert.equal(resolveRealm(id), id);
  for (const bad of [undefined, null, '', '   ', 'bogus', 'SALES2', '库存']) {
    assert.equal(resolveRealm(bad), 'sales', `认不出的 from「${String(bad)}」必须回落销售，不许报错`);
  }

  // ③ 顶部那一排领域按钮：四个值都在，URL 就是 ?from=<id>
  const html = renderScanPage(SCAN_VIEW, SCAN_PAGE, SCAN_WRITE);
  for (const id of ['sales', 'inventory', 'purchase', 'product']) {
    assert.ok(html.includes(`href="?from=${id}"`), `顶部必须有 ?from=${id} 的领域按钮`);
    assert.ok(html.includes(`data-realm-id="${id}"`), '领域按钮的标记（高亮由 CSS 按 data-realm 决定）');
  }

  // ④ 四个领域的操作块都渲染进 HTML，靠 CSS 只显示当前领域
  for (const id of ['sales', 'inventory', 'purchase', 'product']) {
    assert.ok(html.includes(`realm-block--${id}`), `缺 ${id} 领域的内容块`);
  }
  assert.ok(/html\[data-realm="sales"\] \.realm-block--sales \{ display: block; \}/.test(STYLE), '当前领域那一块要显示');
  assert.ok(/\.realm-block--sales, \.realm-block--inventory, \.realm-block--purchase, \.realm-block--product \{ display: none; \}/.test(STYLE),
    '其余领域默认不显示');
  assert.ok(/html:not\(\[data-realm\]\) \.realm-block \{ display: block; \}/.test(STYLE),
    '没 JS（没有 data-realm）时四块全显示 —— 绝不白屏');

  // ⑤ `data-realm` 由 <head> 里那一小段脚本在 body 解析前设好；缺省写的就是销售
  assert.match(html, /<head>[\s\S]*data-realm[\s\S]*<\/head>/, '领域判定脚本必须在 <head> 里（不然会闪一下四块全显示）');
  assert.ok(html.includes('"sales","inventory","purchase","product"'), '脚本里的四个 id 从配置生成（加减领域只改一个文件）');
  assert.match(html, /indexOf\(raw\)>=0\?raw:"sales"/, '缺省 = 销售');
  assert.match(html, /location\.search/, '从 ?from= 读（她给的参数名就是这个）');

  // ⑥ 各领域的操作确实按领域分开：销售 = 建单表单；库存 = 库存表；采购 = 补货报单；货品 = 标签
  //    ⚠️ 只看 <body>（`<style>` 里也有 `realm-block--…` 这些选择器，别切到 CSS 上）
  const body = html.slice(html.indexOf('</head>'));
  const blockOf = (id) => {
    const start = body.indexOf(`realm-block--${id}`);
    assert.ok(start > -1, `缺 ${id} 块`);
    const next = ['sales', 'inventory', 'purchase', 'product']
      .map((other) => body.indexOf(`realm-block--${other}`, start + 1))
      .filter((index) => index > -1).sort((left, right) => left - right)[0] ?? body.length;
    return body.slice(start, next);
  };
  assert.ok(blockOf('sales').includes('加入本单') && blockOf('sales').includes('提交这一单'), '销售领域 = 销售建单');
  assert.ok(blockOf('sales').includes('资金不是必填'), '她说的「资金等非必填、可后续补」要在页面上写着');
  assert.ok(blockOf('inventory').includes('库存（共 3 双）'), '库存领域 = 库存查询（库存表）');
  assert.ok(blockOf('purchase').includes('补货报单（勾选要补的尺码）'), '采购领域 = 采购报货');
  assert.ok(blockOf('product').includes('货品标签'), '货品领域 = 货品标签');

  // ⑦ 货品标签 = 既有标签打印页（单个带货号 / 批量），没有重做打印
  assert.deepEqual(labelPrintUrls(SCAN_VIEW), {
    single: '/workbench/label-print.html?keyword=YD6693-2',
    batch: '/workbench/label-print.html',
  });
  assert.ok(blockOf('product').includes('href="/workbench/label-print.html?keyword=YD6693-2"'));

  // ⑧ 结果页（写成功 / 写失败 / 没找到…）不挂领域切换条，也没有 realm 块
  const { renderScanMessagePage } = require('../src/views/scanPageRenderer');
  const message = renderScanMessagePage({ title: '没找到这个编号', body: '可能已删除、或编号变了。', number: 'NOPE|黑色|A', requestId: 'req_1' });
  const messageBody = message.slice(message.indexOf('</head>'));
  assert.ok(!messageBody.includes('realm-bar'), '结果页不挂领域切换');
  assert.ok(!messageBody.includes('data-realm'), '结果页不注入领域脚本（脚本只在 <head> 里出现）');
  assert.ok(message.includes('没找到这个编号'), '结果页内容照旧');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 主题变量集中在一处
// ═══════════════════════════════════════════════════════════════════════════

test('AC6 主题变量集中在一处：配色 / 间距 / 圆角 / 字号全在 styles/tokens.css', () => {
  const tokens = readWorkbench('styles/tokens.css');

  // ① 四族令牌都在（改外观时按族找）
  for (const [family, pattern] of [
    ['配色', /--primary:\s*#[0-9a-f]{6};/i],
    ['间距', /--space-4:\s*16px;/],
    ['圆角', /--radius-md:\s*12px;/],
    ['字号', /--font-size-base:\s*16px;/],
    ['命中区', /--control-height:\s*44px;/],
  ]) {
    assert.match(tokens, pattern, `tokens.css 必须定义${family}的那一族令牌`);
  }

  // ② 除主题文件外，工作台 CSS **一个十六进制颜色都不许有**（只用 var(--…)）
  const cssFiles = walk(path.join(WORKBENCH), ['.css']).filter((file) => !file.endsWith(path.join('styles', 'tokens.css')));
  assert.ok(cssFiles.length >= 5, '扫到的 CSS 太少了，walk 大概坏了');
  for (const file of cssFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepEqual(hex, [], `${path.relative(WORKBENCH, file)} 里还有写死的颜色 ${hex.join(' ')}（颜色只能来自 tokens.css）`);
  }

  // ③ 主色字面量在整个工作台静态资源里只出现一次（就在主题文件里）
  const owners = walk(path.join(WORKBENCH), ['.css', '.js', '.html'])
    .filter((file) => fs.readFileSync(file, 'utf8').includes('#185abd'))
    .map((file) => path.relative(WORKBENCH, file));
  assert.deepEqual(owners, [path.join('styles', 'tokens.css')], '主色的字面量只许出现在主题文件里');

  // ④ 扫码页把**同一份**令牌内联进 :root（改 tokens.css ⇒ 工作台与扫码页一起变）
  const { STYLE, readThemeTokens } = require('../src/views/scanPageRenderer');
  const parsed = readThemeTokens();
  assert.ok(parsed.length >= 30, `从 tokens.css 解析出来的令牌太少了：${parsed.length}`);
  assert.ok(parsed.includes('--primary: #185abd;'), '主色要原样来自 tokens.css');
  assert.match(STYLE, /:root \{\ncolor-scheme: light;\n--font-family:/, '扫码页 :root 里就是 tokens.css 那一份令牌');
  assert.ok(STYLE.includes('--primary: #185abd;'), '主色原样来自 tokens.css（没有第二份硬编码）');
  assert.match(STYLE, /background: var\(--background\)/, '扫码页的颜色也走变量');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 既有扫码页与标签用例不受影响
// ═══════════════════════════════════════════════════════════════════════════

test('AC7 既有扫码页 / 标签打印的用例文件都在，且它们钉住的 HTML 片段逐字还在', () => {
  // ① 那几个用例文件（"51+ 条"的载体）必须还在 —— 谁都不许删别人的哨兵用例
  for (const file of [
    'scanPage.test.js', 'scanPageRoute.test.js', 'scanPageFastRead.test.js',
    'scanPageWrite.test.js', 'scanPageAuthRedirect.test.js',
    'labelPrintRender.test.js', 'labelPrintRoute.test.js', 'labelPrintService.test.js',
  ]) {
    assert.equal(fs.existsSync(path.join(__dirname, file)), true, `${file} 必须还在`);
  }

  // ② 扫码页 200 的那一页：既有片段逐字还在（领域切换只是把不相关的那块 CSS 隐藏起来）
  const { renderScanPage, renderScanMessagePage } = require('../src/views/scanPageRenderer');
  const { SCAN_PAGE } = require('../src/config/scanPage');
  const html = renderScanPage(SCAN_VIEW, SCAN_PAGE, SCAN_WRITE);
  for (const needle of [
    'YD6693-2', '黑色 · 休闲鞋', '¥399', '库存（共 3 双）',
    '<th>门盒</th><th>样品</th><th>仓库</th>', 'class="missing"', '⚠️ 缺', '<td class="zero">—</td>',
    // 两个写入口（scanPageWrite.test.js 断言的就是它们同时在这份 HTML 里）
    '销售（可以连着扫，最后一起提交）', '补货报单（勾选要补的尺码）',
    '<option value="微信" selected>微信</option>', 'name="sizes" value="41" checked',
    'name="submit_key" value="scan_sale:scan_session_0123456789abcdef:1"',
    'name="submit_key" value="scan_replenish:scan_session_0123456789abcdef:1"',
  ]) {
    assert.ok(html.includes(needle), `扫码页少了既有片段：${needle}`);
  }

  // ③ 结果页（写失败 / 没找到）逐字不变
  const failed = renderScanMessagePage({ title: '这一步没成功', body: '系统这边没处理成功', requestId: 'req_2', retryHint: '可以照上面那句话改一下再点一次' }, SCAN_PAGE);
  assert.ok(failed.includes('这一步没成功') && failed.includes('可以照上面那句话改一下再点一次'));
  assert.ok(!failed.includes('未配置语义字段'), '内部细节不许回显（既有口径）');

  // ④ 标签打印页的接线一个字没动（standalone.js 的注册行 / 页面 / 模块 / 首页那张卡）
  assert.match(readWorkbench('standalone.js'), /'label-print': \(\) => createLabelPrintModule\(\)/);
  assert.match(readWorkbench('label-print.html'), /data-view="label-print"/);
  assert.equal((readWorkbench('features/labels/index.js').match(/api\.get\(/g) || []).length, 1,
    '标签打印页仍然只发一次只读请求（新增的 ?keyword= 只是预填筛选框，不新增请求）');
  assert.match(readWorkbench('config/home.js'), /title: '鞋盒标签打印'/);

  // ⑤ 自建的销售 / 库存查询页面与模块仍然不许回来（2026-10-08 删掉的那两条）
  for (const gone of ['sales-query.html', 'sales-today.html', 'inventory.html', 'features/sales/index.js', 'features/inventory/index.js']) {
    assert.equal(workbenchHas(gone), false, `${gone} 必须仍然不存在`);
  }
  const routes = stripComments(readSrc('routes/scanPage.js'));
  assert.ok(routes.includes('router.get(config.route.path'), '扫码路由仍是既有那一条');
  assert.ok(!/query\.from|req\.query\.from/.test(routes), '领域切换没有走路由：四块都渲染进 HTML，由 CSS 只显示当前领域');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC8 三个占位页统一「待建设」
// ═══════════════════════════════════════════════════════════════════════════

test('AC8 三个占位页统一写「待建设」：客户往来款 / 采购订单列表 / 供应商往来款', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, placeholder] = await Promise.all([
    modules.domains, modules.domainNav, modules.placeholder,
  ]);
  const byId = new Map(domains.DOMAIN_TABS.map((domain) => [domain.id, domain]));
  const pages = [
    byId.get('sales').pages.find((page) => page.id === 'sales-customer-money'),
    byId.get('purchase').pages.find((page) => page.id === 'purchase-orders'),
    byId.get('purchase').pages.find((page) => page.id === 'purchase-supplier-money'),
  ];
  assert.equal(placeholder.PLACEHOLDER_STATUS, '待建设', '占位页统一那一句 = 「待建设」');
  assert.deepEqual(pages.map((page) => page.label), ['客户往来款', '采购订单列表', '供应商往来款']);

  for (const page of pages) {
    const html = nav.domainPageHtml(page);
    assert.ok(html.includes('data-page-kind="placeholder"'), `${page.label} 要按占位页渲染`);
    assert.ok(html.includes('<h3 class="section-title">'), `${page.label} 要有标题`);
    assert.ok(html.includes(placeholder.PLACEHOLDER_STATUS), `${page.label} 要写「待建设」`);
    assert.ok(page.note && html.includes(page.note), `${page.label} 要注明将来放什么`);
    assert.ok(html.includes('class="tag'), `${page.label} 要有彩色小标签（状态标记）`);
    // 移动端哨兵同样适用于新页面
    assert.ok(!/<table/i.test(html), `${page.label} 不许用表格`);
    assert.ok(!/min-width:\s*\d{3,}px/.test(html), `${page.label} 不许内联超宽固定宽度`);
  }
  // 采购订单列表 = 她点名的"未来放 AI 页面"
  assert.match(nav.domainPageHtml(pages[1]), /AI 页面/, '采购订单列表要写明将来放 AI 页面');
  // 子 tab 上也能点得到这三个占位页
  const salesTabs = nav.domainSubTabsHtml(byId.get('sales'));
  assert.ok(salesTabs.includes('>客户往来款</button>'));
  const purchaseTabs = nav.domainSubTabsHtml(byId.get('purchase'));
  assert.ok(purchaseTabs.includes('>采购订单列表</button>') && purchaseTabs.includes('>供应商往来款</button>'));
  // 占位页的 kind 是配置驱动的（渲染层认不出来时不留白屏）
  assert.equal(nav.domainPageHtml({ id: 'x', kind: 'unknown-kind', label: 'x' }), '');

  // AC6 哨兵对占位页同样成立：配色只用令牌（domains.css 里没有十六进制颜色）
  const css = readWorkbench('features/domains/domains.css');
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  assert.ok(css.includes('.placeholder-card'), '占位卡要有自己的样式（白卡片 + 圆角）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC9 「验收到货」入口：在「采购 → 报货 / 验收 / 退货」里（内嵌既有订单模块）
// ═══════════════════════════════════════════════════════════════════════════

test('AC9 「验收到货」入口搬进「采购 → 报货 / 验收 / 退货」：内嵌既有 orders 的 purchase 模式', async () => {
  const modules = loadFrontendModules();
  const domains = await modules.domains;
  const purchase = domains.domainById('purchase');
  const report = purchase.pages.find((page) => page.id === 'purchase-report');

  // ① 配置：这一页有一张锚点卡 + 一个内嵌验收块（模块 / 模式都写在配置里）
  assert.deepEqual(
    [report.embed.id, report.embed.module, report.embed.mode],
    ['purchase-arrival', 'orders', 'purchase'],
    '验收块 = 既有订单模块的 purchase 模式（配置先行）',
  );
  assert.ok(report.embed.title && report.embed.subtitle, '验收块自带标题与一句说明（文案在配置里）');
  assert.equal(report.cards.find((card) => card.title === '验收到货').anchor, '#purchase-arrival');

  // ② 渲染层：把既有模块挂进宿主（**一行新验收逻辑都没有**）
  const index = stripComments(readWorkbench('features/domains/index.js'));
  assert.ok(index.includes("page.embed?.module === 'orders'"), '内嵌 = 认配置里的 module');
  assert.ok(index.includes('createOrdersModule({ mode: page.embed.mode })'), '挂的是既有订单模块（模式来自配置）');
  assert.ok(!/\bfetch\s*\(/.test(index), '领域骨架自己不发请求');

  // ③ 既有的验收逻辑与接口一个字都没删（一批一批点 → 走既有入库链路）
  const orders = readWorkbench('features/orders/index.js');
  for (const needle of ['verify-arrival', 'submit-arrival', 'submitArrival', 'arrivalConfirm']) {
    assert.ok(orders.includes(needle), `既有验收逻辑少了 ${needle}`);
  }
  assert.match(readWorkbench('config/orders.js'), /arrivalConfirm: '\/api\/workbench\/purchase\/arrivals\/confirm'/);

  // ④ 采购订单列表那一页**不再**挂订单模块（她说的"占位页"）
  assert.equal(purchase.pages.find((page) => page.id === 'purchase-orders').kind, 'placeholder');
  assert.equal(purchase.pages.some((page) => page.kind === 'orders'), false);
});
