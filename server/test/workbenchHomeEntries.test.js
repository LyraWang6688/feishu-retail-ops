/**
 * 工作台首页【常用功能】入口清单的回归护栏（业务负责人 2026-10-07）。
 *
 * 要求（逐字）：「另外**常用功能首页就单独出来采购和退货**吧，这样**不需要多点一次**～」
 * ⇒ 首页要出现【采购】【退货】**两张独立卡**，各点一次**直达飞书表单**，
 *    中间不再经过 `purchase-return.html`（去掉的正是那一次多余的点击）。
 * ⇒ 同时**老链接不能坏**：`/workbench/purchase-return.html` 仍然能开、仍然两张表单卡。
 *
 * 做法与 `workbenchAuth401.test.js` 同一套：把前端那几个 ES 模块复制成 `.mjs`
 * （**只改 import 的文件名，逻辑一个字不改**）真的当模块跑起来，
 * 用一个只实现 `innerHTML` 的假容器接住 `mount()` 的输出（`mount` 只写 innerHTML，
 * 不需要真 DOM），断言它渲染出来的那张清单。
 *
 * 口径留档：`docs/workbench-purchase-return-split-2026-10-07.md`（验收标准 + 逐条对照）。
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
 * 把要跑的前端模块复制成 `.mjs` 平铺到一个临时目录，
 * **只把 import 的文件名改成复制后的名字**（源码逻辑一个字不改）。
 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-home-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  copy('config/home.js', 'home.mjs', [["from './links.js'", "from './links.mjs'"]]);
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

test('首页【常用功能】：采购 / 退货 拆成两张独立卡，顺序 采购 → 退货 → 库存手工调整', async () => {
  const modules = loadFrontendModules();
  const [html, links] = await Promise.all([
    render(modules.common, 'createCommonModule'),
    modules.links,
  ]);
  const cards = parseCards(html);

  assert.deepEqual(cards.map((card) => card.title), ['采购', '退货', '库存手工调整'],
    '首页必须是三个独立入口，且采购、退货各自成卡（不再有一个合并的「采购和退货」）');
  assert.equal(cards.filter((card) => card.title === '采购和退货').length, 0,
    '合并入口「采购和退货」必须消失');
  assert.deepEqual(cards.map((card) => card.arrow), ['去填写 →', '去填写 →', '进入 →']);

  // ⭐ 点一次直达：href 就是飞书表单本身，中间不再经过 purchase-return.html。
  assert.equal(cards[0].href, links.PURCHASE_REQUEST_FORM_URL, '「采购」卡必须直达采购（报货）飞书表单');
  assert.equal(cards[1].href, links.PURCHASE_RETURN_FORM_URL, '「退货」卡必须直达采购退货飞书表单');
  assert.equal(cards[2].href, '/workbench/inventory-adjustment.html');
  assert.ok(!cards.some((card) => card.href.includes('purchase-return.html')),
    '首页卡不许再指向 purchase-return.html —— 那会让她多点一次');
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

test('首页卡片同窗口跳转（手机上在飞书内置浏览器里打开，不新开窗口）', async () => {
  const modules = loadFrontendModules();
  const html = await render(modules.common, 'createCommonModule');

  assert.ok(!html.includes('target="_blank"'), '外链卡片不许 target="_blank"（手机上体验差、还可能被拦）');
  assert.ok(!html.includes('target='), '首页卡片一律同窗口跳转');
  assert.ok(html.includes('rel="noopener"'), '同窗口跳转也要带 rel="noopener" 保底');
  // 手机上：采购 / 退货并排一行、库存整行 —— 三个入口一屏可见（样式护栏）。
  assert.ok(html.includes('quick-entries entries-pair'), '首页必须用 entries-pair 布局');
  assert.equal(parseCards(html).filter((card) => card.classes.includes('entry-wide')).length, 1,
    '只有「库存手工调整」整行（entry-wide）');
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
