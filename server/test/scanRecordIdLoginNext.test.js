'use strict';

/**
 * ⭐⭐ 2026-10-13 真因回归：**货品标签二维码 `/r/<记录ID>` 未登录时的 `next` 丢了** ✗
 *
 * 她真机 + 服务器实测（逐字）：
 *   · `GET /r/rec28dN0WfM3KH`（未登录）⇒ 302 `Location: /api/auth/feishu/start?next=%2F`   ✗ **丢了路径**
 *   · `GET /s/MK31-1|咖色|B`（未登录）⇒ 302 `...?next=%2Fs%2F…`                          ✓ 保留路径
 *   ⇒ 登录回来落**扫码页首页**（标题「请扫下一个标签」= 她截图那一页 ✓）
 *   ⇒ **"扫了货品标签 ⇒ 却没进到那一款"** 的真因 ✓
 *
 * 修法：登录跳转的白名单**加第二类**——扫码页的**记录 ID 路径**（`SCAN_PAGE.route.recordBasePath` ✓），
 *   与 `/s/` 那条**同一形状**、复用既有 `resolveScanNext`（**不抄第二份** ✗）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_record_next';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'record_next_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_AUTH_REDIRECT } = require('../src/config/scanAuthRedirect');

const SESSION_SECRET = 'scan_record_next_session_secret';
const cookieFor = (openId = 'ou_record_next') => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
};

const RECORD_ID = 'rec28dN0WfM3KH';
const NUMBER = 'MK31-1|咖色|B';

const view = () => ({
  found: true, number: NUMBER, item_no: 'MK31-1', color: '咖色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-13 20:00',
});

const lookups = [];
const buildApp = () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = createScanPageRouter({
    service: { lookup: async (input) => { lookups.push(input); return view(); } },
    gateway: {}, writeService: false, followup: { addPayment: async () => ({ ok: true }) },
  });
  // ⚠️ 与 `app.js` **逐字同形**：同一个 router 实例挂在**两个**挂载点（`/s` 与 `/r` ✓）
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const login_ = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const nextOf = (location) => {
  const url = new URL(location, 'http://127.0.0.1');
  return url.searchParams.get('next');
};

test('AC-RN1 ⭐ `GET /r/<记录ID>`（未登录）⇒ 302，且 `next` **逐字** = encodeURIComponent("/r/<记录ID>")', async () => {
  login_();
  await withServer(buildApp(), async (base) => {
    const response = await fetch(`${base}${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`, { redirect: 'manual' });
    assert.equal(response.status, 302, `未登录要去登录（实际 ${response.status}）`);
    const location = response.headers.get('location') || '';
    assert.ok(location.startsWith(SCAN_AUTH_REDIRECT.login.startPath), `要跳登录入口：${location}`);
    const expect = `${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`;
    assert.equal(nextOf(location), expect,
      `🔴 next 必须逐字带上他本来要去的路径（实际 ${nextOf(location)}，Location=${location}）`);
  });
});

test('AC-RN2 ⭐ `GET /r/<记录ID>?from=sales`（未登录）⇒ `next` **含查询串**（逐字）', async () => {
  login_();
  await withServer(buildApp(), async (base) => {
    const response = await fetch(`${base}${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}?from=sales`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const expect = `${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}?from=sales`;
    assert.equal(nextOf(response.headers.get('location') || ''), expect,
      '查询串一个字都不许丢（否则登录回来会落到别的领域 ✗）');
  });
});

test('AC-RN3 回归：`GET /s/<编号>`（未登录）⇒ `next` 仍为**原样**（别改坏既有那条）', async () => {
  login_();
  await withServer(buildApp(), async (base) => {
    const response = await fetch(`${base}${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}?from=sales`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const expect = `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}?from=sales`;
    assert.equal(nextOf(response.headers.get('location') || ''), expect, '/s/ 那条**逐字不变** ✓');
  });
});

test('AC-RN4 ⭐ 登录后回到 `/r/<记录ID>` ⇒ **真的渲染那一款**（不是首页）', async () => {
  login_();
  lookups.length = 0;
  await withServer(buildApp(), async (base) => {
    const response = await fetch(`${base}${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`, {
      headers: { cookie: cookieFor() },
    });
    const html = await response.text();
    assert.equal(response.status, 200, `登录后要能直接看（实际 ${response.status}）`);
    // ① 服务层真的按**记录 ID**去取那一款（不是回首页 ✗）
    assert.equal(lookups.length, 1, '只查一次');
    assert.ok(JSON.stringify(lookups[0]).includes(RECORD_ID), '查询入参要带**记录 ID**');
    // ② 页面上是那一款的事实（货号），不是「请扫下一个标签」那张首页
    assert.ok(html.includes('MK31-1'), '页面上要出现那一款的货号');
    assert.equal(html.includes('请扫下一个标签'), false, '🔴 落到的**不是**扫码页首页（她截图那一页）');
  });
});
