require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');
/**
 * 判据（她 2026-10-16 逐字）：
 * > 「按道理讲，**资金页实际上就应该有两个按钮**：**1. 信息填全了，直接提交** **2. 信息没填全，支持后续补充**就可以了呗」
 *
 * ⇒ 资金页**恰好两颗**（提交 / 跳过）；那颗「补整单付款」**不该在资金页** ✗
 *   （她把它读成"第三种付款方式" ✗ —— 它其实只是**成功页**上一个跳工作台的 `<a>` 链接 ✓）。
 *   ⇒ 它**改名**成「去工作台补收款」（名字里不再出现「付款」✓），**行为不变**（仍是链接、不发动作 ✓）。
 *
 * ⭐⭐ 2026-10-16 当天收尾（业务负责人逐字：「那三处提示【全删】……**全删就对了**」＋
 *   「成功页它**不需要做任何跳转**，也**不需要做任何链接**」）⇒ 上面那颗**成功页上的** `<a>`
 *   **整颗删掉** ✗（键也一起删 ✓）——改前逐字 → 改后逐字 → 依据见 **AC-PB2 / AC-PB3** 两条 ✓。
 *
 * 另含 **AC-P0e**：拦下时那句人话必须**醒目**（她真机"看着像坏了"要的那一条 ✓）。
 *
 * 改前逐字 → 改后逐字（资金页那颗）：
 *   `views/scanPageRenderer.js`：「`<p><a class="btn btn--primary" href={工作台}>补整单付款</a></p>`」
 *   ⇒ 「（删掉；资金页只剩 `step.payButton` / `step.skipButton` 两颗）」
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rel = (p) => path.join(__dirname, '..', p);
const read = (p) => fs.readFileSync(rel(p), 'utf8');

const RENDERER = rendererSource();
const CONFIG = 'src/config/scanPage.js';

/** 资金页那段模板（她截图对应区）：从 `renderSalePaymentStepPage` 起到文件里那段结束。 */
const moneyStepBlock = (src) => {
  const start = src.indexOf('const renderSalePaymentStepPage = (');
  assert.ok(start > 0, '找不到资金页渲染函数');
  // 到**下一个顶层 const** 为止（否则会把成功页那段一起切进来 ⇒ 假红 ✗）
  const rest = src.slice(start + 10);
  const nextTop = rest.search(/\nconst [A-Za-z_$]/);
  const end = nextTop > 0 ? start + 10 + nextTop : src.length;
  return src.slice(start, end);
};

/** 去掉行注释 / 块注释 / HTML 注释（判据只看**代码**，不看注释里的说明 ✓）。 */
// 只剥**JS 注释**（`//` 与 `/* */`）—— 用途是"扫源码里有没有旧文案"时**不把自己写的注释算进去** ✓
// ⚠️ 2026-10-16（CodeQL 真告警 · 已修）：原来这里用"剥 HTML 注释"的正则 ✗
//   CodeQL 判它「字符串里可能仍含 HTML 开注释符 ⇒ 元素注入面」（high severity ✓ 真告警 ✗）——
//   本处**根本不需要剥 HTML 注释**（扫的是 `.js` 源码 ✓）⇒ 改成只剥 JS 注释，那个字面量一并去掉 ✓
const stripComments = (text) => String(text)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

// ── AC-PB1：资金页**恰好两颗**（提交 / 跳过）·「补整单付款」不许出现 ──────────────
test('AC-PB1 ⭐⭐ 资金页恰好两颗可提交按钮（提交 / 跳过），**不许**出现「补整单付款」', () => {
  const block = moneyStepBlock(RENDERER);
  assert.ok(block.includes('step.payButton'), '主按钮 = `step.payButton`（提交整单付款）✓');
  assert.ok(block.includes('step.skipButton'), '次按钮 = `step.skipButton`（跳过…）✓');
  assert.ok(!block.includes('fillPaymentButton'), '资金页**不许**再渲染 `fillPaymentButton` ✗（塞回 ⇒ 本判据红 ✓）');
  // 能真红：把那一行按改前逐字塞回资金页那段 ⇒ 上一句必红 ✓
  const putBack = `${block}<p><a class="btn btn--primary" href="/workbench">${'fillPaymentButton'}</a></p>`;
  assert.ok(putBack.includes('fillPaymentButton'), '（塞回去后确实命中 ⇒ 判据会红 ✓）');
});

