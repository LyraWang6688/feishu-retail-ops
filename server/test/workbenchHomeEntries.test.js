/**
 * ⚠️ 2026-10-11 晚（业务负责人批准「死链可以清掉」）——本文件**改写**的断言（逐字）：
 *   改前：`copy('features/purchase/links.js', 'purchase-links.mjs', …)` ＋ `purchaseLinks: load('purchase-links')`
 *        （那两份是"隐藏的老「采购和退货」独立页"的两张**飞书表单死链卡**的渲染模块）。
 *   改后：删掉那两行（该模块**已从仓库删除**：它挂的两个飞书表单写的是已被整表删除的「信息填写」表）。
 *   理由：死链清掉（她的批准）；`config/links.js` 的两个 URL 常量**仍在**（删 or 留由业务负责人定）。
 *   ⚠️ 首页那几张卡与其它哨兵**一条都没放宽**。
 */
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

/**
 * 「库存手工调整」那条入口的**逐字**定义 —— 本次改动**一个字都不许动**（哨兵）。
 * ⚠️ 2026-10-16 成对迁移（业务负责人逐字：「**虽然我看不到，但是没用，所以也可以删除掉！**」）：
 *    · 改前逐字：这一条里有 `arrow: '进入 →',`；
 *    · 改后逐字：**整行删掉**（卡片本体就是整张可点的 `<a class="entry-card" href=…>`
 *      ⇒ 那行箭头没有任何跳转职责、纯多余）；
 *    · 依据：她 2026-10-16 逐字 + 只读核实（见 `config/home.js` 的 2026-10-16 历史条目）。
 *    ⚠️ **不是放宽**：`id` / `icon` / `title` / `desc` / `href` / `wide` **仍逐字钉死** ✓
 */
const INVENTORY_ADJUSTMENT_ENTRY = {
  id: 'inventory-adjustment',
  icon: '🧮',
  title: '库存手工调整',
  desc: '盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）',
  href: '/workbench/inventory-adjustment.html',
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
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    links: load('links'),
    home: load('home'),
    common: load('common'),
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
      arrow: body.match(/<div class="arrow">([\s\S]*?)<\/div>/)?.[1],
    };
  });
}

test('首页【常用功能】：**只剩两张卡**（库存手工调整 / 鞋盒标签打印）—— 报货与退货那张已删', async () => {
  const modules = loadFrontendModules();
  const [html, links, home] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.links,
    modules.home,
  ]);
  const cards = parseCards(html);

  // ⚠️ 2026-10-11 **改写**（业务负责人：「那张『报货与退货』卡**直接去掉**，那是死链」）：
  //    改前：首页三张卡，第一张就是「报货与退货」（href = 报货飞书表单外链）；
  //    改后：**只剩两张** —— 库存手工调整 / 鞋盒标签打印；**一张采购类卡都没有**。
  assert.deepEqual(cards.map((card) => card.title), ['库存手工调整', '鞋盒标签打印'],
    '首页只剩【库存手工调整】+【鞋盒标签打印】两张卡');
  assert.equal(cards.length, 2, '首页卡片数量必须是 2（报货与退货那张已删）');

  // ① 首页**不再有任何采购类入口**（也不再有指向飞书表单的外链）
  assert.equal(cards.filter((card) => card.title.includes('报货') || card.title.includes('退货')).length, 0,
    '首页不许再有「报货与退货」那张卡');
  assert.equal(cards.filter((card) => card.href.includes('feishu.cn')).length, 0,
    '首页不再有飞书表单外链入口（那张卡是死链，已删）');
  assert.ok(!cards.some((card) => card.href.includes('purchase-return.html')),
    '首页那张卡不许再指向内页 purchase-return.html');
  // ⭐ 2026-10-16 成对迁移（业务负责人逐字：「虽然我看不到，但是没用，所以也可以删除掉！」）：
  //    改前逐字：`assert.deepEqual(cards.map((card) => card.arrow), ['进入 →', '进入 →']);`
  //    改后逐字：两张卡**都不再有那一行箭头**（卡体里连 `<div class="arrow">` 都不出现）
  //    依据：卡片本体就是整张可点的 `<a class="entry-card" href=…>` ⇒ 那行没有跳转职责 ✓
  //    ⚠️ **不是放宽** ✗：这是「必须有」翻成「必须没有」—— 而且下面还钉着 href / 标题 / 卡数不变 ✓
  assert.deepEqual(cards.map((card) => card.arrow), [undefined, undefined],
    '有 URL 的两张卡都不再画那一行箭头（`arrow` 键也没了）');
  assert.equal(/<div class="arrow">/.test(html), false,
    '🔴 整份首页 HTML 里都不许再出现 `<div class="arrow">`（那两行已删）');

  // ② 配置里那一条也必须真的删掉（不是渲染层藏起来）
  assert.ok(Array.isArray(home.COMMON_ENTRIES));
  assert.equal(home.COMMON_ENTRIES.some((entry) => entry.id === 'purchase'), false,
    'COMMON_ENTRIES 里不许再留 id = purchase 的那一条（她：直接去掉）');
  assert.equal(home.COMMON_ENTRIES.filter((entry) => entry.title === '退货').length, 0,
    'COMMON_ENTRIES 里不许有标题为「退货」的独立入口');
  // ⚠️ 两张表单 URL **一个都没删**（「采购」tab 那两张卡还在用它们，见文件末尾那条哨兵）
  assert.equal(typeof links.PURCHASE_REQUEST_FORM_URL, 'string');
  assert.equal(typeof links.PURCHASE_RETURN_FORM_URL, 'string');
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
  // ⭐ 2026-10-11：报货表单 URL 同样**不再**出现在首页（那张卡已删）
  assert.ok(!html.includes(links.PURCHASE_REQUEST_FORM_URL),
    '首页 HTML 里也不再出现报货飞书表单 URL（那张「报货与退货」卡已删）');
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

  // ⭐ URL 单一来源：`config/home.js` **不复制** URL 字面量；渲染层更不许写死任何 URL。
  //    ⚠️ 2026-10-11 改写：首页**已经没有任何外链入口**（报货与退货那张卡删了）⇒
  //       `config/home.js` 里那个 `import { PURCHASE_REQUEST_FORM_URL } from './links.js'`
  //       变成了**孤儿**，按纪律一并清掉 ⇒ 这里改成钉"它**不再** import links.js"。
  const homeSource = read('config/home.js');
  assert.ok(!homeSource.includes("from './links.js'"),
    '首页已无外链入口 ⇒ config/home.js 不再 import links.js（孤儿 import 必须清掉）');
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
  assert.equal(card.arrow, undefined,
    '⭐ 改后逐字：那一行箭头不再画（她 2026-10-16：「虽然我看不到，但是没用，所以也可以删除掉！」）');
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

