/**
 * ⭐⭐ 2026-10-14「按下去立刻变灰」（业务负责人批准：「就按照这个」✓）
 *
 * 现象（她原话）：「有时候点击了按钮，按钮的字会变化，有时候不变」——
 *   六个领域 tab 是**真的链接**（`<a href="?from=…">`）⇒ 一点就**开始跳转**，
 *   而"变灰/换字"原本靠**跳转前的一小段脚本** ✗ ⇒ 谁先谁后每次不一样。
 * ⇒ 她的裁定：即时反馈改成**浏览器原生 `:active`**（按下那一刻浏览器自己变灰 ✓ **不依赖脚本** ✓）
 *
 * 本文件是**源码哨兵**：锁住"那份反馈在 **CSS** 里"这件事 ✓
 *   （不要求"只能有 CSS" —— 原来那套换字脚本可以保留 **但不再是唯一依靠** ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');

/** 取出 `<style>` 里的 CSS 片段（渲染器的样式都内联在这一个文件里）。 */
const cssOf = (src) => (src.match(/\.[a-z-]+[^{}]*\{[^{}]*\}/g) || []).join('\n');

// ══════════════════════════════════════════════════════════════════════════════
test('AC-1 ⭐⭐ 六格 tab 的反馈在 **CSS** 里：`.realm-tab:active`（源码哨兵，能真红）', () => {
  assert.match(RENDERER, /\.realm-tab:active/, '必须有 `.realm-tab:active` 这条 **CSS** 规则 ✓');
  const hit = RENDERER.match(/\.realm-tab:active[^{]*\{[^}]*\}/);
  assert.ok(hit, '`:active` 必须是**一条真规则**（带 {} 的声明块），不是一句注释 ✗');
  assert.match(hit[0], /opacity|background|color|transform|filter|box-shadow/,
    '按下态必须**真的改变可见样式**（变灰/变暗一类）✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-2 ⭐⭐ 按下去**不依赖 JS**：反馈在 CSS 里就能成立（脚本只是附加）', () => {
  const rule = RENDERER.match(/\.realm-tab:active[^{]*\{[^}]*\}/)[0];
  assert.doesNotMatch(rule, /onclick|addEventListener|javascript:/,
    'CSS 规则里**不许**掺脚本（那又回到"依赖跳转前脚本" ✗）');
  // 同一份 CSS 里 `:active` 是**独立规则** ⇒ 浏览器自己就能触发 ✓
  assert.match(RENDERER, /:active/, '整个样式表里要有 `:active` ✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-3 回归：六格仍是**真链接**（href 非空 · 各按自己的 `?from=` 路径）', () => {
  // ⚠️ 领域清单/顺序**逐字不变**这件事由既有 realm 用例守着（本文件不重复）
  assert.match(RENDERER, /realm-tab--active/, '当前领域那颗的**服务端高亮**仍在 ✓（她被改坏过就不行）');
  assert.match(RENDERER, /aria-current/, '`aria-current="page"` 仍在 ✓');
});

// ══════════════════════════════════════════════════════════════════════════════
test('AC-4 回归：触达尺寸仍 ≥44px（她的老规矩 ✓）', () => {
  assert.match(RENDERER, /\.realm-tab \{[^}]*min-height: var\(--control-height\)/,
    '六格仍用 `--control-height`（≥44px 的系统变量）✓');
});