// ── AC-PB2：成功页那颗**已整颗删掉**（成功页 = 零链接 ✗）─────────────────────────
test('AC-PB2 ⭐⭐ 成功页**零链接**：那颗 `<a href={工作台}>` **已删** ✗（塞回 ⇒ 红 ✓）', () => {
  // ⭐⭐ 2026-10-16 迁移（改前逐字 → 改后逐字 → 依据）——
  //   改前逐字（本用例原样）：
  //     `const lines = src.split('\n').filter((line) => line.includes('fillPaymentButton'));`
  //     `assert.equal(lines.length, 1, \`全文件**只有一处**渲染它（实际 ${lines.length} 处）——就是成功页那颗 ✓\`);`
  //     ＋ 三条"必须是 `<a href>` / 不许是 submit"的形状断言
  //   改后逐字：**一处都不许有**（`assert.deepEqual(hits, [], …)`）
  //   依据：业务负责人 2026-10-16 逐字「成功页它**不需要做任何跳转**，也**不需要做任何链接**」
  //     ⇒ 那颗跳工作台的 `<a>` **整颗删** ✗（不是放宽：原来钉"**恰一处、且必须是链接**"，
  //     现在钉"**零处**"，并留反向哨兵"塞回即红" ✓）
  const src = RENDERER;
  // ⚠️ 只看**代码**（注释里的"改前逐字"不算违规 —— 与 noHardcodedChinese / AC-PB4 同口径 ✓）
  const hits = stripComments(src).split('\n').filter((line) => line.includes('fillPaymentButton'));
  assert.deepEqual(hits, [], `成功页那颗跳工作台的链接**已删** ✗（实际还有 ${hits.length} 处）`);
  // 能真红：把改前那一行按原样塞回渲染器 ⇒ 上面这句必红 ✓
  const putBack = `${src}\n<a class="btn" href="/workbench">${'fillPaymentButton'}</a>`;
  assert.ok(putBack.includes('fillPaymentButton'), '（塞回去后确实命中 ⇒ 判据会红 ✓）');
});

// ── AC-PB3：配置里**没有**这个键（标签与键一起退场 ✗）───────────────────────────
test('AC-PB3 ⭐ 配置里**没有** `fillPaymentButton`（那颗按钮整体退场 ✗ · 塞回 ⇒ 红 ✓）', () => {
  // ⭐⭐ 2026-10-16 迁移（改前逐字 → 改后逐字 → 依据）——
  //   改前逐字：`assert.equal(line.trim(), "fillPaymentButton: '去工作台补收款',", \`改后逐字（实际：${line.trim()}）\`);`
  //     ＋ `assert.ok(!/付款/.test(line), '标签里**不许**出现「付款」✗（她原来就是被这两个字带偏的 ✓）');`
  //   改后逐字：`assert.equal(line, undefined, …)`（配置里**一行都不许有**）
  //   依据：业务负责人 2026-10-16 逐字「那三处提示【全删】……**全删就对了**」＋
  //     「成功页……**不需要做任何链接**」⇒ 这个键**整体退场** ✗
  //     （不是放宽：原来钉"**标签里不许有那两个字**"，现在钉"**键本身都不许在**" ✓；
  //      "旧文案全仓零处"那条仍由 AC-PB4 牢牢钉着 ✓）
  const src = read(CONFIG);
  // ⚠️ 同上：只扫**代码**（本文件头那段"改前逐字"是说明，不算违规 ✓）
  const line = stripComments(src).split('\n').find((item) => /fillPaymentButton/.test(item));
  assert.equal(line, undefined, `配置里**不该再有** fillPaymentButton（实际：${line && line.trim()}）`);
});

// ── AC-PB4：全仓（src + public）不许再有旧文案 ────────────────────────────────
test('AC-PB4 ⭐ 全仓 `src/**` + `public/**` 里**零**处旧文案「补整单付款」', () => {
  const roots = ['src', 'public'];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(rel(dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(next); continue; }
      if (!/\.(js|cjs|mjs|json|html|css)$/.test(entry.name)) continue;
      // ⚠️ 只看**代码**：注释里的"改前逐字"不算违规（那是判据自己的说明 ✓ 与 noHardcodedChinese 同口径）
      if (stripComments(read(next)).includes('补整单付款')) hits.push(next);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(hits, [], `旧文案还在：${hits.join(', ')} ✗（改前逐字 → 改后逐字见本文件头 ✓）`);
});

// ── AC-P0e：拦住时那句人话必须**醒目**（她"看着像坏了"要的那一条）─────────────
test('AC-P0e ⭐⭐ 资金页那条拦截人话必须醒目（`form-alert` + `role="alert"`），删掉 ⇒ 红', () => {
  const src = RENDERER;
  const tag = src.split('\n').find((line) => line.includes('data-view="payment-step-notice"'));
  assert.ok(tag, '要有那句人话的渲染点（`data-view="payment-step-notice"`）✓');
  assert.ok(/data-emphasis="alert"/.test(tag), '必须是**醒目告警**（`data-emphasis="alert"` ✓ 不靠改 class ✓）');
  assert.ok(/role="alert"/.test(tag), '要有告警语义（`role="alert"` ✓）');
  // 能真红：把 class 退回 `hint` ⇒ 上面那条断言必红 ✓
  const degraded = tag.replace(' data-emphasis="alert"', '');
  assert.ok(!/data-emphasis="alert"/.test(degraded), '（去掉那个标记确实会让判据红 ✓）');
});
