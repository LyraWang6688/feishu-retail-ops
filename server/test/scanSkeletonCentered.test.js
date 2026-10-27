/**
 * 骨架屏改版（2026-10-14 她逐字）：「骨架页改成**水平垂直居中的卡片**，显示：**数据加载中**」
 * ⚠️ 红线：**同一次取数脚本**（`dataSearch` + 强制 `data=1`）一个字都不能丢 ✓；
 *    文案**走配置**（`config/scanPage.js` 的 `texts.skeletonLoading` ✓ 不写死中文 ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_skel_centered';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'skel_centered_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanSkeleton } = require('../src/views/scanPageRenderer');

const VIEW = { number: 'MK31-1|咖色|B', item_no: 'X7303', color: '绿色', category_name: '休闲鞋' };
const HTML = renderScanSkeleton(VIEW, SCAN_PAGE);
const BODY = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script'));

test('AC-SC1 ⭐ 骨架 = **一张水平垂直居中的卡片**（flex + center + 足够高 ✓）', () => {
  assert.match(BODY, /<section[^>]*id="scan-skeleton"[^>]*class="skeleton-stage"/, '外壳是居中那一层 ✓');
  assert.match(BODY, /<div class="card skeleton-card"[^>]*>/, '就是一张**卡片** ✓');
  assert.match(HTML, /\.skeleton-stage \{ display: flex; align-items: center; justify-content: center;/, '水平 + 垂直都居中 ✓');
  assert.match(HTML, /\.skeleton-stage \{[^}]*min-height: 70vh/, '要有足够高度才谈得上"垂直居中" ✓');
  assert.match(HTML, /\.skeleton-card \{[^}]*text-align: center/, '卡内文字居中 ✓');
  assert.match(HTML, /\.skeleton-card \{[^}]*font-size: var\(--font-size-lg\)/, '字够大（老规矩：清晰可读 ✓）');
});

test('AC-SC2 ⭐ 这一屏**有且只有**「数据加载中」这一句主文案（且走配置 ✓）', () => {
  assert.equal(SCAN_PAGE.texts.skeletonLoading, '数据加载中', '配置里的文案逐字 ✓');
  assert.equal((HTML.match(/数据加载中/g) || []).length, 1, '只许出现一次 ✓');
  assert.equal(HTML.includes('正在读取'), false, '「正在读取」不许再出现 ✗（改指向 ✓）');
  assert.ok(BODY.includes('数据加载中'), '那一句就画在这一屏上 ✓');
  // ⚠️ 按她的新设计：这一屏**只**有那一张卡 + 那一句（旧屏的货号/颜色占位已去掉 ✓）
  assert.equal(/X7303/.test(BODY), false, '新骨架不再显示货号（她的改版 ✓ 数据来了才显示）');
  assert.equal(BODY.includes('undefined'), false, '不许把 undefined 画到页面上 ✓');
});

test('AC-SC3 ⭐⭐ 回归：取数脚本**一个字没丢**，且最终 URL 必含 `data=1`（上一件的修复 ✓）', () => {
  assert.match(HTML, /var dataSearch = window\.location\.search \|\| '';/, '仍读当前 query（from 不许丢 ✓）');
  assert.match(HTML, /dataQuery\.push\('data=1'\)/, '仍强制 data=1（死循环的闸 ✓）');
  assert.match(HTML, /fetch\(window\.location\.pathname \+ '\?' \+ dataQuery\.join\('&'\)/, '取数那一行没动 ✓');
  assert.equal(HTML.includes("'/r/' + encodeURIComponent"), false, '不许写死 /r/ ✓');
  assert.equal((HTML.match(/<script/g) || []).length, 1, '整页仍只有一段脚本 ✓');
});
