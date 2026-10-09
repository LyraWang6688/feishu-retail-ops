/**
 * 工作台一级 tab：**3 个 → 2 个**（信息录入 ＋ 信息查询）＋「信息查询」两个板块 = 两张**外链卡**。
 *
 * ⭐ 业务负责人 2026-10-08（逐字）：
 *   「目前我们分了**三个 tab 页**：销售查询、库存查询还有常用功能。现在需要你**整合成两个 tab 页**：
 *    **1. 信息录入**：实际上就是"常用功能"，把那个 tab 页的名字改一下就行
 *    **2. 信息查询**：整合已有的两个 tab 页，放到同一个 tab 页里的**两个板块**，即"销售查询"和"库存查询"」
 *   「目前我采用的并不是我们自己搭建的页面，而是**多维表格里的页面**……**销售查询和库存查询点开也是
 *    多维表格上的一个网页**。⇒ 在这个维度上我们**不用自己搭建接口**」
 *   「现有的**我们自己搭的**销售查询/库存查询页面与接口（`/api/workbench/*`），**顺手删掉**～」
 *
 * 做法与 `workbenchHomeEntries.test.js` / `workbenchAuth401.test.js` 同一套：
 * 把前端那几个 ES 模块复制成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）真的当模块跑起来，
 * 用只实现 `innerHTML` 的假容器接住 `mount()` 的输出，断言**真正渲染出来的 DOM**。
 *
 * 口径 / 验收标准 / 逐条对照：`docs/workbench-two-tabs-and-external-query-2026-10-08.md`。
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

/** 去掉注释再对"代码里有没有残留"下结论 —— 注释里提一句历史不算引用（别把说明当孤儿）。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 「信息查询」两张卡的 arrow 文案（配置为空值时的明确行为）。 */
const LINK_PENDING = '链接待配置';

/**
 * 业务负责人 2026-10-08 定稿的**两条**URL（逐字）—— 她原话：
 * 「我们的URL就是用的这两个，**严禁你换成别的**」。
 * ⚠️ 两条都是**发布分享链接**（`/share/base/webpage/<shareId>`）；
 *    不要改成内部页面 URL（`/base/<appToken>?table=<页面id>`）。
 * 页面口径与系统口径的对照留档在 `docs/sales-query-page-and-system-caliber-2026-10-08.md`。
 */
const SALES_QUERY_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnY3ZG9LAjrArEe5RzfS8UGh';

/** 「库存查询」URL（逐字，同一条消息里给的）。 */
const INVENTORY_QUERY_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnaSFKbJAci7YxvC1AXpweBc';

/**
 * 把要跑的前端模块复制成 `.mjs` 平铺到一个临时目录，**只把 import 的文件名改成复制后的名字**
 * （源码逻辑一个字不改）。每一条替换都必须命中 —— 命不中说明源码的 import 变了，测试要跟着更新。
 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-tabs-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/tabs.js', 'tabs.mjs');
  copy('core/tabs.js', 'core-tabs.mjs', [["from '../config/tabs.js'", "from './tabs.mjs'"]]);
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('config/home.js', 'home.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('core/formatters.js', 'formatters.mjs');
  copy('features/query/index.js', 'query-index.mjs', [
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/common/index.js', 'common.mjs', [
    ["from '../../config/home.js'", "from './home.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    tabs: load('tabs'),
    coreTabs: load('core-tabs'),
    links: load('links'),
    query: load('query'),
    home: load('home'),
    queryIndex: load('query-index'),
    common: load('common'),
  };
}

/** 用假容器渲染一个模块，返回它写进去的 HTML（`mount()` 只写 innerHTML，不需要真 DOM）。 */
async function render(modulePromise, factoryName, options) {
  const module = await modulePromise;
  const container = { innerHTML: '' };
  module[factoryName](options).mount(container);
  return container.innerHTML;
}

