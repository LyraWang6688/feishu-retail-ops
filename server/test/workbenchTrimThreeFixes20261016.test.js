/**
 * ⭐⭐ 工作台 · **货品（domains 页）三处改动** —— 业务负责人 **2026-10-16** 亲口点的
 *    （截图 + 逐字；下面每条 AC 都写「改前逐字 → 改后逐字 → 依据」）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做** —— 她定的流程）
 *
 *  AC-TR1 ① `<input name="number">` 的 `placeholder` **整句替换**：
 *           改前逐字 `'编号（货号|颜色|类别）或货号，例如 XHB8095'`
 *           → 改后逐字 `'输入货号，例如 XHB8095'`。
 *         ⚠️ **只换 placeholder** ✗ —— 标题（`fieldLabel`）与**下拉选项文字**（`texts.optionNoStock` /
 *            `texts.optionUnknown` / `aria.listLabel`）**一个字不动** ✓（她：「不是下拉里的选项」）。
 *
 *  AC-TR2 ② `<div class="number-picker-status" data-view="number-status" …>` 里**那段文字说明删掉**：
 *           改前逐字 `'输入编号 / 货号，我就列出匹配的编号（也可以直接手输完整编号）'`
 *           → 改后逐字 `''`（**零请求时状态区一个字符都不写** ✓）。
 *         ⚠️ **那一格不删** ✗ —— 它是 `role="status" aria-live="polite"` 的**状态区**，
 *            **真实状态一条都不许丢**（正在读 / 匹配数 / 没找到 / 读不到 / 已选中）✓。
 *
 *  AC-TR3 ③ 那两行箭头**是不是多余** —— 她逐字：「**是否就是多余的，点开入口卡片就可以实现跳转吧，
 *            需要你实际核对一下代码**」。
 *         核实结论：**是多余的** ✓ —— 依据 = `features/domains/pages.js` 的 `cardsHtml`（:54–:59）：
 *            配了 `href` 的卡渲染成 `<a class="entry-card" href="…" rel="noopener">`，
 *            **整张卡就是那个链接**（`.entry-card` 铺满卡面，`workbenchMobileVisual.test.js:114` 钉着）。
 *         ⇒ 改前逐字 `arrow: '去扫码打印 →'` / `arrow: '打开标签打印页 →'` → 改后逐字 = **两行都删掉**
 *            （卡片的 `href` / `icon` / `title` 一个字不动 ⇒ **跳转能力零变化**）。
 *
 *  AC-TR4 扫码页（`src/views/scanPageRealm.js`）那句**同名文案**`labelSingleButton: '打开标签打印页 →'`
 *         **不在本次范围**（她这次说的是**工作台**的 domains 页）⇒ 本文件只**钉住它逐字不动**（只报不改）✓。
 *
 * ⚠️ 本文件的重点是**反向哨兵**：上面三处**旧的逐字（旧 placeholder / 旧提示语 / 那两行箭头）
 *    **塞回来就红** ✓（含"配置里塞回""渲染面塞回"两路）。
 * ⚠️ 判据**不靠子串锚点凑数**：①③ 都是**整句 / 整行**逐字比较；
 *    且"有没有那句话"是在**去注释后**的源码上判的（历史沿革写在注释里，不算实现）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const readSrc = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

/** 去掉注释再对"代码里有没有某件事"下结论 —— 注释里写"改前逐字"那段沿革不算实现。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 她 2026-10-16 点掉的三处**旧逐字**（≤ 三条，逐字）。 */
const OLD_PLACEHOLDER = '编号（货号|颜色|类别）或货号，例如 XHB8095';
const NEW_PLACEHOLDER = '输入货号，例如 XHB8095';
const OLD_IDLE_HINT = '输入编号 / 货号，我就列出匹配的编号（也可以直接手输完整编号）';
const OLD_ARROWS = ['去扫码打印 →', '打开标签打印页 →'];

