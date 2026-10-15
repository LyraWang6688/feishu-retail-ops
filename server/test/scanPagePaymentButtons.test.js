/**
 * 判据（她 2026-10-16 逐字）：
 * > 「按道理讲，**资金页实际上就应该有两个按钮**：**1. 信息填全了，直接提交** **2. 信息没填全，支持后续补充**就可以了呗」
 *
 * ⇒ 资金页**恰好两颗**（提交 / 跳过）；那颗「补整单付款」**不该在资金页** ✗
 *   （她把它读成"第三种付款方式" ✗ —— 它其实只是**成功页**上一个跳工作台的 `<a>` 链接 ✓）。
 *   ⇒ 它**改名**成「去工作台补收款」（名字里不再出现「付款」✓），**行为不变**（仍是链接、不发动作 ✓）。
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

const RENDERER = 'src/views/scanPageRenderer.js';
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
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

// ── AC-PB1：资金页**恰好两颗**（提交 / 跳过）·「补整单付款」不许出现 ──────────────
test('AC-PB1 ⭐⭐ 资金页恰好两颗可提交按钮（提交 / 跳过），**不许**出现「补整单付款」', () => {
  const block = moneyStepBlock(read(RENDERER));
  assert.ok(block.includes('step.payButton'), '主按钮 = `step.payButton`（提交整单付款）✓');
  assert.ok(block.includes('step.skipButton'), '次按钮 = `step.skipButton`（跳过…）✓');
  assert.ok(!block.includes('fillPaymentButton'), '资金页**不许**再渲染 `fillPaymentButton` ✗（塞回 ⇒ 本判据红 ✓）');
  // 能真红：把那一行按改前逐字塞回资金页那段 ⇒ 上一句必红 ✓
  const putBack = `${block}<p><a class="btn btn--primary" href="/workbench">${'fillPaymentButton'}</a></p>`;
  assert.ok(putBack.includes('fillPaymentButton'), '（塞回去后确实命中 ⇒ 判据会红 ✓）');
});

// ── AC-PB2：成功页那颗**仍是链接、不发动作**（改名不许顺手改行为 ✗）─────────────
test('AC-PB2 ⭐ 成功页那颗仍是 `<a href={工作台}>` 链接（不发动作）· 且是**同一个配置键**', () => {
  const src = read(RENDERER);
  const lines = src.split('\n').filter((line) => line.includes('fillPaymentButton'));
  assert.equal(lines.length, 1, `全文件**只有一处**渲染它（实际 ${lines.length} 处）——就是成功页那颗 ✓`);
  const line = lines[0];
  assert.ok(line.includes('<a '), '必须是 `<a>` 链接（不是 `<button>` ✗）');
  assert.ok(line.includes('href='), '必须是跳转链接（href）✓');
  assert.ok(!/type="submit"/.test(line), '**不许**变成提交按钮 ✗（改名不许顺手改行为 ✓）');
  assert.ok(line.includes('config.saleSuccess?.fillPaymentButton') || line.includes('success.fillPaymentButton'),
    '渲染的是配置键 `fillPaymentButton`（配置驱动 ✓）');
});

// ── AC-PB3：标签里不许再出现「付款」 ──────────────────────────────────────────
test('AC-PB3 ⭐ 标签里**不许**再出现「付款」（改回去 ⇒ 红 ✓）', () => {
  const src = read(CONFIG);
  const line = src.split('\n').find((item) => /fillPaymentButton:\s*'/.test(item));
  assert.ok(line, '配置里要有 `fillPaymentButton`');
  assert.equal(line.trim(), "fillPaymentButton: '去工作台补收款',", `改后逐字（实际：${line.trim()}）`);
  assert.ok(!/付款/.test(line), '标签里**不许**出现「付款」✗（她原来就是被这两个字带偏的 ✓）');
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
  const src = read(RENDERER);
  const tag = src.split('\n').find((line) => line.includes('data-view="payment-step-notice"'));
  assert.ok(tag, '要有那句人话的渲染点（`data-view="payment-step-notice"`）✓');
  assert.ok(/data-emphasis="alert"/.test(tag), '必须是**醒目告警**（`data-emphasis="alert"` ✓ 不靠改 class ✓）');
  assert.ok(/role="alert"/.test(tag), '要有告警语义（`role="alert"` ✓）');
  // 能真红：把 class 退回 `hint` ⇒ 上面那条断言必红 ✓
  const degraded = tag.replace(' data-emphasis="alert"', '');
  assert.ok(!/data-emphasis="alert"/.test(degraded), '（去掉那个标记确实会让判据红 ✓）');
});
