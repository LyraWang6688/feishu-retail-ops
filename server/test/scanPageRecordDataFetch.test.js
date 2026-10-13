'use strict';

/**
 * ⭐⭐ 2026-10-13 **真病根**（nginx 日志逐字）：
 *   21:32:03 `GET /r/rec28dZKS5qr58` => **200** ✓（票据那一刀成功 ⇒ 她确实进了那一款）
 *   21:32:04 `GET /s/?data=1`          => 200   ← ⭐ **页面自己把首页数据拉回来覆盖了自己** ✗
 *   ⇒ 她最终看到「请扫下一个标签」（首页）✗
 *
 * 病根：骨架里那段取数脚本**把 `/s/` 写死了**（`fetch('/s/' + number + '?data=1')`）——
 *   在 `/r/<记录ID>` 上 `number` 是空的 ⇒ 请求变成 `/s/?data=1`（不带编号 = 首页）✗
 * 修法：取**当前页面自己的路径**（`window.location.pathname + '?data=1'`）✓
 *   · `/r/<记录ID>` ⇒ `/r/<记录ID>?data=1` ✓（这一款自己的数据 ✓）
 *   · `/s/<编号>`   ⇒ `/s/<编号>?data=1` ✓（原样 ✓）
 *   · 不带编号的首页 `/s/` ⇒ `/s/?data=1` ✓（**那条仍保留** ✓ 回归 ✓）
 *   ⚠️ `?data=1` 走的仍是**同一个** `service.lookup`（**没有第二条取数路径** ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_record_data';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'record_data_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanSkeleton, renderScanPage } = require('../src/views/scanPageRenderer');

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
const RECORD_ID = 'rec28dZKS5qr58';

test('AC-RD1 ⭐ 骨架的取数请求 = **当前页面自己的路径**（不再写死 /s/）', () => {
  const html = renderScanSkeleton({ number: 'MK31-1|咖色|B' }, SCAN_PAGE);
  assert.ok(html.includes("window.location.pathname + '?data=1'"),
    `骨架必须按当前路径取数（实际片段：${html.slice(html.indexOf('fetch('), html.indexOf('fetch(') + 80)}）`);
  assert.equal(html.includes("'/s/' + encodeURIComponent"), false,
    '🔴 不许再写死 /s/（写死 ⇒ /r/ 页面会去拉首页数据 ✗）');
});

test('AC-RD2 ⭐ `/r/<记录ID>` 上取到的是**这一款**的数据（不是 /s/?data=1）', () => {
  // 骨架在 `/r/<记录ID>` 上服务时：`data-number` 为空 ⇒ 旧实现拼出 `/s/?data=1` ✗
  const html = renderScanSkeleton({ number: '' }, SCAN_PAGE);
  assert.equal(html.includes("'/s/' + encodeURIComponent('' ) + '?data=1'"), false, '不许拼出 /s/?data=1 ✗');
  assert.equal(/fetch\('\/s\/\?data=1'/.test(html), false, '🔴 页面上不许出现写死的 `/s/?data=1` ✗');
  assert.ok(html.includes('window.location.pathname'), '必须按当前路径取（`/r/<记录ID>` ⇒ 自己 ✓）');
});

test('AC-RD3 回归：不带编号的首页 `/s/` 那条**仍然照旧**（`/s/?data=1` ✓）', () => {
  // `location.pathname` 在首页就是 `/s/`（或 `/s`）⇒ 拼出来还是 `/s/?data=1` ✓ 语义没变 ✓
  const html = renderScanSkeleton({ number: '' }, SCAN_PAGE);
  assert.ok(html.includes("window.location.pathname + '?data=1'"),
    '首页场景走同一条相对路径 ⇒ `/s/?data=1` 原样 ✓（不是"删掉了那条" ✗）');
});

test('AC-RD4 回归：`/s/<编号>` 页面照旧（骨架 + 整页都能渲染，且取数仍是同一处）', () => {
  const skeleton = renderScanSkeleton({ number: 'MK31-1|咖色|B' }, SCAN_PAGE);
  assert.ok(skeleton.includes('scan-skeleton'), '骨架页结构不变 ✓');
  const page = renderScanPage({
    found: true, number: 'MK31-1|咖色|B', item_no: 'MK31-1', color: '咖色', category_name: '休闲鞋',
    price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
    rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
    missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
  }, SCAN_PAGE, null, 'sales', {});
  assert.ok(page.includes('MK31-1'), '整页照旧渲染那一款 ✓');
});

test('AC-RD5 只此一处取数（源码哨兵）：渲染层里没有第二处写死 `/s/` 的取数点', () => {
  const hardcoded = [...RENDERER_SRC.matchAll(/fetch\('\/s\//g)].length;
  assert.equal(hardcoded, 0, `渲染层里写死 /s/ 的 fetch 必须为 0（实际 ${hardcoded}）`);
  assert.equal((RENDERER_SRC.match(/window\.location\.pathname \+ '\?data=1'/g) || []).length, 1,
    '这条取数写法只许有**一处**（唯一来源 ✓）');
});