/**
 * 把「信息查询」的卡片解析成结构化清单（顺序 = DOM 顺序）。
 * ⚠️ **两种形状都要认**：有 URL 时是 `<a class="entry-card" href=… rel="noopener">`，
 *    空 URL 时是 `<div class="entry-card disabled-card">`（**故意不是 `<a>`** —— 不许产生空 href）。
 * ⚠️ 卡体里**自己还有 `<div>`**（icon / arrow），所以按"下一张卡的起点"切块，
 *    不能用"非贪婪匹配到第一个 `</div>`"（那会停在 icon 上）。
 */
function parseEntryBlocks(html) {
  const starts = [...html.matchAll(/<(a|div) class="(entry-card[^"]*)"([^>]*)>/g)];
  return starts.map((match, index) => {
    const chunk = html.slice(match.index, index + 1 < starts.length ? starts[index + 1].index : html.length);
    return {
      tag: match[1],
      classes: match[2],
      attrs: match[3],
      href: match[3].match(/\shref="([^"]*)"/)?.[1] ?? null,
      title: chunk.match(/<h3>([\s\S]*?)<\/h3>/)?.[1],
      arrow: chunk.match(/<div class="arrow">([\s\S]*?)<\/div>/)?.[1],
    };
  });
}

// ── AC1：一级 tab ────────────────────────────────────────────────────────────
// ⚠️ 2026-10-09 修订（**不是把 2026-10-08 的口径推翻**）：业务负责人当天要的
//    「订单列表」是**新增的第三个**一级 tab —— 前两个（信息录入 / 信息查询）**一个字没动**
//    （信息查询仍然是飞书外链卡，没有自建查询接口）。
//    她的原话：「我们建一个**订单列表**吧……订单列表实际上就是**看销售情况**」。
//    ⇒ 这条断言从"只有 2 个"改成"前两个逐字不变 + 末尾追加「订单列表」"。
//    新 tab 自己的验收标准在 `test/workbenchOrders.test.js`（AC1–AC8）。