test('老页面已按她的口令删掉：purchase-return.html 与它的启动器注册都不在；两张表单 URL 一个字没少', async () => {
  // ⚠️ 2026-10-09 改写（业务负责人点头：「代码从仓库里删，不是隐藏」）：
  //    原先这一条钉的是"老链接不坏：`/workbench/purchase-return.html` 仍然能开"。
  //    那一页**已删** ⇒ 改成钉"页面与注册都真的没了"，同时保住**两张表单 URL**
  //    （它们现在是「采购」tab ① 报货 / 验收 / 退货 那两张卡的 URL 单一来源，一个都不许少）。
  assert.equal(fs.existsSync(path.join(WORKBENCH, 'purchase-return.html')), false,
    'purchase-return.html 必须已删（代码从仓库里删，不是隐藏）');
  const standalone = read('standalone.js');
  assert.ok(!standalone.includes("'purchase-return'"), 'standalone.js 不许再注册这个独立页的视图');
  assert.ok(!standalone.includes('features/purchase'), 'standalone.js 也不许再 import 它那个模块');

  // 🔴 两个 URL / 两张表单一个都没删（「采购」tab 的两张卡还在用它们）。
  const modules = loadFrontendModules();
  const links = await modules.links;
  assert.equal(typeof links.PURCHASE_REQUEST_FORM_URL, 'string');
  assert.ok(links.PURCHASE_REQUEST_FORM_URL.length > 0);
  assert.equal(typeof links.PURCHASE_RETURN_FORM_URL, 'string');
  assert.ok(links.PURCHASE_RETURN_FORM_URL.length > 0);
  assert.deepEqual(links.PURCHASE_FORMS.map((form) => form.id), ['purchase-request', 'purchase-return']);
  assert.deepEqual(links.PURCHASE_FORMS.map((form) => form.url),
    [links.PURCHASE_REQUEST_FORM_URL, links.PURCHASE_RETURN_FORM_URL]);
});

test('老首页文件已删（common.html）：清单仍然只来自 config/home.js，渲染层不自己写死', async () => {
  // ⚠️ 2026-10-09 改写：原先这条比的是"一级 tab"与独立页 `common.html` 两处渲染同一份清单。
  //    那个独立页已按她的口令删掉（代码从仓库里删）⇒ 前提没了；但"清单只来自 config/home.js"
  //    这条口径仍然有效，下面继续钉住它。
  assert.equal(fs.existsSync(path.join(WORKBENCH, 'common.html')), false,
    'common.html 必须已删（业务负责人 2026-10-09 点头）');

  const modules = loadFrontendModules();
  const [home, tab, focused] = await Promise.all([
    modules.home,
    render(modules.common, 'createCommonModule'),
    render(modules.common, 'createCommonModule', { focused: true }),
  ]);

  assert.deepEqual(parseCards(focused), parseCards(tab), '两处必须是同一份清单（不许各写一份）');
  assert.deepEqual(parseCards(tab).map((card) => card.title), home.COMMON_ENTRIES.map((entry) => entry.title),
    '卡片的顺序与标题必须逐条等于 config/home.js 的清单（配置先行）');
});
