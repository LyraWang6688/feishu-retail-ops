'use strict';

/**
 * ⭐⭐ 2026-10-15（task-44 · **由 task-41 的更正而来**）：把退货块的**三句人话锚**钉死，
 *   免得将来又有人（包括我自己 ✗）"看漏一个锚"就误报"空块"。
 *
 * 实测（真路由 + 真渲染器，HTTP 200）：
 *   · 有货 / 缺码混着 ⇒ 每行 `data-view="return-stock"`（那一行的库存数）+ 表单按钮 ✓
 *   · **一行尺码都没有 / 尺码整块读不到** ⇒ 块级 `data-view="return-sizes-unknown"`（**不是空块** ✗）
 *   · **整款 0 库存** ⇒ 块级 `data-view="return-no-stock"` ✓
 *   · 上面**三句互斥**（同一块里只会出现其中一句）✓
 *
 * 判据（能真红）：
 *   AC-RB1 `rows: []` ⇒ **块里必须有人话**（`return-sizes-unknown`）；去掉那条分支 ⇒ 红 ✗
 *   AC-RB2 三种情况**分得开**（三个锚各自出现、且互斥）✓
 *   AC-RB3 文案**来自配置**（本文件断言页面上那两句 === 配置里的那两句 ✓ 不写死 ✗）
 *   AC-RB4 既有判据 0 行放宽（另三个退货用例原样全绿 —— 见 PR 证据 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_rb_anchors';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'rb_anchors_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'rb_anchors_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');

const NUMBER = 'HL92006|黑|A';
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_rb', name: 'rb', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

const view = (over = {}) => ({
  found: true, number: NUMBER, item_no: 'HL92006', color: '黑', category_name: '休闲鞋',
  price_text: '¥399', total: 4, columns: [{ key: '门盒', label: '门盒' }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-15 23:30',
  rows: [], ...over,
});

const blockOf = async (v) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => v }, gateway: {},
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'rb', saveSaleProgress: async () => ({ ok: true }) },
      listAccessories: async () => [],
    },
    startSnapshot: false,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 1;
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/s/${encodeURIComponent(NUMBER)}?from=purchase_return`,
      { headers: { cookie: COOKIE } },
    );
    assert.equal(response.status, 200, '退货那一页要能打开 ✓');
    const html = await response.text();
    const at = html.indexOf('realm-block--purchase_return');
    assert.notEqual(at, -1, '退货块要在页面上 ✓');
    return html.slice(at, html.indexOf('</section>', at) + 10);
  } finally { await new Promise((resolve) => { server.close(resolve); }); }
};

const anchorsOf = (block) => [...block.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);

test('AC-RB1 🔴 **一行尺码都没有**（`rows: []`）⇒ **不是空块**，必须有人话（`return-sizes-unknown`）', async () => {
  const block = await blockOf(view({ rows: [], total: 0 }));
  assert.equal((block.match(/class="size-row"/g) || []).length, 0, '没有尺码行 ✓');
  assert.ok(block.includes('data-view="return-sizes-unknown"'),
    '🔴 这一格**必须有一句人话**（去掉那条分支 ⇒ 红 ✗）—— 本锚是我 task-41 看漏的那个 ✗');
  assert.equal(block.includes('data-view="return-no-stock"'), false, '它与"整款 0 库存"**不是**同一句 ✓');
});
test('AC-RB1b 🔴 尺码整块读不到（`sizes_degraded`）⇒ 同一句人话（也不是空块 ✓）', async () => {
  const block = await blockOf(view({ rows: [], sizes_degraded: true, total: null }));
  assert.ok(block.includes('data-view="return-sizes-unknown"'), '读不到也要如实说 ✓');
});

test('AC-RB2 ⭐ 三种情况**分得开**：三句人话各就各位、且**互斥**', async () => {
  const stocked = await blockOf(view({
    rows: [{ size_text: '40', cells: [{ count: 3 }], total: 3, missing: false },
      { size_text: '41', cells: [{ count: 0 }], total: 0, missing: true }],
    total: 3,
  }));
  const allZero = await blockOf(view({
    rows: [{ size_text: '40', cells: [{ count: 0 }], total: 0, missing: true },
      { size_text: '41', cells: [{ count: 0 }], total: 0, missing: true }],
    total: 0, missing_count: 2,
  }));
  const none = await blockOf(view({ rows: [], total: 0 }));

  assert.equal((stocked.match(/class="size-row"/g) || []).length, 1, '有货/缺码 ⇒ 只列有数量的码 ✓');
  assert.ok(stocked.includes('data-view="return-stock"'), '① 每行那个库存数列 ✓');
  assert.ok(allZero.includes('data-view="return-no-stock"'), '② 整款 0 ⇒ 那一句 ✓');
  assert.ok(none.includes('data-view="return-sizes-unknown"'), '③ 一行都没有 ⇒ 那一句 ✓');
  // 三句**互斥**：任何一块里都只允许出现其中一句
  for (const [name, block, expected] of [['有货', stocked, 'return-stock'],
    ['整款 0', allZero, 'return-no-stock'], ['一行都没有', none, 'return-sizes-unknown']]) {
    const blockLevel = ['return-no-stock', 'return-sizes-unknown'].filter((a) => block.includes(`data-view="${a}"`));
    if (expected === 'return-stock') assert.deepEqual(blockLevel, [], `${name}：不该有那两句人话 ✓`);
    else assert.deepEqual(blockLevel, [expected], `${name}：只许出现它自己那一句 ✓`);
  }
});

test('AC-RB3 ⭐ 文案**全部来自配置**（页面上那两句 === 配置里的那两句，源码里不写死 ✗）', async () => {
  const rf = SCAN_PAGE.returnForm;
  const none = await blockOf(view({ rows: [] }));
  const allZero = await blockOf(view({
    rows: [{ size_text: '40', cells: [{ count: 0 }], total: 0, missing: true }], total: 0, missing_count: 1,
  }));
  assert.ok(none.includes(rf.sizesUnknown), '③ 那句逐字来自 `config/scanPage` ✓');
  assert.ok(allZero.includes(rf.noReturnableStock), '② 那句逐字来自 `config/scanPage` ✓');
  assert.notEqual(rf.sizesUnknown, rf.noReturnableStock, '两句必须**分得开**（不是同一句抄两遍 ✓）');
});
