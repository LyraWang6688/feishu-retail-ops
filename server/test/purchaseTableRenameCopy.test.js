/**
 * ⭐⭐ 2026-10-12（业务负责人把两张表改名，Lead 定口径）：**用户可见文案里的旧表名要清掉**
 *
 * 她的改名（tableId 不变，schema 已同步并部署 v0.4.3）：
 *   · 「报货批次」→ **「采购主表」**（语义键 `purchaseOrderBatch`）
 *   · 「报货信息」→ **「采购明细」**（语义键 `purchaseRequest`）
 *
 * Lead 定的口径：
 *   ① **她看得见的文案**（卡片标题 / 报错 / 提示）用**业务口径**：**「采购单」** / **「采购明细」**；
 *   ② **日志 label** 与 schema 语义键一致 ⇒ 用 **「采购主表」**；
 *   ③ ⚠️ **注释里的旧表名不动**（约 188 处：那是表名沿革与历史决策的记录，churn 大、零功能影响）；
 *   ④ ⚠️ **字段名「报货批次号」不动** —— 它在生产真表里**没有被改名**（她的改名是**表名**），
 *      值域还是 `CGD-…`；文案里显示的是**这一列的名字**，改了反而与她在 Base 里看到的列名对不上。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**）
 *
 *  AC-R1 **源码哨兵**：`src/**` 的**字符串字面量**里不许再出现
 *         `报货信息` / **裸的** `报货批次`（`报货批次号` 放行）；**注释一律跳过**。
 *  AC-R2 **扫描器自身的可信度**：对"正则里的引号 / 字符串里的 `//` / 注释里的词 /
 *         HTML 注释 / 字段名放行"这几类陷阱给对结论（防哨兵自己漂）。
 *  AC-R3 改后的**新叫法逐字**在正确的位置（她要看到的 5 处文案）。
 *  AC-R4 用户可见字符串里**只允许**留下"字段名"这一类（白名单 = `报货批次号`），
 *         即：没有漏改的表名文案。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
/** 工作台前端（含那个**没有挂载点**的老「采购管理」页）——2026-10-12 起也纳入哨兵。 */
const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const OLD_TABLE_BATCH = '报货批次';
const OLD_TABLE_REQUEST = '报货信息';
/** 字段名（生产真列名，**不许动**）：它出现在文案里是"这一列的名字"，不是表名。 */
const FIELD_NAME = '报货批次号';

// ── 字符串感知的注释剥离（**哨兵本体**；AC-R2 单独钉它）──────────────────────
// 为什么要自己写：仓库里没有 JS 解析器依赖（`devDependencies` 只有 nodemon），
// 而**正则字面量里的引号**（例：`/['"]/`）会让"只看引号"的朴素状态机漂掉 ——
// 2026-10-12 第一次扫的时候就漂过一次（把 JSDoc 里的一行当成了字符串）。
const REGEX_START_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>']);

/** 返回逐字符判定表：`string`（字面量，含模板）/ `comment` / `code`。 */
const classify = (src) => {
  const kinds = new Array(src.length).fill('code');
  let i = 0;
  let state = 'code';
  let prev = '';
  let templateStack = 0;
  const mark = (index, kind) => { if (index >= 0 && index < src.length) kinds[index] = kind; };
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1] || '';
    if (state === 'code') {
      if (ch === '/' && next === '/') { mark(i, 'comment'); mark(i + 1, 'comment'); state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { mark(i, 'comment'); mark(i + 1, 'comment'); state = 'block'; i += 2; continue; }
      // 正则字面量：只在前一个有效字符"不可能结束一个表达式"时才算正则（经典启发式）
      if (ch === '/' && REGEX_START_PREV.has(prev)) { state = 'regex'; i += 1; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { state = ch; mark(i, 'string'); i += 1; continue; }
      if (ch === '}' && templateStack > 0) { templateStack -= 1; state = '`'; i += 1; continue; }
      if (!/\s/.test(ch)) prev = ch;
      i += 1; continue;
    }
    if (state === 'line') { mark(i, 'comment'); if (ch === '\n') state = 'code'; i += 1; continue; }
    if (state === 'block') {
      mark(i, 'comment');
      if (ch === '*' && next === '/') { mark(i + 1, 'comment'); i += 2; state = 'code'; continue; }
      i += 1; continue;
    }
    if (state === 'regex') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') { const end = src.indexOf(']', i + 1); i = end < 0 ? i + 1 : end + 1; continue; }
      if (ch === '/') { state = 'code'; prev = '/'; i += 1; continue; }
      if (ch === '\n') { state = 'code'; i += 1; continue; }
      i += 1; continue;
    }
    // 字符串 / 模板字面量
    mark(i, 'string');
    if (ch === '\\') { mark(i + 1, 'string'); i += 2; continue; }
    if (state === '`' && ch === '$' && next === '{') { mark(i + 1, 'string'); templateStack += 1; state = 'code'; prev = '{'; i += 2; continue; }
    if ((state === '"' && ch === '"') || (state === "'" && ch === "'") || (state === '`' && ch === '`')) {
      state = 'code'; prev = ch; i += 1; continue;
    }
    i += 1; continue;
  }
  return kinds;
};

