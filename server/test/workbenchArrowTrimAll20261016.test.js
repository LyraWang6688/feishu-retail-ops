/**
 * ⭐⭐ 工作台**最后三处多余的箭头行** —— 业务负责人 **2026-10-16** 逐字：
 *    「**我也没看到，可以删除**」
 *
 * 背景（**同一形状 · 同一个判据 · 已有两批先例 ✓**）：
 *   · #699 —— 「货品」页的「扫码打印」/「批量打印」两张卡（`去扫码打印 →` / `打开标签打印页 →`）；
 *   · #703 —— 首页入口卡（`进入 →`）＋ 信息查询两张外链卡（`进入 →`）。
 *   判据 = **整张卡片本身就是链接**（`<a class="entry-card" href=…>` 把 icon / 标题 /
 *   箭头**全包在里面**）⇒ **底下那行箭头没有任何跳转职责、纯多余** ⇒ **删** ✓
 * 本次把 `config/domains.js` 里**剩下的最后三条**（同一形状）按同一判据删掉：
 *    · `sales-accessory` 那张「配品销售」卡 · `arrow: '去填配品销售表单 →'`
 *    · `purchase-suppliers` 那张「供应商名录」卡 · `arrow: '打开名录 →'`
 *    · `product-new` 那张「货品上新」卡 · `arrow: '去填写 →'`
 * 🔴 删完之后 `config/domains.js` 这套渲染里的 `arrow` 集合 = **空集** ✓（见 AC-ATA3 的范围哨兵）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做** —— 她定的流程）
 *
 *  AC-ATA1 那三条箭头**全部退场**（配置面 + 渲染面两路都判）：
 *         改前逐字 = 三个 `arrow:` 键（见上）→ 改后逐字 = **三行整行删掉**。
 *         🔴 反向哨兵：三句旧文案**塞回配置（去注释后）／塞回渲染层就红** ✓。
 *
 *  AC-ATA2 🔴 **跳转能力零变化**（这才是"敢删箭头"的前提）：三张卡**仍然是整张可点的 `<a>`** ——
 *         `cardsHtml` 把配了 `href` 的卡渲染成 `<a class="entry-card" href="…" rel="noopener">`，
 *         卡体（icon / h3）**都在这个 `<a>` 里面** ⇒ 点卡片任意一处都跳 ✓；
 *         `href` / `icon` / `title` / `directJump` **一个字没动** ✓。
 *
 *  AC-ATA3 🔴 **范围哨兵（本次删完 = 空集）**：`config/domains.js` 的 domains 这套渲染
 *         （所有 `page.cards` ∪ `page.links`）里 **`arrow` 一个都不剩**（空数组 · 逐字）；
 *         ⚠️ 且**只动了那三行** —— 其余卡片 / 文案 / 结构逐字不变 ✓。
 *
 *  AC-ATA4 **判据没被放宽** ✗：渲染层 `features/domains/pages.js` 的 `cardsHtml` / `cardBody`
 *         **仍然是"只有显式给了 `arrow` 才画那一行"**（这一条 #699 已改）——
 *         **给了 `arrow` ⇒ 照画且逐字节不变**；**没给 ⇒ 一行都不画**；
 *         🔴 且**不许再长出 `|| '… →'` 兜底**（留兜底 = 删了配置那行反而显示默认箭头 ⇒ **等于没删** ✗）。
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

/** 她 2026-10-16 点掉的**最后三处**旧逐字（逐字）。 */
const OLD_ARROWS = ['去填配品销售表单 →', '打开名录 →', '去填写 →'];

/** 三张卡的"身份证"：`domain/page` + 卡片标题 + 她给的那条 href 来源（`config/links.js` 的常量名）。 */
const TARGET_CARDS = [
  { page: 'sales-accessory', domain: 'sales', title: '配品销售', hrefKey: 'ACCESSORY_SALE_FORM_URL' },
  { page: 'purchase-suppliers', domain: 'purchase', title: '供应商名录', hrefKey: 'SUPPLIER_DIRECTORY_URL' },
  { page: 'product-new', domain: 'product', title: '货品上新', hrefKey: 'PRODUCT_NEW_FORM_URL' },
];

/** 把前端模块复制成 `.mjs` 平铺到临时目录（**只改 import 的文件名，逻辑一个字不改**）。 */
async function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-arrow-all-'));
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
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('features/shared/placeholder.js', 'placeholder.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/domains/pages.js', 'pages.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../shared/placeholder.js'", "from './placeholder.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return { domains: await load('domains'), pages: await load('pages'), links: await load('links') };
}

/** domains 这套渲染里的**全部卡片**（`page.cards` ∪ `page.links`），带所属 domain / page。 */
const allCardsOf = (domains) => domains.DOMAIN_TABS
  .flatMap((domain) => domain.pages.flatMap((page) => [...(page.cards || []), ...(page.links || [])]
    .map((card) => ({ domain: domain.id, page: page.id, pageKind: page.kind, directJump: page.directJump, ...card }))));