test('AC1 一级 tab：前两个逐字「信息录入」「信息查询」不变，2026-10-09 末尾追加「订单列表」', async () => {
  const modules = loadFrontendModules();
  const [tabs, coreTabs] = await Promise.all([modules.tabs, modules.coreTabs]);

  assert.deepEqual(tabs.MAIN_TABS, [
    { module: 'common', label: '信息录入' },
    { module: 'query', label: '信息查询' },
    { module: 'orders', label: '订单列表' },
  ], '前两个 tab 逐字不变；2026-10-09 追加「订单列表」（文案的单一来源仍是 config/tabs.js）');

  const html = coreTabs.mainTabsHtml();
  const buttons = [...html.matchAll(/<button class="([^"]*)" type="button" data-module="([^"]*)">([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 3, 'nav 里 3 个 tab 按钮（信息录入 / 信息查询 / 订单列表）');
  assert.deepEqual(buttons.slice(0, 2).map((button) => button[3]), ['信息录入', '信息查询'], '前两个 tab 文案逐字不变');
  assert.deepEqual(buttons.map((button) => button[3]), ['信息录入', '信息查询', '订单列表']);
  assert.deepEqual(buttons.map((button) => button[2]), ['common', 'query', 'orders'], 'data-module 仍是既有机制');
  assert.ok(buttons[0][1].includes('active'), '默认打开的 tab = 第一个（信息录入，与 2026-10-08 一致）');
  assert.ok(!buttons[1][1].includes('active') && !buttons[2][1].includes('active'), '只有第一个带 active');
});

test('AC1b index.html：nav 留空（文案不在 HTML 里再写一遍）、不再加载已删的销售/库存样式', () => {
  const html = readWorkbench('index.html');
  const nav = html.match(/<nav id="main-tabs"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'index.html 必须仍有 <nav id="main-tabs">');
  assert.ok(!/<button/.test(nav[0]) && !/data-module=/.test(nav[0]),
    'index.html 里不许再硬编码 main-tab 按钮 —— 文案的单一来源是 config/tabs.js（配置先行）');
  for (const gone of ['销售查询', '实时库存', '常用功能']) {
    assert.ok(!nav[0].includes(gone), `nav 里不许再有旧 tab 文案「${gone}」`);
  }
  assert.ok(!html.includes('features/sales/sales.css'), '销售查询样式已随页面一起删');
  assert.ok(!html.includes('features/inventory/inventory.css'), '实时库存样式已随页面一起删');
});

// ── AC3 / AC4 / AC5：信息查询的两个板块 = 两张外链卡 ──────────────────────────

test('AC3 信息查询 = 两个板块：销售查询 / 库存查询，各一张卡', async () => {
  const modules = loadFrontendModules();
  const [query, html] = await Promise.all([
    modules.query,
    render(modules.queryIndex, 'createQueryModule'),
  ]);

  assert.deepEqual(query.QUERY_SECTIONS.map((section) => section.title), ['销售查询', '库存查询'],
    '「信息查询」里必须正好是这两个板块，顺序也是这个');
  const blocks = parseEntryBlocks(html);
  assert.deepEqual(blocks.map((block) => block.title), ['销售查询', '库存查询'],
    '两个板块各一张卡（渲染出来的标题逐字）');
  assert.ok(html.includes('信息查询'), '面板标题 = 信息查询');
});

test('AC4 href 单一来源 config/links.js：config/query.js 只 import、渲染层不写死 URL', () => {
  const queryConfig = readWorkbench('config/query.js');
  assert.ok(queryConfig.includes("from './links.js'"),
    'config/query.js 必须 import config/links.js（URL 单一来源，不复制字面量）');
  for (const file of ['config/query.js', 'features/query/index.js']) {
    assert.ok(!/feishu\.cn/.test(readWorkbench(file)), `${file} 里不许出现飞书 URL 字面量`);
  }
  const links = readWorkbench('config/links.js');
  for (const key of ['SALES_QUERY_PAGE_URL', 'INVENTORY_QUERY_PAGE_URL']) {
    assert.ok(new RegExp(`export const ${key}`).test(links), `config/links.js 必须有 ${key}（与 PURCHASE_REQUEST_FORM_URL 同一套写法）`);
  }
  assert.ok(!/TODO\(业务负责人\): 库存查询/.test(links),
    '库存查询 URL 她 2026-10-08 已给 ⇒ 那行 TODO 必须已经删掉');
  assert.ok(!/TODO\(业务负责人\): 销售查询/.test(links),
    '销售查询 URL 她 2026-10-08 已给 ⇒ 那行 TODO 必须已经删掉');
});

test('AC5 当前配置：两个板块都有 URL，两张卡都是可点的 <a>', async () => {
  const modules = loadFrontendModules();
  const [links, html] = await Promise.all([
    modules.links,
    render(modules.queryIndex, 'createQueryModule'),
  ]);

  assert.equal(links.SALES_QUERY_PAGE_URL, SALES_QUERY_URL,
    '销售查询 URL 逐字 = 业务负责人 2026-10-08 给的那条（不多一字、不加工）');
  assert.equal(links.INVENTORY_QUERY_PAGE_URL, INVENTORY_QUERY_URL,
    '库存查询 URL 逐字 = 业务负责人 2026-10-08 给的那条（分享链接形状，也不加工）');

  const blocks = parseEntryBlocks(html);
  assert.deepEqual(blocks.map((block) => block.tag), ['a', 'a'],
    '两条都配好了 ⇒ 两张卡都是 <a>');
  assert.equal(blocks[0].href, SALES_QUERY_URL, '销售查询卡 href 逐字 = 配置值');
  assert.equal(blocks[1].href, INVENTORY_QUERY_URL, '库存查询卡 href 逐字 = 配置值');
  for (const block of blocks) {
    assert.ok(block.attrs.includes('rel="noopener"'), '外链必须带 rel="noopener"');
    assert.equal(block.arrow, '进入 →', '有 URL 时 arrow = 进入 →');
    assert.ok(!block.classes.includes('disabled-card'), '有 URL 的卡不许带 disabled-card');
  }
  assert.ok(!/href\s*=\s*""/.test(html), '整块 HTML 里不许出现空 href（含 href=""）');
  assert.ok(!html.includes(LINK_PENDING), '两条都配好了 ⇒ 不该再出现「链接待配置」');
});

test('AC5b 非空 URL（她给了之后）：href 逐字 = 配置值、rel="noopener"、同窗口', async () => {
  const modules = loadFrontendModules();
  const queryIndex = await modules.queryIndex;
  const SALES = 'https://scnzoiwpgxik.feishu.cn/base/sales-query-page';
  const html = queryIndex.renderQueryEntries([
    { id: 'sales-query', icon: '📈', title: '销售查询', desc: '销售明细在飞书多维表格里看', href: SALES },
    { id: 'inventory-query', icon: '📦', title: '库存查询', desc: '实时库存在飞书多维表格里看', href: '' },
  ]);

  const blocks = parseEntryBlocks(html);
  assert.equal(blocks[0].tag, 'a', '有 URL ⇒ 是真正能点的 <a>');
  assert.equal(blocks[0].href, SALES, 'href 必须逐字等于配置值（不加工、不拼接）');
  assert.ok(blocks[0].attrs.includes('rel="noopener"'), '外链必须带 rel="noopener"');
  assert.ok(!html.includes('target='), '同窗口跳转（与「报货与退货」那张卡一个风格，不加 target）');
  assert.equal(blocks[0].arrow, '进入 →', '有 URL 时 arrow = 进入 →');
  assert.equal(blocks[1].tag, 'div', '同一份配置里空值那一块仍然不是 <a>');
  assert.ok(!html.includes('href=""'), '不许出现空 href');
});

test('AC6 信息查询不新增任何接口：渲染层一次网络调用都没有', () => {
  const source = stripComments(readWorkbench('features/query/index.js'));
  assert.ok(!/\bfetch\s*\(/.test(source), '渲染层不许 fetch（她：「这个维度上我们不用自己搭建接口」）');
  assert.ok(!source.includes('api-client'), '渲染层不许 import api-client');
  assert.ok(!/\bapi\.(get|post|put|patch|del)\s*\(/.test(source), '渲染层不许调任何后端接口');
});

// ── AC7 / AC8：删干净 + 零引用守门 ───────────────────────────────────────────

test('AC7 自建的销售/库存查询页面与模块已删', () => {
  for (const gone of [
    'sales-query.html',
    'sales-today.html',
    'inventory.html',
    'features/sales/index.js',
    'features/sales/sales.css',
    'features/inventory/index.js',
  ]) {
    assert.equal(workbenchHas(gone), false, `${gone} 必须已删（自建的销售/库存查询面）`);
  }
  // 要保留的（信息录入的两个入口）一个都不能跟着走
  for (const kept of ['features/inventory/adjustment.js', 'features/inventory/inventory.css', 'inventory-adjustment.html', 'purchase-return.html', 'common.html']) {
    assert.equal(workbenchHas(kept), true, `${kept} 必须保留`);
  }
});

test('AC8 零引用守门：工作台静态资源 + 路由 + 控制器都不再提已删的自建查询', () => {
  const needles = ['sales-query.html', 'sales-today.html', 'inventory.html', 'features/sales'];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(js|html|md)$/.test(entry.name) ? [full] : [];
  });
  const files = walk(WORKBENCH);
  assert.ok(files.length > 10, '扫到的文件数太少了，walk 大概坏了');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const needle of needles) {
      assert.ok(!source.includes(needle),
        `${path.relative(WORKBENCH, file)} 仍然引用已删的 ${needle}（不许留孤儿引用）`);
    }
  }

  const routes = stripComments(readSrc('routes/workbench.js'));
  assert.ok(!routes.includes("'/sales/query'"), '路由 /api/workbench/sales/query 必须已删');
  assert.ok(!routes.includes("'/sales/today'"), '路由 /api/workbench/sales/today 必须已删');
  const controller = stripComments(readSrc('controllers/workbenchController.js'));
  assert.ok(!/\bquerySales\b/.test(controller), '控制器不许再导出 querySales');
  assert.ok(!/\bqueryTodaySales\b/.test(controller), '控制器不许再导出 queryTodaySales');
});

// ── AC2 / AC9 / AC10：哨兵（不许回退 / 不许误删） ─────────────────────────────

test('AC2 哨兵：信息录入（原「常用功能」只改名）里的两个入口逐字不变', async () => {
  const modules = loadFrontendModules();
  const [home, links, html] = await Promise.all([
    modules.home,
    modules.links,
    render(modules.common, 'createCommonModule'),
  ]);

  // ⚠️ 2026-10-08（业务负责人批准的第一个功能「鞋盒标签打印」）**末尾追加了第三张卡** ——
  //    前两条（报货与退货 / 库存手工调整）的文案 / 顺序 / 目标**逐字未动**（见下面两条断言）。
  assert.deepEqual(home.COMMON_ENTRIES.map((entry) => entry.title), ['报货与退货', '库存手工调整', '鞋盒标签打印'],
    '【信息录入】里的入口：前两个不动，末尾追加「鞋盒标签打印」');
  assert.equal(home.COMMON_ENTRIES[0].href, links.PURCHASE_REQUEST_FORM_URL,
    '「报货与退货」仍然直连报货飞书表单');
  assert.deepEqual(home.COMMON_ENTRIES.find((entry) => entry.id === 'inventory-adjustment'), {
    id: 'inventory-adjustment',
    icon: '🧮',
    title: '库存手工调整',
    desc: '盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）',
    href: '/workbench/inventory-adjustment.html',
    arrow: '进入 →',
    wide: true,
  }, '「库存手工调整」那条（含 wide）一个字节不动');
  assert.equal(parseEntryBlocks(html).length, 3, '信息录入 = 报货与退货 / 库存手工调整 / 鞋盒标签打印');
});

test('AC9/AC10 哨兵：工作台 auth 闸门与写入类接口不回退；共用的库存接口保留', () => {
  const routes = readSrc('routes/workbench.js');
  for (const needle of [
    "'/sales/orders'", "'/sales/payments'", "'/sales/deliveries'",
    "'/inventory'", "'/inventory/products'", "'/inventory/stock'", "'/inventory/categories'",
    'requireWorkbenchAccess', "require('./feishuWebAuth')", "'/purchase'", "'/inventory/adjustments'",
  ]) {
    assert.ok(routes.includes(needle), `routes/workbench.js 丢了 ${needle}（不许回退）`);
  }
  const controller = readSrc('controllers/workbenchController.js');
  for (const name of ['queryInventory', 'queryInventoryProducts', 'queryInventoryStock', 'queryInventoryCategories']) {
    assert.ok(controller.includes(name), `控制器丢了共用的 ${name}`);
  }
  // ⚠️ 共用的 /api/workbench/inventory 不是孤儿：库存手工调整页（信息录入的入口）在调它
  assert.ok(readWorkbench('features/inventory/adjustment.js').includes('/api/workbench/inventory'),
    '库存手工调整页在调 /api/workbench/inventory ⇒ 这个接口必须保留');
});

test('AC10b 独立页面启动器：删了 sales-query / inventory 两个视图，保留信息录入与两个子页', () => {
  const source = readWorkbench('standalone.js');
  assert.ok(!source.includes("'sales-query'"), 'standalone.js 不许再注册 sales-query 视图');
  assert.ok(!/createSalesModule|createInventoryModule/.test(source), '不许再 import 已删的销售/库存模块');
  for (const kept of ["common:", "'inventory-adjustment':", "'purchase-return':"]) {
    assert.ok(source.includes(kept), `standalone.js 必须保留 ${kept}`);
  }
});
