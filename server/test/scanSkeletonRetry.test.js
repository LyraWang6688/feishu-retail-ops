/**
 * ⭐⭐ 2026-10-14 她真机：「页面已经打开、但内容迟迟不出来」（停留在「数据加载中」太久 ✗）
 *   代码根因之一：骨架那段脚本 **把错误吞掉了** ✗
 *     `fetch(...).then(...).then(function (html) { … }).catch(function () {});`
 *   ⇒ 取数失败 / 非 200 / 空响应 / **拿回的还是骨架** ⇒ 永远停在骨架、连一句人话都没有 ✗
 *   ⇒ 修：任何失败都给「**一句人话 + 重试按钮**」✓（点了再取一次 ✓ 不自动死磕 ✓）
 * AC：失败 ⇒ 人话 + 重试 ✓ · 拿回骨架 ⇒ **不写回** ✓（不循环 ✓）· 点重试 ⇒ 再发一次 ✓ · 成功 ⇒ 照旧 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_skel_retry';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'skel_retry_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanSkeleton } = require('../src/views/scanPageRenderer');

const VIEW = { number: 'MK31-1|咖色|B', item_no: 'X7303', color: '绿色' };
const HTML = renderScanSkeleton(VIEW, SCAN_PAGE);
const scriptOf = (html) => {
  const start = html.indexOf('<script');
  return html.slice(start, html.indexOf('</script>', start));
};
const SCRIPT = scriptOf(HTML);

test('AC-SR1 ⭐⭐ 不再静默吞错：失败 ⇒ 页面上有**人话 + 重试入口**（文案走配置 ✓）', () => {
  // ⚠️ 反向哨兵：改前那种写法必须被判红（见 AC-SR5 ✓）
  assert.equal(/catch\(function \(\) \{\}\)/.test(HTML), false, '空 catch（静默吞错）不许再有 ✗');
  // ⚠️ 脚本里 setAttribute 用的是**单引号** ⇒ 断言按**源码逐字**（我第一版引号假设错了 ✗）
  assert.ok(SCRIPT.includes("'scan-skeleton-error'"), '要有"人话"容器 ✓');
  assert.ok(SCRIPT.includes("'scan-skeleton-retry'"), '要有「重试」按钮 ✓');
  assert.ok(HTML.includes(SCAN_PAGE.texts.skeletonErrorText), '人话文案**来自配置** ✓（不写死 ✗）');
  assert.ok(HTML.includes(SCAN_PAGE.texts.skeletonRetryLabel), '按钮文案**来自配置** ✓');
  assert.match(HTML, /\.skeleton-retry \{[^}]*min-height: var\(--control-height\)/, '重试按钮 ≥44px（她的老规矩 ✓）');
});

test('AC-SR2 ⭐⭐ 拿回**还是骨架** ⇒ 不 document.write（保住"不循环" ✓ 且给人话 ✓）', () => {
  // ⚠️ 必须**剥注释**再判顺序 —— 脚本里 2026-10-13 的注释里也含 `document.write` 字样 ✗
  //   （我第一版就被它绊了 ⇒ 判出"write 在前"✗ 实际是注释在前 ✓）
  const code = SCRIPT.replace(/^\s*\/\/.*$/gm, '');
  const guardAt = code.indexOf("html.indexOf('data-view=\"scan-skeleton\"') !== -1");
  const writeAt = code.indexOf('document.write');
  assert.ok(guardAt > 0, '要有"拿回骨架"的判据 ✓（按源码逐字 ✓）');
  assert.ok(writeAt > guardAt, '判据必须在 document.write **之前**（否则又会写回骨架 ✗）');
  assert.match(SCRIPT, /catch\(function \(\) \{ showProblem\(\); \}\)/, '请求异常也要走人话（不再吞 ✗）');
  assert.match(SCRIPT, /if \(!html\) \{ showProblem\(\); return; \}/, '空响应 ⇒ 人话 ✓');
});

test('AC-SR3 ⭐ 点「重试」⇒ **再发一次取数请求**（不自动死磕 ✓）', () => {
  assert.match(SCRIPT, /addEventListener\('click', function \(\) \{[\s\S]{0,200}load\(\);/,
    '重试按钮必须再调一次 load() ✓');
  assert.equal((SCRIPT.match(/load\(\);/g) || []).length, 2, '只许"首次一次 + 重试一次"两处调用（不许循环 ✗）');
});

test('AC-SR4 ⭐ 回归：成功路径照旧（document.write ✓ URL 含 data=1 ✓ 整页只有一段脚本 ✓）', () => {
  assert.ok(SCRIPT.includes('document.write(html)'), '成功时仍整页替换 ✓');
  assert.ok(SCRIPT.includes("dataQuery.push('data=1')"), '取数 URL 仍强制 data=1 ✓');
  assert.equal((HTML.match(/<script/g) || []).length, 1, '整页仍只有一段脚本 ✓');
  assert.ok(HTML.includes('数据加载中'), '骨架主文案仍是「数据加载中」✓');
});