const pageOf = (domains, id) => domains.DOMAIN_TABS
  .flatMap((domain) => domain.pages).find((page) => page.id === id);

// ═══════════════════════════════════════════════════════════════════════════
// AC-ATA1 那三条箭头全部退场（配置面 + 渲染面）；旧文案塞回即红
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ATA1 最后三条箭头**全部删掉**（配置 + 渲染两路）；旧文案塞回即红', async () => {
  const { domains, pages } = await loadFrontendModules();
  const cards = allCardsOf(domains);

  // ① ⭐ 改后逐字：三张卡**都不再有 `arrow` 键**（那三行整行删掉）
  for (const target of TARGET_CARDS) {
    const card = cards.find((item) => item.page === target.page && item.title === target.title);
    assert.ok(card, `三张卡之一仍必须在：${target.page}`);
    assert.equal(card.arrow, undefined, `⭐ 改后逐字：不再有 \`arrow\`（那一行删掉了）：${target.page}`);
  }

  // ② ⭐ 渲染面：三张卡各自的 HTML 里**一行 `<div class="arrow">` 都不出现**
  for (const target of TARGET_CARDS) {
    const card = cards.find((item) => item.page === target.page && item.title === target.title);
    const html = pages.cardsHtml([card]);
    assert.equal(/<div class="arrow">/.test(html), false,
      `🔴 渲染面里那张卡**不再画** \`<div class="arrow">\` 那一行：${target.page}`);
  }

  // ③ 🔴 **反向哨兵**：三句旧文案 **塞回配置代码（去注释后）就红**
  const domainsCode = stripComments(read('config/domains.js'));
  for (const gone of OLD_ARROWS) {
    assert.equal(domainsCode.includes(gone), false, `🔴 旧箭头塞回配置就红：${gone}`);
  }
  // ④ 🔴 **反向哨兵能真红**：那句旧文案**塞回卡上**（去注释后的配置面 / 渲染面两路都会亮）
  //    先把三句旧文案按卡对回去（这就是"塞回"的形状），证明渲染面**认得出它** ——
  //    所以"现在渲染面里没有它"是真的判据，不是恒真。
  for (let i = 0; i < TARGET_CARDS.length; i += 1) {
    const target = TARGET_CARDS[i];
    const card = cards.find((item) => item.page === target.page && item.title === target.title);
    const injected = pages.cardsHtml([{ ...card, arrow: OLD_ARROWS[i] }]);
    assert.ok(injected.includes(`<div class="arrow">${OLD_ARROWS[i]}</div>`),
      `🔴 旧箭头塞回卡上 ⇒ 渲染面立刻画出那句话（哨兵能真红）：${target.page}`);
    assert.equal(pages.cardsHtml([card]).includes(`<div class="arrow">${OLD_ARROWS[i]}</div>`), false,
      `⭐ 而现在（已删）那张卡渲染出来没有那一行：${target.page}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ATA2 跳转能力零变化：三张卡仍**整张可点**，href / icon / title / directJump 一个字节没动
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ATA2 🔴 三张卡**仍然整张就是链接**（跳转零变化）：href / icon / title / directJump 逐字不变', async () => {
  const { domains, pages, links } = await loadFrontendModules();
  const cards = allCardsOf(domains);

  for (const target of TARGET_CARDS) {
    const page = pageOf(domains, target.page);
    const card = cards.find((item) => item.page === target.page && item.title === target.title);

    // ① ⭐ **只读核实证据**（她的判据）：配了 `href` 的卡 ⇒ `<a class="entry-card" href=… rel="noopener">`
    //    把 icon / 标题**全包在里面** ⇒ **整张卡就是那个链接**，点卡片任意一处都跳 ✓
    const anchor = `<a class="entry-card" href="${card.href}" rel="noopener">`;
    const html = pages.cardsHtml([card]);
    assert.ok(html.includes(anchor), `⭐ 卡片本体就是那个链接（整张可点）：${target.page}`);
    const body = html.slice(html.indexOf(anchor) + anchor.length).split('</a>')[0];
    assert.ok(/<div class="icon">/.test(body) && /<h3>/.test(body),
      `⭐ 卡体（icon / 标题）确实在 <a> 里面 ⇒ 点卡片任意一处都跳：${target.page}`);
    assert.equal(/<div class="arrow">/.test(body), false, `⭐ 那个 <a> 里已经没有箭头行了：${target.page}`);

    // ② **href 仍逐字来自 `config/links.js`**（单一来源，本次一个字没动）
    assert.equal(card.href, links[target.hrefKey], `href 仍 = config/links.js 的 ${target.hrefKey} ✓`);
    // ③ 图标 / 标题逐字照旧
    assert.ok(card.icon && card.title === target.title, `icon / 标题逐字照旧：${target.page}`);
    // ④ 「点一次就到」的直跳机制照旧（她 2026-10-15/10-12 的机制，本次没动）
    assert.equal(page.kind, 'links', `${target.page} 仍是外链卡页 ✓`);
    assert.equal(page.directJump, true, `${target.page} 仍是"点一次就到" ✓`);
    assert.equal((page.cards || []).length, 1, `${target.page} 仍恰好一张卡（直跳机制要求 ✓）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ATA3 🔴 范围哨兵：本次删完 ⇒ domains 这套渲染里的 arrow 集合 = **空集**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ATA3 🔴 范围哨兵：domains 这套渲染里的 `arrow` 集合**已变成空集**（逐字）', async () => {
  const { domains } = await loadFrontendModules();
  const arrows = allCardsOf(domains).map((card) => card.arrow).filter((arrow) => arrow !== undefined);
  assert.deepEqual(arrows, [],
    '⭐ 本次删完：domains（cards ∪ links）里的 arrow 集合 = 空集（无一处遗留）');

  // 反向证据：配置源码里也**没有任何 `arrow:` 键**（去注释后）—— 注释里的"改前逐字"不算实现
  const domainsCode = stripComments(read('config/domains.js'));
  assert.equal(/(^|\s)arrow\s*:/.test(domainsCode), false,
    '🔴 配置代码里不许再有任何 `arrow:` 键（三行都删干净了）');

  // 范围哨兵的另一半：**只删了那三行** —— 卡片总数 / 标题 / href 集合逐字不变
  const cards = allCardsOf(domains);
  assert.deepEqual(cards.map((card) => card.title).sort(),
    ['供应商名录', '扫码打印', '批量打印', '配品销售', '货品上新'].sort(),
    '⭐ 卡片集合一个字没变（只删了箭头行，没顺手动别的卡）');
  assert.deepEqual(cards.map((card) => card.href).sort(),
    [
      'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnCUHxarWSWhoQRiv6qJeKWh',
      'https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnpZB0eX27B773hsrsyYf3gb',
      'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnX0GlNcSOujePgWOLTTWr4m',
      '/workbench/label-print.html?scan=1',
      '/workbench/label-print.html',
    ].sort(),
    '⭐ 五条 href 逐字不变（跳转零变化）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ATA4 判据没被放宽：渲染层仍"只有显式给了 arrow 才画那一行"，且**不许有兜底**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ATA4 渲染层契约：给了 `arrow` ⇒ 照画（逐字）；没给 ⇒ 一行都不画；**不许有 `||` 兜底**', async () => {
  const { pages } = await loadFrontendModules();

  // ① 没给 arrow ⇒ 那一行一行都不画（不再有默认动作文案兜底）
  const noArrow = pages.cardsHtml([{ title: '甲', href: '/x' }]);
  assert.equal(/<div class="arrow">/.test(noArrow), false,
    '⭐ 没给 `arrow` ⇒ 那一行不画（没有默认「进入 →」/「打开 →」兜底 ✓）');

  // ② 给了 arrow ⇒ 那一行**照画且逐字节不变**（证明这是"删掉那一行"，不是把画箭头的能力拆掉）
  const withArrow = pages.cardsHtml([{ title: '乙', href: '/y', arrow: '去那里 →' }]);
  assert.ok(withArrow.includes('<div class="arrow">去那里 →</div>'),
    '⭐ 显式给了 `arrow` ⇒ 那一行照画、逐字（别的卡不受影响 ✓）');
  assert.equal((withArrow.match(/<div class="arrow">/g) || []).length, 1, '只有给了 arrow 的那一张画了那一行');

  // ③ 🔴 **反向哨兵**：渲染层**不许再长出任何 arrow 的 `||` 兜底**
  //    （留兜底 = 删了配置那行反而显示默认箭头 ⇒ **等于没删** ✗）
  //    ⚠️ 只钉**箭头本身**的兜底（`card.arrow || '…'` / `arrow || '…'`）：
  //       · `pages.js:95` 的 `${escapeHtml(page.buttonLabel || '打开 →')}` 是**表单提交按钮**
  //         的缺省文案（每页都配了 `buttonLabel`），**不是**箭头行 ✗；
  //       · 同一行里 `${escapeHtml(card.title || '')}` 是**标题**的兜底，也**不是**箭头 ✗。
  const pagesCode = stripComments(read('features/domains/pages.js'));
  assert.equal(/(\bcard\.arrow|\barrow)\s*\|\|/.test(pagesCode), false,
    "🔴 渲染层不许给箭头配任何 `|| '… →'` 兜底（塞回即红）");
  const arrowLines = pagesCode.split('\n').filter((line) => line.includes('arrow'));
  assert.ok(arrowLines.includes('        <div class="arrow">${escapeHtml(arrow)}</div>` : \'\'}`;'),
    '⭐ 箭头那一行仍是"只有 `arrow` 为真才画"的逐字形状（#699 改的那一条还在 ✓）');
  assert.ok(pagesCode.includes('cardBody(card, card.arrow)'),
    '⭐ `cardsHtml` 仍把 `card.arrow` 传给 `cardBody`（没绕开渲染层 ✗）');
  assert.ok(/cardBody\s*=\s*\(card,\s*arrow\)/.test(pagesCode),
    '⭐ `cardBody` 仍以 `arrow` 形参做真值判断（能力没被拆掉 ✓）');
});
