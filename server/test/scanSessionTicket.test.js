'use strict';

/**
 * ⭐⭐ 2026-10-13 **一次性会话票据** AC（飞书 WebView 不保存 cookie 的唯一正解）。
 *   设计：一次性 · ≤60s · HMAC（复用会话密钥）· 绑定 open_id + path · 目标须过既有 /s+/r 白名单（不放宽）
 *        · 兑换后 302 到**去掉 t** 的同一路径 · 失败一律回落"再走一次登录"（绝不半登录）
 *   ⚠️ 与 `return_to` 并存：那条逐字不变（票只挂白名单内的扫码路径）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_ticket_ac';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'ticket_ac_secret';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'ticket_ac_session_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { TICKET, issueSessionTicket, redeemSessionTicket, pathWithoutTicket } = require('../src/config/scanAuthRedirect');
const { createScanPageRouter } = require('../src/routes/scanPage');

const RECORD_ID = 'recTicketAc0001';
const NUMBER = 'MK31-1|咖色|B';
const view = () => ({
  found: true, number: NUMBER, item_no: 'MK31-1', color: '咖色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
});
const withServer = async (run) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, writeService: false,
    followup: { addPayment: async () => ({ ok: true }) },
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);   // 与 app.js 同形 ✓
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const get = (base, path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers });
const LOGIN = /\/api\/auth\/feishu\/start/;
const recordPath = () => `${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`;
const ticketFor = (path, ...rest) => issueSessionTicket({ openId: 'ou_ticket_ac', name: '测试', path }, ...rest);

test('AC-TK1 ⭐ 带票 ⇒ 302 到**去 t 的同一路径** + 当场种会话 cookie（HttpOnly/Secure/Path=/ 都在）', async () => {
  await withServer(async (base) => {
    const path = recordPath();
    const r = await get(base, `${path}?t=${encodeURIComponent(ticketFor(path))}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), path, `必须 302 到去 t 的同一路径（实际 ${r.headers.get('location')}）`);
    const cookie = String(r.headers.get('set-cookie') || '');
    for (const must of [/workbench_session=/, /HttpOnly/, /Secure/, /Path=\//]) assert.match(cookie, must, `cookie 缺 ${must}`);
  });
});

test('AC-TK2 ⭐ 票只能用一次（第二次 ⇒ 回落登录，不是 200）', async () => {
  await withServer(async (base) => {
    const t = ticketFor(recordPath());
    assert.equal((await get(base, `${recordPath()}?t=${encodeURIComponent(t)}`)).status, 302);
    const second = await get(base, `${recordPath()}?t=${encodeURIComponent(t)}`);
    assert.equal(second.status, 302);
    assert.match(String(second.headers.get('location')), LOGIN, '用过的票 ⇒ 回落登录 ✓');
  });
});

test('AC-TK3 ⭐ 过期（>60s）⇒ 回落登录', async () => {
  await withServer(async (base) => {
    const expired = issueSessionTicket({ openId: 'ou', name: '', path: recordPath() }, { now: Date.now() - TICKET.ttlMs - 1000 });
    const r = await get(base, `${recordPath()}?t=${encodeURIComponent(expired)}`);
    assert.equal(r.status, 302);
    assert.match(String(r.headers.get('location')), LOGIN);
  });
});

test('AC-TK4 ⭐ 篡改/伪造/乱码票 ⇒ 一律拒绝（回落登录）', async () => {
  await withServer(async (base) => {
    const good = ticketFor(recordPath());
    const forged = `${Buffer.from(JSON.stringify({ o: 'ou_x', n: '', p: recordPath(), e: Date.now() + 6e4, k: 'k1' })).toString('base64url')}.wrong`;
    for (const bad of [`${good.slice(0, -3)}AAA`, forged, 'garbage', 'a.b.c']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(base, `${recordPath()}?t=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 302, `非法票必须拒（实际 ${r.status}）`);
      assert.match(String(r.headers.get('location')), LOGIN);
    }
  });
});

test('AC-TK5 ⭐ 绑定 path：换 path 用同一票 ⇒ 拒绝', async () => {
  await withServer(async (base) => {
    const t = ticketFor(recordPath());
    const other = `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`;
    const r = await get(base, `${other}?t=${encodeURIComponent(t)}`);
    assert.equal(r.status, 302, '换 path ⇒ 必须拒（不是 200 ✗）');
    assert.match(String(r.headers.get('location')), LOGIN);
  });
});

test('AC-TK6 ⭐ 端到端：无 cookie、只带票 ⇒ 兑换 ⇒ **两连请求都 200 且是那一款**', async () => {
  await withServer(async (base) => {
    const path = recordPath();
    const exchanged = await get(base, `${path}?t=${encodeURIComponent(ticketFor(path))}`);
    assert.equal(exchanged.status, 302);
    const cookie = String(exchanged.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.startsWith('workbench_session='));
    for (const round of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const page = await get(base, path, { cookie });
      // eslint-disable-next-line no-await-in-loop
      const html = await page.text();
      assert.equal(page.status, 200, `第 ${round} 次带同一 cookie 应 200（不再被弹 ✗）`);
      assert.ok(html.includes('MK31-1'), `第 ${round} 次要拿到那一款（不是首页 ✗）`);
      assert.equal(html.includes('请扫下一个标签'), false, '🔴 不许落到扫码页首页 ✗');
    }
  });
});

test('AC-TK7 回归：`/s/<编号>` 的 next 逐字不变 · 工作台目标不挂票', async () => {
  await withServer(async (base) => {
    const r = await get(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}?from=sales`);
    assert.equal(r.status, 302);
    const next = new URL(String(r.headers.get('location')), base).searchParams.get('next');
    assert.equal(next, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}?from=sales`);
  });
  const { resolveScanNext } = require('../src/routes/feishuWebAuth');
  assert.notEqual(resolveScanNext('/workbench/index.html?tab=sales'), '/workbench/index.html?tab=sales',
    '工作台目标不在扫码白名单 ⇒ 不会被挂票（return_to 语义逐字不变 ✓）');
});

test('AC-TK8 纯函数：`pathWithoutTicket` 只去 t；正常票能兑换', () => {
  assert.equal(pathWithoutTicket('/r/recX?t=abc&from=sales'), '/r/recX?from=sales');
  assert.equal(pathWithoutTicket('/r/recX?from=sales&t=abc'), '/r/recX?from=sales');
  assert.equal(pathWithoutTicket('/r/recX?t=abc'), '/r/recX');
  assert.equal(pathWithoutTicket('/r/recX'), '/r/recX');
  assert.equal(redeemSessionTicket(issueSessionTicket({ openId: 'o', name: 'n', path: '/r/recX' }), { targetPath: '/r/recX' }).ok, true);
});
