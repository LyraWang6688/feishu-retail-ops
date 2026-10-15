'use strict';

/**
 * ownerRequestsBacklog.test.js —— 「她的口径总账」与「防丢规则」的哨兵。
 *
 * ## 来历（业务负责人 2026-10-16 00:2x 的批评 · 逐字）
 * > 「**我发现你总是丢任务**，比如销售页那个**全付、未付逻辑我都说了是对比差额，说了两天了，还是没改**」
 *
 * ⇒ 立了两件：① `docs/owner-requests-backlog.md`（**她的口径总账 = 单一来源**）
 *   ② `AGENTS.md` 第 17 条（**她的任何口径 ⇒ 当场进总账 + 建任务**；**清单不可信先核 `git log`/PR**）
 *
 * ## 钉住四条（都能真红）
 * - **AC-B1** 总账里**上面点名的每条都在**（原话锚点）＋ 每行**六项齐全**
 *   （原话 · 日期 · 状态 · owner · 判据 · 落点）—— 删一列 ⇒ 红
 * - **AC-B2** 每行都能追到**她的原话（「」）与日期**（`2026-10-xx`）；
 *   **`待确认` 的行允许没有日期**（但必须写明「待确认」）—— 塞一行无据的 ⇒ 红
 * - **AC-B3** 板务清理记录**逐条可核**（completed 的必须带 PR 号；**未收口的必须写明"不收口"**）
 * - **AC-B4** `AGENTS.md` 里那条规则**在**（删掉它 ⇒ 红）—— 源码哨兵
 *
 * ⚠️ 只读静态检查：不联网、不碰任何 Base、不改任何东西 ✓（纯 `fs` 读两个文件）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const backlogPath = path.join(repoRoot, 'docs', 'owner-requests-backlog.md');
const agentsPath = path.join(repoRoot, 'AGENTS.md');

const backlog = fs.readFileSync(backlogPath, 'utf8');
const agents = fs.readFileSync(agentsPath, 'utf8');

/** 只用这五个状态值（表头承诺的那套）。 */
const STATUSES = ['未开始', '在做', '已上线', '暂停', '待确认'];

