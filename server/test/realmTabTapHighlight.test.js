const { rendererSource } = require('./support/rendererSource');
/**
 * ⭐⭐ 2026-10-14「触屏按下去一定要有反馈」（业务负责人批准 → Lead 裁定（甲）✓）
 *
 * 起因（她原话）：「有时候点击了按钮，按钮的字会变化，有时候不变」
 *   ⇒ 只读核查（Lead 认可 ✓）：
 *       ① `-webkit-tap-highlight-color` **0 处** ⇒ 飞书 WebView / 触屏上点 `<a>` **没有原生高亮** ✗
 *       ② `touchstart` / `pointerdown` / `touchend` **一处都没有** ⇒ 按下反馈**唯一**靠 CSS `:active` ✗
 *       ③ "字会变化"那套在 `submitFeedbackScriptHtml()`，只挂**提交类按钮** ⇒ **与六格 tab 无关** ✓
 *   ⇒ 六格 tab 的现象 = **只有 `:active`、没有原生高亮、没有 pointerdown 兜底** ⇒ 触屏下可能**完全看不出按下**
 *
 * 修法（**最小、仍是"浏览器原生、零 JS"** ✓）：加 `-webkit-tap-highlight-color`
 *   ⇒ 触屏点下去**一定有原生高亮** ✓ 不依赖 `:active` 的触发时机 ✓ 不写一行 JS ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = rendererSource();

// ══════════════════════════════════════════════════════════════════════════════
test('AC-1 ⭐⭐ 六格 tab（与同组元素）的 CSS 里有 `-webkit-tap-highlight-color`（触屏原生高亮）', () => {
  assert.match(RENDERER, /\.realm-tab \{[^}]*-webkit-tap-highlight-color:/,
    '`.realm-tab` 规则里必须有 -webkit-tap-highlight-color ✓（触屏点下去才一定有反馈）');
  assert.match(RENDERER, /-webkit-tap-highlight-color:\s*[^;}]+;/,
    '必须是一条**带值**的声明（不是写在注释里 ✗）');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-2 ⭐⭐ 该高亮**不依赖 JS**：它是 **CSS 声明**（不是给 `<a>` 挂 onclick）', () => {
  const rule = RENDERER.match(/\.realm-tab \{[^}]*\}/)[0];
  assert.match(rule, /-webkit-tap-highlight-color:/, '在 **CSS 规则内** ✓');
  assert.doesNotMatch(rule, /onclick|addEventListener|javascript:/, 'CSS 里不许掺脚本 ✗');
  // 六格是纯链接：全文件**没有**给 realm-tab 挂点击监听（只读哨兵，防"又改回依赖脚本" ✗）
  assert.doesNotMatch(RENDERER, /realm-tab[^\n]{0,40}addEventListener/, '不许给六格挂监听 ✗');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-3 回归：`:active` **仍保留**（别把 #509 锁住的那条删掉 ✗）· ≥44px 仍在', () => {
  assert.match(RENDERER, /\.realm-tab:active/, '`:active` 必须还在 ✓');
  assert.match(RENDERER, /\.realm-tab \{[^}]*min-height: var\(--control-height\)/, '仍 ≥44px（--control-height）✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-4 回归：同组元素（验收那排批次行）也拿到了原生高亮 ✓', () => {
  assert.match(RENDERER, /\.batch-row \{[^}]*-webkit-tap-highlight-color:/,
    '`.batch-row`（与 `.realm-tab:active` 同一组）也要有 ✓ —— 否则那排同样"点了看不出" ✗');
});
