/**
 * 工作台首页【常用功能】入口清单的回归护栏。
 *
 * ⭐ 2026-10-08（业务负责人逐字，**ⓐ**）：
 *   「ⓐ（另一种）：**采购卡继续点一次直达报货表单**，只删退货那张卡……
 *    现在就是按照原来一样，**采购和退货用的是一个表单**，
 *    所以你那个点击卡片上应该是"**报货与退货**"」
 * ⇒ 首页【常用功能】= 两张卡：
 *    · 🛒「**报货与退货**」—— `href` **逐字** = `config/links.js` 的
 *      `PURCHASE_REQUEST_FORM_URL`（= 报货飞书表单外链；因为**报货和退货现在是同一个表单**）
 *      ⇒ **点一次直达**，中间**不再经过**内页 `purchase-return.html`；
 *    · 🧮「库存手工调整」—— **哨兵，一个字节不动**。
 * ⚠️ **退货那张独立卡本来就在 #259 删掉了**；本次改的是它上一版"降级成采购页里的子入口"
 *    那条口径（那张卡曾指回 `/workbench/purchase-return.html`，点两次）——
 *    她拍板改成"报货表单本身就是报货与退货同一个表单"⇒ 点一次直达、标题改成「报货与退货」。
 * ⚠️ **不许删**：`config/links.js` 两个表单 URL（`PURCHASE_FORMS` 仍是两条）、
 *    以及 `/workbench/purchase-return.html` 那一页（**老链接继续可用**，仍是两张表单卡）。
 *
 * 做法与 `workbenchAuth401.test.js` 同一套：把前端那几个 ES 模块复制成 `.mjs`
 * （**只改 import 的文件名，逻辑一个字不改**）真的当模块跑起来，
 * 用一个只实现 `innerHTML` 的假容器接住 `mount()` 的输出（`mount` 只写 innerHTML，
 * 不需要真 DOM），断言它渲染出来的那张清单。
 *
 * 口径留档：`docs/workbench-report-return-direct-form-2026-10-08.md`（验收标准 + 逐条对照）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 「库存手工调整」那条入口的**逐字**定义 —— 本次改动**一个字都不许动**（哨兵）。 */
const INVENTORY_ADJUSTMENT_ENTRY = {
  id: 'inventory-adjustment',
  icon: '🧮',
  title: '库存手工调整',
  desc: '盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）',
  href: '/workbench/inventory-adjustment.html',
  arrow: '进入 →',
  wide: true,
};

/**
 * 把要跑的前端模块复制成 `.mjs` 平铺到一个临时目录，
 * **只把 import 的文件名改成复制后的名字**（源码逻辑一个字不改）。
 * `replacements` 里的每一条默认都必须命中 —— 命不中说明源码的 import 变了，测试要跟着更新；
 * 第三条为 `true` 表示**这一条可以不存在**（用于"这个 import 在改动前 / 改动后不一样"的过渡：
 * 同一个测试文件在改动前 / 改动后都要能跑，见 `config/home.js` 那一条）。
 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-home-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement, optional] of replacements) {
      if (!source.includes(needle)) {
        assert.ok(optional, `${from} 里没有找到要改的 import：${needle}`);
        continue;
      }
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  // ⚠️ 改回 ⓐ 之后 `config/home.js` **又 import `links.js`** 了（那张卡直连报货表单外链、
  //    URL 单一来源仍是 links.js）⇒ 这条 import 在【改动后】存在、在【改动前】不存在，
  //    所以标成"可选"，让同一个测试文件在改动前后都能跑。
  copy('config/home.js', 'home.mjs', [["from './links.js'", "from './links.mjs'", true]]);
  copy('core/formatters.js', 'formatters.mjs');
  copy('features/common/index.js', 'common.mjs', [
    ["from '../../config/home.js'", "from './home.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/purchase/links.js', 'purchase-links.mjs', [
    ["from '../../config/links.js'", "from './links.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    links: load('links'),
    home: load('home'),
    common: load('common'),
    purchaseLinks: load('purchase-links'),
  };
}

/** 用假容器渲染一个模块，返回它写进去的 HTML。 */
async function render(modulePromise, factoryName, options) {
  const module = await modulePromise;
  const container = { innerHTML: '' }; // mount() 只写 innerHTML —— 不需要真 DOM
  module[factoryName](options).mount(container);
  return container.innerHTML;
}