/** 解析总账里的**条目行**（形如 `| **R-01** | 原话 | 日期 | 状态 | owner | 判据 | 落点 |`）。 */
const parseRows = (source) => {
  const rows = [];
  let section = '';
  for (const line of source.split('\n')) {
    const heading = line.match(/^##\s+([A-F])\.\s*(.*)$/);
    if (heading) { section = heading[1]; continue; }
    if (!/^\|\s*\*\*R-\d+\*\*\s*\|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // ['', '#', 原话, 日期, 状态, owner, 判据, 落点, ''] ⇒ 9
    rows.push({ section, id: cells[1], quote: cells[2], date: cells[3], status: cells[4], owner: cells[5], criteria: cells[6], landing: cells[7], raw: line });
  }
  return rows;
};

const rows = parseRows(backlog);

test('AC-B0 ⭐ 总账存在、且**解析得到条目**（解析器不能是空转的）', () => {
  assert.ok(fs.existsSync(backlogPath), '必须存在 docs/owner-requests-backlog.md');
  assert.ok(rows.length >= 15, `总账条目太少（实得 ${rows.length} 行）——她点名的那些至少 15 条`);
});

test('AC-B1 🔴 她点名的那些口径**每条都在**（原话锚点）＋ 每行**六项齐全**', () => {
  // ① 她点名的口径必须都有对应条目（锚点取她原话里的特征词）
  // ⚠️ 锚点只在**条目行的原话列**里找 —— 不能拿文件开头的批评引文充数 ✗
  //   （本轮真踩到：第一版扫全文 ⇒ 删掉 R-01 那条还是绿的 ✗）
  const quoteText = rows.map((row) => row.quote).join('\n');
  const REQUIRED_ANCHORS = [
    '全付',              // R-01 去单选（**她说了两天的那条**）
    '加行',              // R-02 付款方式支持自定义加行
    '不用填金额',         // R-03 补货不问整单金额
    '验收原话',           // R-04 到货说明文案
    '留空按货品单价',      // R-05 留空按货品单价
    '可不填',            // R-08 实收金额文案 vs 校验
    '还是没有反应',        // R-07 P0 点了没反应
    '异步',              // R-06 补货/退货异步
  ];
  const missing = REQUIRED_ANCHORS.filter((anchor) => !quoteText.includes(anchor));
  assert.deepEqual(missing, [], `总账的**条目行**里缺这些她点名的口径：${missing.join(' / ')}`);

  // ② 每行六项齐全
  const incomplete = [];
  for (const row of rows) {
    const problems = [];
    if (!row.quote) problems.push('原话');
    if (!row.date) problems.push('日期');
    if (!row.status) problems.push('状态');
    if (!row.owner) problems.push('owner');
    if (!row.criteria) problems.push('判据');
    if (!row.landing) problems.push('落点');
    if (!/^R-\d+$/.test(row.id.replace(/\*/g, ''))) problems.push('#');
    if (problems.length) incomplete.push(`${row.id}：缺 ${problems.join('/')}`);
  }
  assert.deepEqual(incomplete, [], `🔴 这些条目字段不全：\n${incomplete.join('\n')}`);
});

test('AC-B2 🔴 每条都能追到**她的原话 + 日期**（无据的必须标 `待确认`）', () => {
  const offenders = [];
  for (const row of rows) {
    // 状态必须只用那五个值
    if (!STATUSES.some((status) => row.status.includes(status))) {
      offenders.push(`${row.id}：状态「${row.status}」不在允许值域（${STATUSES.join('/')}）`);
    }
    const waitConfirm = row.status.includes('待确认') || row.quote.includes('待确认') || row.date.includes('待确认');
    if (waitConfirm) continue; // 拿不准的**允许**没有日期，但必须明写"待确认" ✓
    // 原话：必须带「」（逐字引用）
    if (!row.quote.includes('「') || !row.quote.includes('」')) {
      offenders.push(`${row.id}：原话必须用「」逐字引用`);
    }
    // 日期：必须能追到 2026-10-xx（上海）
    if (!/2026-10-\d\d/.test(row.date)) {
      offenders.push(`${row.id}：日期必须能追到 2026-10-xx（实得「${row.date}」）`);
    }
  }
  assert.deepEqual(offenders, [], `🔴 总账里有"无据可查"的条目（不许替她编口径）：\n${offenders.join('\n')}`);
});

test('AC-B3 ⭐ 板务清理结论**逐条可核**（completed 带 PR 号；未收口的写明"不收口"）', () => {
  const appendix = backlog.slice(backlog.indexOf('## F.'));
  assert.notEqual(appendix.length, 0, '必须有 F. 板务清理记录这一节');
  for (const [taskId, prNumber] of [['task-24', '#605'], ['task-30', '#624']]) {
    assert.ok(appendix.includes(taskId), `清理记录里必须有 ${taskId}`);
    assert.ok(appendix.includes(prNumber), `${taskId} 的结论必须指向 PR ${prNumber}`);
  }
  // ⚠️ 判据要**落在 task-46 那一行上** —— 不能扫整节（本节末尾的说明里也有"未收口"⇒ 会假绿 ✗）
  const task46Row = appendix.split('\n').find((line) => line.startsWith('| **task-46**'));
  assert.ok(task46Row, '清理记录里必须有一行交代 task-46');
  assert.match(task46Row, /不收口|未收口/, 'task-46 未收口必须在**它那一行**如实写明（不许悄悄收口）');
  // ⚠️ 反向也要钉：那一行**不许**出现"已收口 / completed"这类结论
  //   （本轮真踩到：只替换了一处"未收口"、另一处"不收口"还在 ⇒ 假绿 ✗）
  assert.doesNotMatch(task46Row, /已收口|⇒ \*\*`completed`\*\*/,
    'task-46 不许标成已收口 / completed（路由还没接 ⇒ 未收口）');
});

test('AC-B4 🔴 `AGENTS.md` 里的防丢规则**在**（删掉它 ⇒ 红）', () => {
  // ① 单一来源指向
  assert.ok(agents.includes('docs/owner-requests-backlog.md'),
    'AGENTS.md 必须指向「她的口径总账」这份单一来源');
  // ② 两条规矩的**逐字**
  assert.ok(agents.includes('当场进总账'),
    'AGENTS.md 必须写明「她的任何口径 ⇒ 当场进总账」');
  assert.ok(agents.includes('先核 `git log` / PR') || agents.includes('先核 `git log`/PR'),
    'AGENTS.md 必须写明「清单不能信时先核 git log / PR，不靠记忆」');
  assert.ok(agents.includes('不许替她编口径'),
    'AGENTS.md 必须写明「拿不准的标待确认，不许替她编口径」');
  // ③ 这一节必须真的在《与业务负责人的协作纪律》里（编号 17）
  assert.match(agents, /### 17\. 🔴 她的口径总账/,
    '必须是一节独立编号的规矩（第 17 条）');
});
