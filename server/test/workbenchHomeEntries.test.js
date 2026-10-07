/**
 * 工作台首页【常用功能】入口清单的回归护栏。
 *
 * ⭐ 2026-10-08（业务负责人逐字）：
 *   「工作台需要修改一下，**采购和退货合并为一个入口**，**就用采购的链路**，
 *     即**退货的链接没有了**～」
 * ⇒ 首页【常用功能】从三张卡（采购 / 退货 / 库存手工调整）**合并成两张**：
 *    · 【采购】一张 —— 点进去是「采购和退货」那一页（报货 / 退货两个飞书表单卡都在里面）
 *      ⇒ **退货的独立入口没有了，但退货功能没丢**（从【采购】这一张卡进去就能到）；
 *    · 【库存手工调整】**一个字节不动**（哨兵）。
 *
 * ⚠️ 老链接不能坏：`/workbench/purchase-return.html` 仍然能开、仍然是两张表单卡（一个字没改）。
 *
 * 做法与 `workbenchAuth401.test.js` 同一套：把前端那几个 ES 模块复制成 `.mjs`
 * （**只改 import 的文件名，逻辑一个字不改**）真的当模块跑起来，
 * 用一个只实现 `innerHTML` 的假容器接住 `mount()` 的输出（`mount` 只写 innerHTML，
 * 不需要真 DOM），断言它渲染出来的那张清单。
 *
 * 口径留档：`docs/workbench-purchase-return-merge-2026-10-08.md`（验收标准 + 逐条对照）。
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
 * 第三条为 `true` 表示**这一条可以不存在**（用于"这个 import 本次被去掉了"的过渡：
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
  // ⚠️ 2026-10-08：合并入口后 `config/home.js` **不再引用 links.js**
  //    （那张卡指的是工作台内页，不再是飞书表单外链）⇒ 这一条 import 改动后就不存在了，
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

test('首页【常用功能】：只剩【采购】一个采购类入口 —— 「退货」那张独立卡没有了', async () => {
  const modules = loadFrontendModules();
  const [html, links, home] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.links,
    modules.home,
  ]);
  const cards = parseCards(html);

  // ① 逐字：首页就是这两张卡，顺序也是这个（采购在上 —— 她 2026-10-06：「采购放在库存上面」）。
  assert.deepEqual(cards.map((card) => card.title), ['采购', '库存手工调整'],
    '首页必须只剩【采购】一个采购类入口（采购/退货已合并，不再是三张卡）');
  assert.equal(cards.length, 2, '首页卡片数量必须是 2');

  // ② 逐字：没有哪张卡的标题是「退货」（那个独立入口 / 链接必须消失）。
  assert.equal(cards.filter((card) => card.title === '退货').length, 0,
    '「退货」那张独立卡必须消失');
  assert.deepEqual(cards.map((card) => card.arrow), ['进入 →', '进入 →']);

  // ③ 逐字：首页没有任何一张卡**直连**退货飞书表单（退货的链接从首页拿掉）。
  assert.equal(cards.filter((card) => card.href === links.PURCHASE_RETURN_FORM_URL).length, 0,
    '首页不许再有任何一张卡直接指向退货飞书表单');
  assert.ok(!html.includes(links.PURCHASE_RETURN_FORM_URL),
    '首页 HTML 里不许出现退货飞书表单 URL');

  // ④ 配置里也不许再有「退货」那条独立入口。
  assert.ok(Array.isArray(home.COMMON_ENTRIES));
  assert.equal(home.COMMON_ENTRIES.filter((entry) => entry.id === 'purchase-return').length, 0,
    'COMMON_ENTRIES 里不许再有 id = purchase-return 的独立入口');
  assert.equal(home.COMMON_ENTRIES.filter((entry) => entry.title === '退货').length, 0,
    'COMMON_ENTRIES 里不许再有标题为「退货」的独立入口');
});

test('⭐ 合并后从【采购】入口能到达退货：入口 → 「采购和退货」页 → 退货飞书表单', async () => {
  const modules = loadFrontendModules();
  const [html, links] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.links,
  ]);
  const cards = parseCards(html);

  // ① 那一个入口指向工作台内的「采购和退货」页（走采购那条链路，而不是直连某个外链表单）。
  assert.equal(cards[0].title, '采购');
  assert.equal(cards[0].href, '/workbench/purchase-return.html',
    '「采购」卡必须指向 /workbench/purchase-return.html（采购和退货页）');

  // ② 真跑那一页的模块：报货 / 退货两张表单卡都还在 ⇒ **退货没丢**。
  const pageHtml = await render(modules.purchaseLinks, 'createPurchaseLinksModule');
  const hrefs = [...pageHtml.matchAll(/class="purchase-link-card" href="([^"]+)"/g)].map((match) => match[1]);
  const titles = [...pageHtml.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((match) => match[1]);
  assert.deepEqual(titles, ['报货', '退货'], '「采购和退货」页必须仍然给出「报货」「退货」两个入口');
  assert.deepEqual(hrefs, [links.PURCHASE_REQUEST_FORM_URL, links.PURCHASE_RETURN_FORM_URL],
    '两个飞书表单（含退货）都必须仍然可达');

  // ③ 也不许删链接 / 删接口：退货表单 URL 仍在配置里、仍被引用。
  assert.equal(typeof links.PURCHASE_RETURN_FORM_URL, 'string');
  assert.ok(links.PURCHASE_RETURN_FORM_URL.length > 0);
  assert.deepEqual(links.PURCHASE_FORMS.map((form) => form.id), ['purchase-request', 'purchase-return']);
});

test('首页入口清单是配置驱动的：config/home.js 是唯一清单来源', async () => {
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
});

test('哨兵：「库存手工调整」那条入口（含 wide / 文案 / 目标）一个字节不动', async () => {
  const modules = loadFrontendModules();
  const [html, home] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.home,
  ]);

  assert.deepEqual(home.COMMON_ENTRIES.find((entry) => entry.id === 'inventory-adjustment'),
    INVENTORY_ADJUSTMENT_ENTRY, '本次只合并采购/退货，库存手工调整那条定义必须逐字不变');

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
    '只有「库存手工调整」带 entry-wide（采购那张是普通卡）');
});

test('老链接不坏：/workbench/purchase-return.html 仍然能开、仍然是两张表单卡', async () => {
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