/** 把要跑的前端模块复制成 `.mjs` 平铺到一个临时目录（**只改 import 的文件名，逻辑一个字不改**）。 */
async function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-trim-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('config/numberPicker.js', 'number-picker-config.mjs');
  copy('config/links.js', 'links.mjs');
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('features/shared/placeholder.js', 'placeholder.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/domains/pages.js', 'domains-pages.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../shared/placeholder.js'", "from './placeholder.mjs'"],
  ]);
  copy('features/labels/number-picker.js', 'number-picker.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../config/numberPicker.js'", "from './number-picker-config.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    picker: await load('number-picker'),
    pickerConfig: await load('number-picker-config'),
    domains: await load('domains'),
    pages: await load('domains-pages'),
  };
}

/** 货品 · 标签打印那一页（**本次三处改动全在它身上**）。 */
const labelsPageOf = (domains) => domains.domainById('product').pages.find((page) => page.id === 'product-labels');

// ── 假 DOM（照 `productNumberPicker.test.js` 同一套；只挂本次要看的三个锚） ────────────
const fakeElement = (init = {}) => {
  const element = {
    value: '', textContent: '', innerHTML: '', disabled: false,
    attrs: {}, handlers: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    ...init,
  };
  return element;
};

const INPUT = 'input[name="number"]';
const OPTIONS = '[data-view="number-options"]';
const STATUS = '[data-view="number-status"]';

const fakeHost = (seedStatus = '') => {
  const elements = {
    [INPUT]: fakeElement(),
    [OPTIONS]: fakeElement(),
    [STATUS]: fakeElement({ textContent: seedStatus }),
  };
  return { elements, querySelector: (selector) => elements[selector] || null };
};

/** 假 api：记下每次 GET 的地址（永挂 / 抛错 / 回指定结果）。 */
const fakeApi = (options = {}) => {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      if (options.never) return new Promise(() => {});
      if (options.error) throw options.error;
      return options.result || { success: true, total: 0, truncated: false, numbers: [] };
    },
  };
};