/** 把首页卡片解析成结构化的清单（顺序 = DOM 顺序）。 */
function parseCards(html) {
  const cardPattern = /<a class="([^"]*)" href="([^"]*)" rel="noopener">([\s\S]*?)<\/a>/g;
  return [...html.matchAll(cardPattern)].map((match) => {
    const [, classes, href, body] = match;
    return {
      classes,
      href,
      title: body.match(/<h3>([\s\S]*?)<\/h3>/)[1],
      desc: body.match(/<p>([\s\S]*?)<\/p>/)[1],
      arrow: body.match(/<div class="arrow">([\s\S]*?)<\/div>/)[1],
    };
  });
}

test('首页【常用功能】：只有【报货与退货】一个采购类入口 —— 标题逐字、点一次直达报货飞书表单', async () => {
  const modules = loadFrontendModules();
  const [html, links, home] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.links,
    modules.home,
  ]);
  const cards = parseCards(html);

  // ① 逐字：首页就是这三张卡，顺序也是这个（采购在上 —— 她 2026-10-06：「采购放在库存上面」；
  //    ⭐ 2026-10-08 新增第三张「鞋盒标签打印」= 她批准的第一个功能，排在最后）。
  assert.deepEqual(cards.map((card) => card.title), ['报货与退货', '库存手工调整', '鞋盒标签打印'],
    '首页必须只剩【报货与退货】一个采购类入口，且标题逐字 = 报货与退货');
  assert.equal(cards.length, 3, '首页卡片数量必须是 3（报货与退货 / 库存手工调整 / 鞋盒标签打印）');

  // ② ⭐ 点一次直达：href 逐字等于报货飞书表单 URL（报货与退货现在是同一个表单）。
  assert.equal(cards[0].href, links.PURCHASE_REQUEST_FORM_URL,
    '「报货与退货」卡必须直连报货飞书表单（PURCHASE_REQUEST_FORM_URL）');
  assert.ok(!cards.some((card) => card.href.includes('purchase-return.html')),
    '点一次直达表单，首页那张卡不许再指向内页 purchase-return.html');

  // ③ 逐字：没有哪张卡的标题是「退货」（那个独立入口已不在首页）。
  assert.equal(cards.filter((card) => card.title === '退货').length, 0,
    '「退货」那张独立卡必须不在首页（报货与退货是同一个表单）');
  assert.deepEqual(cards.map((card) => card.arrow), ['进入 →', '进入 →', '进入 →']);

  // ④ 配置里也不许再有「退货」那条独立入口；采购那条 id 必须仍是 purchase。
  assert.ok(Array.isArray(home.COMMON_ENTRIES));
  assert.equal(home.COMMON_ENTRIES.filter((entry) => entry.id === 'purchase-return').length, 0,
    'COMMON_ENTRIES 里不许有 id = purchase-return 的独立入口');
  assert.equal(home.COMMON_ENTRIES.filter((entry) => entry.title === '退货').length, 0,
    'COMMON_ENTRIES 里不许有标题为「退货」的独立入口');
  const purchase = home.COMMON_ENTRIES.find((entry) => entry.id === 'purchase');
  assert.ok(purchase, 'COMMON_ENTRIES 里必须仍有 id = purchase 的那一条（不许改 id）');
  assert.equal(purchase.icon, '🛒', 'icon 保持风格一致（🛒）');
  assert.equal(purchase.arrow, '进入 →', 'arrow 保持风格一致（进入 →）');
});

test('首页里不出现退货飞书表单 URL（退货独占的外链不在首页）', async () => {
  const modules = loadFrontendModules();
  const [html, links, home] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.links,
    modules.home,
  ]);
  const cards = parseCards(html);

  assert.equal(cards.filter((card) => card.href === links.PURCHASE_RETURN_FORM_URL).length, 0,
    '首页不许有任何一张卡直接指向退货飞书表单');
  assert.ok(!html.includes(links.PURCHASE_RETURN_FORM_URL),
    '首页 HTML 里不许出现退货飞书表单 URL');
  assert.ok(!home.COMMON_ENTRIES.some((entry) => entry.href === links.PURCHASE_RETURN_FORM_URL),
    'COMMON_ENTRIES 里不许有哪一条的 href 是退货飞书表单 URL');
});

test('首页入口清单是配置驱动的：config/home.js 是唯一清单来源，URL 单一来源 config/links.js', async () => {
  const modules = loadFrontendModules();
  const [html, home] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.home,
  ]);

  assert.ok(Array.isArray(home.COMMON_ENTRIES), 'config/home.js 必须导出 COMMON_ENTRIES 清单');
  for (const entry of home.COMMON_ENTRIES) {
    for (const field of ['id', 'icon', 'title', 'desc', 'href']) {
      assert.ok(entry[field], `入口「${entry.id || entry.title}」缺字段 ${field}`);
    }
  }
  // 渲染出来的顺序 / 目标必须与配置逐条一致（模块只画，不自己写死清单）。
  assert.deepEqual(parseCards(html).map((card) => card.href), home.COMMON_ENTRIES.map((entry) => entry.href));
  assert.deepEqual(parseCards(html).map((card) => card.title), home.COMMON_ENTRIES.map((entry) => entry.title));

  // ⭐ URL 单一来源：`config/home.js` 只 **import** links.js，**不复制** URL 字面量；
  //    渲染层更不许写死任何 URL。
  const homeSource = read('config/home.js');
  assert.ok(homeSource.includes("from './links.js'"),
    'config/home.js 必须 import config/links.js（URL 单一来源，不复制字面量）');
  assert.ok(!/feishu\.cn/.test(homeSource),
    'config/home.js 里不许出现飞书表单 URL 字面量（只能从 links.js 引用）');
  assert.ok(!/feishu\.cn/.test(read('features/common/index.js')),
    'features/common/index.js（渲染层）里不许写死 URL');
});

