/**
 * ⭐⭐ 工作台**另外两处多余的箭头行** —— 业务负责人 **2026-10-16** 逐字：
 *    「**虽然我看不到，但是没用，所以也可以删除掉！**」
 *
 * 背景（**同一形状 · 同一个判据 · 已有先例 ✓**）：她当天已经点掉过两处
 *    （「货品」页的「扫码打印」/「批量打印」两张卡，PR #699）——
 *    判据 = **整张卡片本身就是链接**（`<a class="entry-card" href=…>` 把 icon / 标题 /
 *    说明 / 箭头**全包在里面**）⇒ **底下那行箭头没有任何跳转职责、纯多余** ✓
 * 本次把**同形状**的另两处按同一个判据删掉：
 *    ① **首页入口卡**（`features/common/index.js` 的渲染行 ＋ `config/home.js` 两行 `arrow: '进入 →'`）
 *    ② **信息查询两张外链卡**（`features/query/index.js` 的 `cardBody(section, '进入 →')`）
 * 🔴 **别的箭头一个字不动**：`config/domains.js` 那三处（去填配品销售表单 → / 打开名录 → / 去填写 →）
 *    —— 她这次没点它们（见 AC-AR4 的范围哨兵）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做** —— 她定的流程）
 *
 *  AC-AR1 ① **改前逐字** `<div class="arrow">${escapeHtml(entry.arrow || '进入 →')}</div>`
 *           （永远画一行，缺省「进入 →」）→ **改后逐字**：**只有配置里显式给了 `arrow`
 *           才画那一行**；`config/home.js` 那两行 `arrow: '进入 →'` **整行删掉**。
 *         🔴 反向哨兵：旧文案 `进入 →` **塞回配置（去注释后）或渲染面就红**；
 *            兜底 `entry.arrow ||` / `|| '进入 →'` **塞回渲染层就红**
 *            （⚠️ 留兜底 = 删了配置那行反而显示「进入 →」，**等于没删** ✗）。
 *         正向：两张卡的 `href` / `rel="noopener"` / **整张卡可点** 一个字没动（跳转零变化）✓。
 *
 *  AC-AR2 ② 有 URL 的外链卡**不再画那一行**（改前逐字 `cardBody(section, '进入 →')`）；
 *         ⚠️ **空 URL 的 `disabled-card`（「链接待配置」）按它自己的语义保留** ✓
 *            —— 它**不是链接**（`<div class="entry-card disabled-card" aria-disabled="true">`），
 *            那行**不是**"快点点我"的提示语，而是**卡面的如实交代** ⇒ 别顺手删 ✗。
 *         🔴 反向哨兵：`进入 →` **塞回渲染层（去注释后）就红**。
 *
 *  AC-AR3 渲染层契约：**显式给了 `arrow` ⇒ 照画（逐字）**；**没给 ⇒ 一行都不画**
 *         —— 证明这是"**删掉那一行**"，不是把画箭头的能力整个拆掉（**不是放宽** ✓）。
 *
 *  AC-AR4 🔴 **范围哨兵**：她这次**没点**的另外三处箭头**逐字仍在**
 *         （`config/domains.js`：`去填配品销售表单 →` / `打开名录 →` / `去填写 →`）。
 *
 * ⚠️ 判据**不靠子串锚点凑数**：都是**整行 / 整句**逐字比较；
 *    且"有没有那句话"是在**去注释后**的源码上判的（历史沿革写在注释里，不算实现）。
 * 🔴 本文件只开 PR，**不部署**（业务负责人 2026-10-07 口径：禁止自行部署）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 去掉注释再对"代码里有没有某件事"下结论 —— 注释里写"改前逐字"那段沿革不算实现。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 她 2026-10-16 点掉的这一处**旧逐字**（首页入口卡那行箭头文案）。 */
const OLD_HOME_ARROW = '进入 →';

/** 🔴 她这次**没点**的三处箭头（范围哨兵，逐字）。 */
const UNTOUCHED_ARROWS = ['去填配品销售表单 →', '打开名录 →', '去填写 →'];

/** 把前端模块复制成 `.mjs` 平铺到临时目录（**只改 import 的文件名，逻辑一个字不改**）。 */
async function loadModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-arrow2-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('core/formatters.js', 'formatters.mjs');
  copy('config/links.js', 'links.mjs');
  copy('config/home.js', 'home.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('features/common/index.js', 'common.mjs', [
    ["from '../../config/home.js'", "from './home.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/query/index.js', 'query-index.mjs', [
    ["from '../../config/links.js'", "from './links.mjs'"],
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    home: await load('home'),
    query: await load('query'),
    common: await load('common'),
    queryIndex: await load('query-index'),
    domains: await load('domains'),
  };
}