/** `<!-- … -->` 是**注释**（只是它写在模板字面量里）⇒ 一并跳过。 */
const htmlCommentRanges = (src) => {
  const ranges = [];
  let at = 0;
  while (true) {
    const start = src.indexOf('<!--', at);
    if (start < 0) break;
    const end = src.indexOf('-->', start + 4);
    ranges.push([start, end < 0 ? src.length : end + 3]);
    at = end < 0 ? src.length : end + 3;
  }
  return ranges;
};
const inRanges = (ranges, index) => ranges.some(([start, end]) => index >= start && index < end);

/** 命中的所有**字符串字面量**位置（注释 / HTML 注释一律跳过）。 */
const literalHits = (src, words) => {
  const kinds = classify(src);
  const html = htmlCommentRanges(src);
  const hits = [];
  for (const word of words) {
    let at = 0;
    while (true) {
      const index = src.indexOf(word, at);
      if (index < 0) break;
      at = index + 1;
      if (kinds[index] !== 'string' || inRanges(html, index)) continue;
      hits.push({ word, index, line: src.slice(0, index).split('\n').length });
    }
  }
  return hits;
};

const walkJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === 'node_modules') return [];
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walkJs(full);
  return /\.(js|mjs)$/.test(entry.name) ? [full] : [];
});
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// AC-R2 先钉扫描器本身（哨兵自己漂了比没有哨兵更坏）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R2 扫描器可信度：正则里的引号 / 字符串里的 `//` / 注释里的词 / HTML 注释 / 字段名放行', () => {
  // ① 正则字面量里的引号**不许**让状态机漂掉（2026-10-12 真漂过一次）：
  //    漂了的后果是"后面的注释被当成字符串"或"后面的字符串被当成注释"。
  //    探针：第 1 行正则带引号 → 第 2 行注释里放旧词（**必须跳过**）
  //         → 第 3 行字符串里放旧词（**必须命中**）。两个都对 = 没漂。
  const regexQuote = "const re = /['\"]/g;\n// 报货批次 在注释里\nconst keep = '报货批次';\n";
  assert.deepEqual(literalHits(regexQuote, [OLD_TABLE_BATCH]).map((hit) => hit.line), [3],
    '正则里的引号不许让状态机漂掉：注释那行跳过、第 3 行的字符串照旧命中');
  // ② 字符串里的 `//` 不是注释
  const urlInString = "const url = 'https://example.com/报货批次';\n";
  assert.deepEqual(literalHits(urlInString, [OLD_TABLE_BATCH]).map((hit) => hit.line), [1],
    '字符串里的 `//` 不许被当成注释（否则会漏报）');
  // ③ 行注释 / 块注释 / JSDoc 里的词一律跳过
  const commentsOnly = "// 报货批次\n/* 报货信息 */\n/**\n * 报货批次 → 采购主表\n */\nconst x = 1;\n";
  assert.deepEqual(literalHits(commentsOnly, [OLD_TABLE_BATCH, OLD_TABLE_REQUEST]), [],
    '注释里的旧表名**故意不管**（表名沿革/历史决策的记录）');
  // ④ HTML 注释（写在模板字面量里）也跳过
  const htmlComment = "const html = `<!-- 数据来自「报货批次」 --><div>采购单</div>`;\n";
  assert.deepEqual(literalHits(htmlComment, [OLD_TABLE_BATCH]), [], 'HTML 注释 = 注释');
  // ⑤ 字段名放行由调用方（AC-R1）判断，这里确认扫描器**如实报出**它的位置
  const field = "const label = '报货批次号：CGD-1';\n";
  assert.equal(literalHits(field, [OLD_TABLE_BATCH]).length, 1, '字段名能被扫到 ⇒ 由 AC-R1 用"后一个字是不是「号」"放行');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R1 源码哨兵（`src/**`）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R1 源码哨兵：`src/**` ＋ `public/workbench/**` 的字符串字面量里不再出现旧表名（`报货批次号` 字段名放行；注释跳过）', () => {
  const offenders = [];
  // ⚠️ 2026-10-12：范围从 `src/**` 扩到**也扫工作台前端** —— 那个**没有挂载点**的老「采购管理」页
  //    里的旧文案那一轮也清了（不扫它 = 清完就会回潮）。
  // ⭐ 2026-10-15：那一页 `features/purchase/**` **已被整目录删除**（她：「是死代码，给删除了吧」）
  //    ⇒ 本哨兵照旧扫整个 `public/workbench/**`（范围一个字没缩：将来别的页写回旧表名照样红 ✓）。
  for (const [root, file] of [
    ...walkJs(SRC).map((file) => [SRC, file]),
    ...walkJs(WORKBENCH).map((file) => [WORKBENCH, file]),
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const hit of literalHits(src, [OLD_TABLE_BATCH, OLD_TABLE_REQUEST])) {
      // 字段名「报货批次号」放行：她改名改的是**表名**，这一列在生产真表里没改名。
      if (hit.word === OLD_TABLE_BATCH && src.slice(hit.index, hit.index + FIELD_NAME.length) === FIELD_NAME) continue;
      offenders.push(`${path.relative(root, file)}:${hit.line}: ${hit.word}`);
    }
  }
  assert.deepEqual(offenders, [],
    '用户可见字符串里不许再出现旧表名（注释按 Lead 口径不动；字段名「报货批次号」放行）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R3 新叫法逐字（她要看到的那几处）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R3 新叫法逐字：给她看的用「采购单」/「采购明细」，日志 label 用「采购主表」', () => {
  // ① 9 点推送的采购区标题（她每早在群里看到的那一行）
  assert.ok(readSrc('config/pendingDealPush.js').includes("purchaseAreaTitle: '【采购】未到货的采购单：{count} 批'"),
    '采购区标题要用「采购单」');
  // ② 工作台验收：找不到那一批时的报错
  const arrival = readSrc('services/workbenchPurchaseArrivalService.js');
  assert.ok(arrival.includes('没找到采购单 ${wanted} 的采购明细'), '报错用「采购单 X 的采购明细」');
  assert.equal(arrival.includes('没找到报货批次'), false);
  // ③ 到货入库：找不到那一批时的报错（业务口径）
  //   ⭐ 2026-10-18 成对迁移（task-6 文件大小门禁）：`writeArrivalAcceptance` / `nextBatchNo` /
  //     `writeSupplierImageAttachment` 的方法体原样搬进 `services/purchase/{arrival,postingPlan,documentImages}.js`
  //     ⇒ 改前逐字只读 `purchaseWebhookService.js`，改后逐字把**代码搬过去的三个文件**一并读；
  //     **每一条断言文本与正则逐字未动**（不是放宽 —— 少一处仍然红）。
  const webhook = readSrc('services/purchaseWebhookService.js')
    + readSrc('services/purchase/arrival.js')
    + readSrc('services/purchase/postingPlan.js')
    + readSrc('services/purchase/documentImages.js');
  assert.ok(webhook.includes('这一批在采购单里找不到'), '群/工作台会念到的报错用「采购单」');
  assert.equal(/「报货批次」里找不到/.test(webhook), false);
  // ④ 日志 label 与 schema 语义键一致 ⇒ 「采购主表」
  assert.ok(webhook.includes("label: '采购主表'"), '日志 label = 采购主表');
  // ⑤ 开发者可见的配置/映射报错也同步（含表名）
  assert.ok(webhook.includes('未配置「采购主表」的表 ID'), '表 ID 未配置的报错同步新表名');
  assert.ok(readSrc('services/purchaseOrderBatchService.js').includes('「采购主表」未配置「单据」字段映射'));
  // ⑥ 两条内部 hint（人话、排查可见）
  assert.ok(readSrc('services/purchaseArrivalConversationService.js')
    .includes('「采购主表」的到货状态没改成已到货'));
  assert.ok(webhook.includes('这一批在「采购主表」里没有行'));
  // ⑦ 工作台订单列表：采购那一段的空态
  const ordersCopy = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'workbench', 'config', 'orders.js'), 'utf8',
  );
  assert.ok(ordersCopy.includes("purchaseEmpty: '还没有采购单记录'"), '采购子页空态用「采购单」');
  assert.equal(ordersCopy.includes('（报货批次）'), false);
  // ⑧ ⚠️⚠️ 2026-10-15 **判据迁移 + 死代码删除**（业务负责人逐字：「**采购页的老文件是死代码，给删除了吧**」）——
  //   改前逐字：
  //     `const deadPage = fs.readFileSync(path.join(WORKBENCH, 'features', 'purchase', 'index.js'), 'utf8');`
  //     ＋对着它断言 `采购明细与到货核对情况` / `>采购明细情况</button>` / `正在加载采购明细…` /
  //       `没有匹配的采购明细。` 都在、`报货信息` 不在、文件头写着「**已无挂载点**」（"留给 C5 评估"）。
  //   改后逐字：下面三条 ——
  //     ① 那个目录**整个不存在了**（"留给 C5"那个钩子**收口**，能真红）；
  //     ② "给她看的字必须用当下表名「采购明细」"这条**真判据**迁到**活着的**采购文案
  //        （`config/orders.js` 的明细三条：标题 / 空态 / 读失败）；
  //     ③ 旧表名「报货信息」在活文案里不许出现。
  //   依据：老页已删 ⇒ 对着一具不存在的文件断言毫无意义；但这两句判据的本意
  //     （用当下表名、旧名不许回来）**一个字没变** ⇒ 必须迁到活页面上继续钉 ✗ 不许跟着死文件消失。
  assert.equal(fs.existsSync(path.join(WORKBENCH, 'features', 'purchase')), false,
    '老「采购管理」页必须已整目录删除（那正是当年"留给 C5"的那个钩子 ⇒ 现在收口 ✓）');
  for (const needle of [
    "detailTitle: '这一批的采购明细'",
    "detailEmpty: '这一批没有可验收的采购明细'",
    "detailFailed: '这一批的采购明细没读到，请稍后再试'",
  ]) {
    assert.ok(ordersCopy.includes(needle), `活着的采购文案要用当下表名「采购明细」：${needle}`);
  }
  assert.equal(ordersCopy.includes('报货信息'), false, '活着的采购文案里不该再有旧表名「报货信息」');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R4 白名单：用户可见字符串里只允许留"字段名"这一类
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R4 白名单核对：src 里剩下的字符串命中**全部**是字段名「报货批次号」', () => {
  const remaining = [];
  for (const file of walkJs(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const hit of literalHits(src, [OLD_TABLE_BATCH, OLD_TABLE_REQUEST])) {
      if (hit.word === OLD_TABLE_REQUEST) { remaining.push(`${path.relative(SRC, file)}:${hit.line}: 报货信息`); continue; }
      const tail = src.slice(hit.index, hit.index + FIELD_NAME.length);
      if (tail !== FIELD_NAME) remaining.push(`${path.relative(SRC, file)}:${hit.line}: 裸的报货批次`);
      else remaining.push(`${path.relative(SRC, file)}:${hit.line}: 字段名 ${FIELD_NAME}（放行）`);
    }
  }
  // 每一处都必须带"字段名…（放行）"标记 —— 有裸的或 报货信息 就会出现在报告里
  const offenders = remaining.filter((line) => !line.includes('（放行）'));
  assert.deepEqual(offenders, [], '除了字段名，src 的用户可见字符串里不该再有任何旧表名');
  assert.ok(remaining.length > 0, '字段名那条白名单本身也要有实际命中（否则这条白名单是空的）');
});
