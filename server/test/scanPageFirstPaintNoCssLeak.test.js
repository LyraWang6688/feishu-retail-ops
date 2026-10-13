'use strict';

/**
 * ⭐ 2026-10-13（她真机）：「**先是 CSS，然后就出来了页面**」✗
 *   真因（**疑点 A** ✓ 已核）：骨架首屏的模板把 `${STYLE}` **裸着写在 `<head>` 里**
 *   ⇒ 裸文本被浏览器"寄养"进 `<body>` ⇒ **那段 CSS 被当可见文字画出来** ✗
 *   （不是 B：响应是 `res.send(整页)` 一次发完，不是分块流式 ✓）
 *
 * 修法：把样式**包进 `<style>`**（并带上 `PAYMENT_STEP_STYLE` / `REALM_BAR_STYLE` 两个覆盖块 ✓
 *   —— 首屏也要正确，否则骨架那一刻切换条还是叠的 ✗）
 *
 * AC：**首屏 HTML 里，样式原文不得作为"可见文本"出现** ✓（把 `<style>` 段整段去掉再找 ✓ 能真红）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_no_css_flash';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'no_css_flash_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanSkeleton, renderScanPage } = require('../src/views/scanPageRenderer');

/** 她看得见的部分 = 去掉 `<style>` 段 **与 HTML 注释**（注释不渲染 ✓ 与既有裁定同口径：CSS/注释都不是文案 ✓） */
const visibleText = (html) => String(html)
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');

test('AC-FF1 🔴 骨架首屏：样式原文**不许**作为可见文本出现（"先闪一下 CSS" ✗）', () => {
  const html = renderScanSkeleton({ number: 'MK31-1|咖色|B' }, SCAN_PAGE);
  assert.ok(html.includes('<style>'), '骨架必须有一个真 `<style>` 块 ✓');
  const visible = visibleText(html);
  for (const raw of [':root', '--font-family', 'color-scheme']) {
    assert.equal(visible.includes(raw), false,
      `样式原文「${raw}」出现在了**可见文本**里（她就会先看到一屏 CSS ✗）`);
  }
});

test('AC-FF2 骨架首屏也要带上两个覆盖块（首屏那一刻切换条就不许叠 ✗）', () => {
  const html = renderScanSkeleton({ number: 'MK31-1|咖色|B' }, SCAN_PAGE);
  const style = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1];
  assert.ok(style.includes('white-space: normal'), '切换条覆盖（white-space: normal）要在首屏样式里 ✓');
  assert.ok(/--font-family/.test(style), '基础变量也要在（否则首屏没样式 ✗）');
});

test('AC-FF3 回归：正常整页同样没有样式泄漏，且照旧渲染', () => {
  const html = renderScanPage({
    found: true, number: 'MK31-1|咖色|B', item_no: 'MK31-1', color: '咖色', category_name: '休闲鞋',
    price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
    rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
    missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
  }, SCAN_PAGE, null, 'sales', {});
  assert.ok(html.includes('MK31-1'), '整页照旧 ✓');
  assert.equal(visibleText(html).includes(':root'), false, '整页也不许把样式当文字 ✗');
});