/** 用假容器渲染一个模块，返回它写进去的 HTML（`mount()` 只写 innerHTML，不需要真 DOM）。 */
async function render(modulePromise, factoryName, options) {
  const module = await modulePromise;
  const container = { innerHTML: '' };
  module[factoryName](options).mount(container);
  return container.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════════════
// AC-AR1 ① 首页入口卡：整张卡可点 ⇒ 那行箭头删掉（跳转能力零变化）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AR1 ① 首页入口卡**整张就是链接** ⇒ 那行箭头删了；旧文案 / 兜底塞回即红', async () => {
  const modules = await loadModules();
  const html = await render(modules.common, 'createCommonModule');
  const home = await modules.home;

  // ① ⭐ **只读核实证据**（她的判据）：`<a class="entry-card…" href=… rel="noopener">` 把
  //    icon / 标题 / 说明**全包在里面** ⇒ **整张卡就是那个链接**，点卡片任意一处都跳 ✓
  for (const entry of home.COMMON_ENTRIES) {
    const anchor = `<a class="entry-card${entry.wide ? ' entry-wide' : ''}" href="${entry.href}" rel="noopener">`;
    assert.ok(html.includes(anchor), `⭐ 卡片本体就是那个链接（整张可点）：${entry.href}`);
    const cardHtml = html.slice(html.indexOf(anchor) + anchor.length).split('</a>')[0];
    assert.ok(/<div class="icon">/.test(cardHtml) && /<h3>/.test(cardHtml) && /<p>/.test(cardHtml),
      `⭐ 卡体（icon / 标题 / 说明）确实在 <a> 里面 ⇒ 那行箭头没有跳转职责：${entry.href}`);
  }

  // ② ⭐ **改后逐字**：配置里没有 `arrow` 键（那两行整行删掉）＋ 渲染面一行都不画
  assert.deepEqual(home.COMMON_ENTRIES.map((entry) => entry.arrow), [undefined, undefined],
    '⭐ 改后逐字：两条入口都不再有 `arrow`（`config/home.js` 那两行删掉了）');
  assert.equal(/<div class="arrow">/.test(html), false,
    '🔴 渲染面里那两张卡**不再画 `<div class="arrow">`** 那一行');

  // ③ **跳转能力零变化**（这才是"删箭头"敢做的前提）：href / 标题 / rel 全照旧
  assert.deepEqual(home.COMMON_ENTRIES.map((entry) => entry.href),
    ['/workbench/inventory-adjustment.html', '/workbench/label-print.html'],
    '两颗 href 逐字照旧（跳转没变）');
  assert.deepEqual(home.COMMON_ENTRIES.map((entry) => entry.title), ['库存手工调整', '鞋盒标签打印'],
    '两颗标题逐字照旧');
  assert.equal((html.match(/rel="noopener"/g) || []).length, 2, '两张卡的 rel="noopener" 照旧');

  // ④ 🔴 **反向哨兵**：旧箭头文案 **塞回配置代码（去注释后）／渲染面** 就红
  assert.equal(stripComments(read('config/home.js')).includes(OLD_HOME_ARROW), false,
    `🔴 旧箭头文案塞回配置就红：${OLD_HOME_ARROW}`);
  assert.equal(html.includes(OLD_HOME_ARROW), false,
    `🔴 旧箭头文案塞回渲染面就红：${OLD_HOME_ARROW}`);

  // ⑤ 🔴 **反向哨兵**：兜底 `entry.arrow || …` / `|| '进入 →'` **塞回渲染层就红**
  //    （留兜底 = 删了配置那行反而显示「进入 →」= **等于没删** ✗）
  const commonCode = stripComments(read('features/common/index.js'));
  assert.equal(/\|\|\s*'进入 →'/.test(commonCode), false,
    "🔴 兜底 `|| '进入 →'` 塞回渲染层就红");
  assert.equal(/entry\.arrow\s*\|\|/.test(commonCode), false,
    '🔴 渲染层不许再给 `entry.arrow` 配任何兜底');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AR2 ② 信息查询两张外链卡：整张卡可点 ⇒ 那行箭头删掉；空 URL 那种按自己的语义保留
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AR2 ② 信息查询外链卡**整张就是链接** ⇒ 那行箭头删了；「链接待配置」那一种保留', async () => {
  const modules = await loadModules();
  const [query, queryIndex] = await Promise.all([modules.query, modules.queryIndex]);

  const html = queryIndex.renderQueryEntries(query.QUERY_SECTIONS);
  // ① ⭐ **只读核实证据**：`<a class="entry-card" href=… rel="noopener">` 把卡体（icon / 标题）
  //    全包在里面 ⇒ 整张卡可点、那行箭头没有跳转职责 ✓
  for (const section of query.QUERY_SECTIONS) {
    const anchor = `<a class="entry-card" href="${section.href}" rel="noopener">`;
    assert.ok(html.includes(anchor), `⭐ 卡片本体就是那个链接（整张可点）：${section.id}`);
    const cardHtml = html.slice(html.indexOf(anchor) + anchor.length).split('</a>')[0];
    assert.ok(/<div class="icon">/.test(cardHtml) && /<h3>/.test(cardHtml),
      `⭐ 卡体确实在 <a> 里面 ⇒ 点卡片任意一处都跳：${section.id}`);
  }
  // ② ⭐ 改后逐字：两张外链卡都不再画那一行
  assert.equal(/<div class="arrow">/.test(html), false,
    '🔴 两张外链卡**不再画 `<div class="arrow">`** 那一行');
  assert.equal(html.includes(OLD_HOME_ARROW), false, '🔴 渲染面里不许再出现旧箭头文案「进入 →」');

  // ③ ⚠️ **空 URL 的 `disabled-card` 按它自己的语义保留** —— 它不是链接，那行是如实交代
  const pending = queryIndex.renderQueryEntries([{ id: 'sales-query', icon: '📈', title: '销售查询', href: '' }]);
  assert.ok(pending.includes('<div class="entry-card disabled-card" aria-disabled="true">'),
    '空 URL ⇒ 不可点的卡（照旧，绝不产生空 href）');
  assert.ok(pending.includes(`<div class="arrow">${queryIndex.LINK_PENDING_TEXT}</div>`),
    '⭐ 「链接待配置」那一行**照旧逐字画**（按它自己的语义保留 ✓）');
  assert.equal(pending.includes('<a'), false, '空 URL 那一块仍然不是 <a>');

  // ④ 🔴 **反向哨兵**：`进入 →` 塞回渲染层（**去注释后**的源码）就红
  const queryCode = stripComments(read('features/query/index.js'));
  assert.equal(queryCode.includes(OLD_HOME_ARROW), false,
    `🔴 旧箭头文案塞回 features/query/index.js 就红：${OLD_HOME_ARROW}`);
  assert.equal(/cardBody\(section,\s*'[^']*'\)/.test(queryCode), false,
    '🔴 外链卡调用点不许再给 `cardBody` 传死文案（只有 disabled 那一种按自己语义传 `LINK_PENDING_TEXT`）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AR3 渲染层契约：给了 arrow 照画（逐字）；没给一行都不画（不是把能力拆掉）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AR3 渲染层契约：**显式给了 `arrow` ⇒ 照画（逐字）**；没给 ⇒ 一行都不画', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-arrow2-stub-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('core/formatters.js', 'formatters.mjs');
  // 用一份**桩配置**（一张显式给了 arrow、一张没给）验证渲染层契约
  fs.writeFileSync(path.join(dir, 'home.mjs'), [
    'export const COMMON_ENTRIES = [',
    "  { id: 'a', icon: '🅰️', title: '有箭头的卡', desc: '甲', href: '/a.html', arrow: '去那里 →', wide: true },",
    "  { id: 'b', icon: '🅱️', title: '没箭头的卡', desc: '乙', href: '/b.html' },",
    '];',
    '',
  ].join('\n'), 'utf8');
  copy('features/common/index.js', 'common.mjs', [
    ["from '../../config/home.js'", "from './home.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);

  const html = await render(import(pathToFileURL(path.join(dir, 'common.mjs')).href), 'createCommonModule');

  assert.ok(html.includes('<div class="arrow">去那里 →</div>'),
    '⭐ 显式给了 `arrow` ⇒ 那一行**照画、逐字**（别的卡不受影响 ✓）');
  assert.equal((html.match(/<div class="arrow">/g) || []).length, 1,
    '只有给了 arrow 的那一张画了那一行');
  const plainCard = html.slice(html.indexOf('href="/b.html"')).split('</a>')[0];
  assert.equal(/<div class="arrow">/.test(plainCard), false,
    '⭐ 没给 `arrow`（也没有配置兜底）⇒ 那一行**一行都不画**');
  assert.equal(plainCard.includes(OLD_HOME_ARROW), false,
    '🔴 没给 arrow 时**不许**再冒出缺省「进入 →」（兜底已退场）');
  assert.ok(html.includes('<a class="entry-card entry-wide" href="/a.html" rel="noopener">')
    && html.includes('<a class="entry-card" href="/b.html" rel="noopener">'),
  '两张卡仍然是整张可点的 `<a href>`（跳转能力没被拆掉 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AR4 范围哨兵：她这次**没点**的另外三处箭头逐字仍在
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AR4 🔴 范围哨兵：她没点的另外三处箭头（domains.js）逐字仍在', async () => {
  const modules = await loadModules();
  const domains = await modules.domains;

  const arrows = domains.DOMAIN_TABS.flatMap((domain) => domain.pages)
    .flatMap((page) => [...(page.cards || []), ...(page.links || [])])
    .map((card) => card.arrow).filter((arrow) => arrow !== undefined).sort();
  assert.deepEqual(arrows, [...UNTOUCHED_ARROWS].sort(),
    '⭐ 只有她点的那两处（首页入口卡 / 信息查询外链卡）退场，其余三条箭头一个字没动');

  const source = stripComments(read('config/domains.js'));
  for (const arrow of UNTOUCHED_ARROWS) {
    assert.ok(source.includes(arrow), `🔴 这三处箭头逐字仍在：${arrow}`);
  }
});