const numberItem = () => ({
  number: 'XHB8095|棕色|A', itemNo: 'XHB8095', color: '棕色', category: 'A',
  hasStock: true, recordId: 'rec-1',
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-TR1 ① placeholder 整句替换（标题 / 下拉选项文字一个字不动）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-TR1 ① placeholder = 「输入货号，例如 XHB8095」（整句替换；标题与下拉选项文字一个字不动）', async () => {
  const modules = await loadFrontendModules();
  const [domains, pages] = await Promise.all([modules.domains, modules.pages]);
  const labels = labelsPageOf(domains);

  // ① **改后逐字**就在配置里（配置先行：这一句的家是 `config/domains.js`）
  assert.equal(labels.placeholder, NEW_PLACEHOLDER,
    '⭐ 改后逐字 = 她 2026-10-16 要的那一句（一个字不差）');
  // ⚠️ **不是标题**：`fieldLabel` 逐字不动（她：「不是标题」✗）
  assert.equal(labels.fieldLabel, '编号 / 货号', '字段标题一个字不动');
  // ⚠️ **不是下拉选项**：选项那两句 / 无障碍标签逐字不动（她：「不是下拉里的选项」✗）
  const { NUMBER_PICKER } = await modules.pickerConfig;
  assert.equal(NUMBER_PICKER.texts.optionNoStock, '还没入库', '下拉选项文字「还没入库」不动');
  assert.equal(NUMBER_PICKER.texts.optionUnknown, '入库情况未确认', '下拉选项文字「入库情况未确认」不动');
  assert.equal(NUMBER_PICKER.aria.listLabel, '编号选项（来自「货品信息」）', '选项区无障碍标签不动');

  // ② 渲染出来的表单上**就是那一句**（整句逐字，不是子串凑的）
  const html = pages.entryPageHtml(labels);
  assert.ok(html.includes(`placeholder="${NEW_PLACEHOLDER}"`),
    '⭐ 渲染出来的 <input name="number"> 的 placeholder = 改后逐字');

  // ③ 🔴 **反向哨兵**：旧 placeholder 塞回来就红 ——
  //    · 配置**代码**（去注释后）里不许再有它（注释里那段"改前逐字"沿革不算）；
  //    · 渲染面上更不许有。
  assert.equal(stripComments(read('config/domains.js')).includes(OLD_PLACEHOLDER), false,
    `🔴 旧 placeholder 塞回配置就红：${OLD_PLACEHOLDER}`);
  assert.equal(html.includes(OLD_PLACEHOLDER), false,
    `🔴 旧 placeholder 塞回渲染面就红：${OLD_PLACEHOLDER}`);

  // ④ 「能做的事」一个没少：仍是既有编号表单 + 那颗按钮 + 那个落点（不是放宽）
  assert.ok(html.includes('data-entry-form') && html.includes('name="number"'), '编号表单照旧');
  assert.equal(labels.buttonLabel, '选择编号打印 →', '那颗按钮照旧');
  assert.equal(labels.targetTemplate, '/workbench/label-print.html?keyword={itemNo}', '落点模板照旧');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-TR2 ② 状态区不再写"使用说明"；真实状态一条不丢
// ═══════════════════════════════════════════════════════════════════════════

test('AC-TR2 ② 零请求时状态区**一个字符都不写**（那句使用说明删掉）· 但状态区本身与真实状态照旧', async () => {
  const modules = await loadFrontendModules();
  const { picker, pickerConfig } = modules;
  const { NUMBER_PICKER } = await pickerConfig;

  // ① 配置里那一档**正好是空串**（改后逐字）
  assert.equal(NUMBER_PICKER.texts.idle, '', '⭐ 改后逐字 = 空串（零请求时状态区不写任何字）');

  // ② 🔴 **反向哨兵**：旧提示语塞回**配置代码**就红（去注释后判；注释里那段"改前逐字"沿革不算）
  for (const file of ['config/numberPicker.js', 'features/labels/number-picker.js']) {
    assert.equal(stripComments(read(file)).includes(OLD_IDLE_HINT), false,
      `🔴 旧提示语塞回 ${file} 就红：${OLD_IDLE_HINT}`);
  }

  // ③ 真挂一次：状态区**先塞一句残留** ⇒ mount 之后必须被**清空**
  //    （所以 `renderStatus()` 那一行不是删掉、而是"算出来是空" ✓）
  const host = fakeHost('上一次留下的旧字');
  const api = fakeApi();
  await picker.createNumberPicker({ api }).mount(host);
  assert.equal(String(host.elements[STATUS].textContent), '',
    '⭐ 进页面 ⇒ 状态区被清空（零请求时不写使用说明）');
  assert.equal(api.calls.length, 0, '进页面仍然一个请求都不发（懒加载没被动过）');
  // 无障碍语义**一个字没丢**：那一格仍是 status 区（不是被删掉）
  const shellHtml = modules.pages.entryPageHtml(labelsPageOf(await modules.domains));
  assert.ok(shellHtml.includes('data-view="number-status"') && shellHtml.includes('role="status"')
    && shellHtml.includes('aria-live="polite"'),
    '🔴 状态区**没被删**：data-view / role=status / aria-live 逐字都在');

  // ④ 空关键字聚焦 ⇒ 仍然零请求、状态区仍然为空（她删的就是这一段）
  await host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 0, '空关键字 ⇒ 零请求（照旧）');
  assert.equal(String(host.elements[STATUS].textContent), '', '空关键字 ⇒ 状态区仍然一个字都不写');
  assert.equal(host.elements[OPTIONS].innerHTML, '', '上一次的选项照旧被清掉（这条能力没丢）');

  // ⑤ ⭐ **真实状态一条都不许丢**（她点名要留的那类）—— 逐档钉住
  const text = (state) => String(picker.pickerStatusText(state, NUMBER_PICKER));
  assert.equal(text({}), '', '零请求那一档 = 空');
  assert.match(text({ loading: true }), /正在读取/, '「正在读」照旧（不然她以为点了没反应）');
  assert.match(text({ loaded: true, count: 3, keyword: 'XHB' }), /共 3 个编号匹配/, '**匹配数**照旧（她点名要留的）');
  assert.match(text({ loaded: true, count: 3, keyword: 'XHB' }), /XHB/, '匹配数那句回显关键字');
  assert.match(text({ loaded: true, count: 0 }), /没有匹配的编号/, '「没找到」照旧');
  assert.match(text({ loaded: true, count: 0 }), /手输/, '「没找到」时那条"还能手输"的出口照旧（不留死界面）');
  assert.match(text({ failed: true }), /暂时读不到/, '**真实报错**照旧');
  assert.match(text({ failed: true }), /手输/, '读不到时"还能手输"照旧');
  assert.match(text({ picked: { hasStock: true } }), /有库存/, '选中之后那句照旧');
  assert.match(text({ picked: { hasStock: false } }), /还没入库/, '选中（没入库）那句照旧');
  assert.match(text({ picked: { hasStock: null } }), /未确认/, '选中（未确认）那句照旧');

  // ⑥ 交互之后（真有状态了）**照旧写进那一格** —— 证明"不写"只针对使用说明，不是把状态区废掉
  const live = fakeHost();
  await picker.createNumberPicker({
    api: fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } }),
  }).mount(live);
  live.elements[INPUT].value = 'XHB';
  await live.elements[INPUT].handlers.focus();
  // ⚠️ 假 api 是**立刻回**的 ⇒ 这里看到的是落地后的那一档（真实状态）。它非空 ⇒ 状态区仍在工作 ✓。
  assert.match(String(live.elements[STATUS].textContent), /共 1 个编号匹配/,
    '真出了状态（匹配数）⇒ 照旧写进那一格（状态区仍然在工作 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-TR3 ③ 卡片本体自己能跳 ⇒ 那两行箭头删掉（跳转能力零变化）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-TR3 ③ 核实：卡片本体自己是 <a href>（整张可点）⇒ 那两行箭头删掉；跳转能力零变化', async () => {
  const modules = await loadFrontendModules();
  const [domains, pages] = await Promise.all([modules.domains, modules.pages]);
  const labels = labelsPageOf(domains);

  // ① ⭐ **核实证据**（她让我"实际核对一下代码"）：配了 `href` 的卡 → 渲染成**整张可点的 `<a>`**，
  //    卡体（icon / 标题 / 箭头）都在这个 `<a>` 里面 ⇒ **点卡片任意一处就是跳转** ✓
  const linksHtml = pages.cardsHtml(labels.links);
  for (const href of ['/workbench/label-print.html?scan=1', '/workbench/label-print.html']) {
    assert.ok(linksHtml.includes(`<a class="entry-card" href="${href}" rel="noopener">`),
      `⭐ 卡片本体就是那个链接（整张可点）：${href}`);
  }
  assert.equal((linksHtml.match(/<a class="entry-card"/g) || []).length, 2, '两颗入口都是 <a>（不是靠箭头跳）');

  // ② 改后逐字 = 两行箭头都**不存在**（配置里没有 `arrow` 这个键 ⇒ 渲染面也没有那一行）
  assert.deepEqual(labels.links.map((link) => link.arrow), [undefined, undefined],
    '⭐ 改后逐字：两颗入口都不再有 `arrow`（那两行删掉了）');
  assert.equal(/<div class="arrow">/.test(linksHtml), false,
    '🔴 渲染面里那两颗卡**不再画 `<div class="arrow">`** 那一行');

  // ③ 🔴 **反向哨兵**：那两行旧箭头**塞回来就红**（配置代码去注释后 + 渲染面，两路都判）
  const domainsCode = stripComments(read('config/domains.js'));
  for (const gone of OLD_ARROWS) {
    assert.equal(domainsCode.includes(gone), false, `🔴 旧箭头塞回配置就红：${gone}`);
    assert.equal(linksHtml.includes(gone), false, `🔴 旧箭头塞回渲染面就红：${gone}`);
  }

  // ④ 渲染层契约：**只有显式给了 `arrow` 才画那一行**（所以"删掉箭头"不会变成"换一句默认箭头"）
  const noArrow = pages.cardsHtml([{ title: '甲', href: '/x' }]);
  assert.equal(/<div class="arrow">/.test(noArrow), false, '没给 arrow ⇒ 那一行不画（不再有默认「进入 →」兜底）');
  const withArrow = pages.cardsHtml([{ title: '乙', href: '/y', arrow: '去那里 →' }]);
  assert.ok(withArrow.includes('<div class="arrow">去那里 →</div>'), '给了 arrow ⇒ 那一行照画（别的卡不受影响）');

  // ⑤ 🔴 **不是放宽** ✗ —— **成对迁移（2026-10-16 当天下午）**：
  //    改前逐字：`assert.deepEqual(allArrows, ['去填配品销售表单 →', '去填写 →', '打开名录 →'].sort(), …)`
  //      （当时她只点了#699 那两行 ⇒ 其余三条逐字仍在）
  //    改后逐字：`assert.deepEqual(allArrows, [], …)` —— 她当天下午把**最后三处**也点了
  //      （新逐字「**我也没看到，可以删除**」）⇒ domains 的 `arrow` 集合 = **空集**
  //    依据 = 她 2026-10-16 逐字；⚠️ **变强，不是放宽**（从"必须有三条"翻成"必须一条都没有"）。
  const allArrows = domains.DOMAIN_TABS.flatMap((domain) => domain.pages)
    .flatMap((page) => [...(page.cards || []), ...(page.links || [])])
    .map((card) => card.arrow).filter((arrow) => arrow !== undefined);
  assert.deepEqual(allArrows, [],
    '⭐ 改后逐字：domains 里的 arrow 集合 = 空集（最后三条箭头也已退场）');

  // ⑥ **跳转能力零变化**（这才是"删箭头"敢做的前提）：href / 标题 / 落点 / 选择器 / 按钮全照旧
  assert.deepEqual(labels.links.map((link) => link.title), ['扫码打印', '批量打印'], '两颗标题逐字照旧');
  assert.deepEqual(labels.links.map((link) => link.href),
    ['/workbench/label-print.html?scan=1', '/workbench/label-print.html'], '两颗 href 逐字照旧（跳转没变）');
  assert.equal(labels.targetTemplate, '/workbench/label-print.html?keyword={itemNo}', '编号那一格的落点照旧');
  assert.equal(labels.numberPicker, true, '编号选择器照旧开着');
  assert.equal(pages.entryTarget(labels.targetTemplate, 'XHB8095'),
    '/workbench/label-print.html?keyword=XHB8095', '「输入编号 ⇒ 打开既有页面」那条路照旧');
  assert.deepEqual(labels.links.map((link) => link.icon), ['📷', '🖨️'], '两颗图标照旧');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-TR4 扫码页（realm）那句同名文案 —— **不在本次范围**（只报不改）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-TR4 扫码页那句 `labelSingleButton: \'打开标签打印页 →\'` **逐字不动**（不在本次范围 · 只报不改）', () => {
  const realm = readSrc('src/views/scanPageRealm.js');
  assert.ok(realm.includes("labelSingleButton: '打开标签打印页 →'"),
    '🔴 扫码页（realm）那一颗按钮**本次一个字都不许改**（她这次说的是工作台的 domains 页）');
  // ⚠️ 那条同名字面量也在 `test/fixtures/hardcodedChineseWhitelist.json` 的
  //    `views/scanPageRealm.js` 那一档里（存量债）——它**不是**工作台这一处，别误删。
  const whitelist = JSON.parse(readSrc('test/fixtures/hardcodedChineseWhitelist.json'));
  assert.ok((whitelist.files['views/scanPageRealm.js'] || []).includes('打开标签打印页 →'),
    '扫码页那一条仍登记在白名单里（与工作台 domains 页那处**同名但不是同一个地方**）');
});