test('哨兵：「库存手工调整」那条入口（含 wide / 文案 / 目标）一个字节不动', async () => {
  const modules = loadFrontendModules();
  const [html, home] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.home,
  ]);

  assert.deepEqual(home.COMMON_ENTRIES.find((entry) => entry.id === 'inventory-adjustment'),
    INVENTORY_ADJUSTMENT_ENTRY, '本次只改采购那条，库存手工调整那条定义必须逐字不变');

  const card = parseCards(html).find((item) => item.title === '库存手工调整');
  assert.ok(card, '「库存手工调整」那张卡必须还在');
  assert.equal(card.href, '/workbench/inventory-adjustment.html');
  assert.equal(card.desc, INVENTORY_ADJUSTMENT_ENTRY.desc);
  assert.equal(card.arrow, '进入 →');
  assert.ok(card.classes.includes('entry-wide'), '「库存手工调整」仍然带 entry-wide（配置里 wide: true）');
});

test('首页卡片同窗口跳转（手机上在飞书内置浏览器里打开，不新开窗口）', async () => {
  const modules = loadFrontendModules();
  const html = await render(modules.common, 'createCommonModule');

  assert.ok(!html.includes('target="_blank"'), '外链卡片不许 target="_blank"（手机上体验差、还可能被拦）');
  assert.ok(!html.includes('target='), '首页卡片一律同窗口跳转');
  assert.ok(html.includes('rel="noopener"'), '同窗口跳转也要带 rel="noopener" 保底');
  // 手机上：两个入口上下排、一屏可见（样式护栏 —— entries-pair 的窄屏规则）。
  assert.ok(html.includes('quick-entries entries-pair'), '首页必须用 entries-pair 布局');
  assert.equal(parseCards(html).filter((card) => card.classes.includes('entry-wide')).length, 1,
    '只有「库存手工调整」带 entry-wide（报货与退货那张是普通卡）');
});

test('老链接不坏：/workbench/purchase-return.html 仍然能开、仍然是两张表单卡（回归）', async () => {
  // 页面本体与启动器注册一行都不该动。
  assert.ok(fs.existsSync(path.join(WORKBENCH, 'purchase-return.html')), 'purchase-return.html 必须还在');
  assert.match(read('purchase-return.html'), /data-view="purchase-return"/);
  assert.match(read('standalone.js'), /'purchase-return':/, 'standalone.js 仍要注册这个独立页');

  // 真跑一遍那个页面的模块：不带任何参数时，默认仍然把两张表单卡都画出来。
  const modules = loadFrontendModules();
  const [html, links] = await Promise.all([
    render(modules.purchaseLinks, 'createPurchaseLinksModule'),
    modules.links,
  ]);
  const hrefs = [...html.matchAll(/class="purchase-link-card" href="([^"]+)"/g)].map((match) => match[1]);
  const titles = [...html.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((match) => match[1]);

  assert.deepEqual(hrefs, [links.PURCHASE_REQUEST_FORM_URL, links.PURCHASE_RETURN_FORM_URL],
    '不带参数打开 purchase-return.html：默认视图 = 两张飞书表单都显示（与改动前逐字一致）');
  assert.deepEqual(titles, ['报货', '退货']);

  // 🔴 两个 URL / 两张表单一个都没删（老链接继续可用）。
  assert.equal(typeof links.PURCHASE_REQUEST_FORM_URL, 'string');
  assert.ok(links.PURCHASE_REQUEST_FORM_URL.length > 0);
  assert.equal(typeof links.PURCHASE_RETURN_FORM_URL, 'string');
  assert.ok(links.PURCHASE_RETURN_FORM_URL.length > 0);
  assert.deepEqual(links.PURCHASE_FORMS.map((form) => form.id), ['purchase-request', 'purchase-return']);
  assert.deepEqual(links.PURCHASE_FORMS.map((form) => form.url),
    [links.PURCHASE_REQUEST_FORM_URL, links.PURCHASE_RETURN_FORM_URL]);
});

test('一级 tab（index.html 的常用功能）与独立页（common.html）渲染同一份清单', async () => {
  const modules = loadFrontendModules();
  const [tab, standalone] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    render(modules.common, 'createCommonModule', { focused: true }),
  ]);

  assert.deepEqual(parseCards(standalone), parseCards(tab),
    '两处必须是同一份清单（不许各写一份）');
});
