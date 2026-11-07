'use strict';

/**
 * ⭐⭐ task-11：**工作台「销售 → 订单列表 → 草稿单」路由**的判据（HTTP 层）。
 *
 * 与 `test/scanDraftBoxService.test.js` 分工：那边钉**读模型/清空语义**；本文件钉**接口形状与闸门**：
 *   AC-DR1 `GET /sales/drafts` 200：返回 drafts / total / corrupt_count（**不含 open_id / 会话键 / token**）
 *   AC-DR2 `POST /sales/drafts/clear` 200：只清本地；别人的 404；写中的 400（**不假成功**）
 *   AC-DR3 `GET /sales/drafts/:id/resume` **302 + Set-Cookie**：per-page 会话下发 `scan_page_id=<token>`；
 *          旧会话**清 cookie**（Max-Age=0）；落点 `/r/<首行记录ID>?from=sales`（token **不进 URL**）
 *   AC-DR4 鉴权**继承**：本 router 由 `routes/workbench/sales.js` 在 `requireWorkbenchAccess` 之后挂载
 *          （源码哨兵：**不新开鉴权** ✗），并复用**同一份**扫码会话（`createScanSessionService`）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createScanSessionService } = require('../src/services/scanSessionService');
const { createWorkbenchSalesDraftsRouter } = require('../src/routes/workbenchSalesDrafts');

const OWNER = 'ou_draft_route_owner';
const OTHER = 'ou_draft_route_other';
const SERVER = path.join(__dirname, '..');
const lineOf = (size, amount) => ({
  kind: 'shoe', number: 'K1|黑色|A', item_no: 'K1', color: '黑色',
  product_record_id: 'rec_route_1', size, trade_type_code: 'SALE_PREPAID', amount: String(amount), gift: '',
});

const withServer = async (sessions, run) => {
  const app = express();
  app.use(express.json());
  // 只替身"登录用户"这一层（真正的闸门在本文件 AC-DR4 用源码哨兵钉住）
  app.use('/api/workbench', (req, res, next) => { req.workbenchUser = { open_id: OWNER }; next(); });
  app.use('/api/workbench', createWorkbenchSalesDraftsRouter({ sessions }));
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const withBox = async (run) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-route-'));
  const sessions = createScanSessionService({ dir });
  try {
    return await run({ dir, sessions });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const seed = async (sessions, openId, { lines = [lineOf(41, 200)], sale = {} } = {}) => {
  const session = await sessions.ensure(openId);
  await sessions.store.update(session.session_id, (current) => ({
    sale: { ...(current.sale || {}), status: 'draft', lines, ...sale },
  }));
  return sessions.get(openId);
};

test('AC-DR1 ⭐ GET /sales/drafts：200 + 草稿字段齐全 + 不泄露身份', async () => {
  await withBox(async ({ sessions }) => {
    await seed(sessions, OWNER);
    await seed(sessions, OTHER, { lines: [lineOf(40, 999)] });
    await withServer(sessions, async (base) => {
      const response = await fetch(`${base}/api/workbench/sales/drafts`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true);
      assert.equal(body.enabled, true);
      assert.equal(Array.isArray(body.drafts), true);
      assert.equal(body.drafts.length, 1, '只列当前登录用户的');
      assert.equal(body.total, 1);
      assert.equal(body.corrupt_count, 0);
      const raw = JSON.stringify(body);
      assert.equal(raw.includes(OWNER), false, '**不返回 open_id**');
      assert.equal(raw.includes('master_record_id'), false, '**不返回写库进度 id**');
      assert.equal(raw.includes('|page|'), false, '**不返回会话键 / 页面 token**');
    });
  });
});

test('AC-DR2 ⭐ POST /sales/drafts/clear：只清本地；别人的 404；写中的 400（不假成功）', async () => {
  await withBox(async ({ sessions }) => {
    const mine = await seed(sessions, OWNER);
    const other = await seed(sessions, OTHER);
    // 写中的草稿：同一个人的**另一页**（per-page 会话 ⇒ 独立文件，仍归 OWNER）
    const inFlight = await seed(sessions, `${OWNER}|page|${'c'.repeat(32)}`, {
      sale: { master_record_id: 'rec_master_route', order_no: 'XSD-20261029-0003' },
    });
    await withServer(sessions, async (base) => {
      const clear = (draftId) => fetch(`${base}/api/workbench/sales/drafts/clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draftId }),
      });
      // ① 我自己的 ⇒ 200 + 真的清空（本地）
      const ok = await clear(mine.session_id);
      assert.equal(ok.status, 200);
      const okBody = await ok.json();
      assert.equal(okBody.success, true);
      assert.equal(okBody.cleared, true);
      assert.equal((await sessions.get(OWNER)).sale.lines.length, 0, '本地那一份真的清空了');

      // ② 别人的 ⇒ 404（不泄露"别人有没有草稿"）
      const foreign = await clear(other.session_id);
      assert.equal(foreign.status, 404);
      assert.equal((await sessions.get(OTHER)).sale.lines.length, 1, '别人的草稿**一个字节都没动**');

      // ③ 写中的 ⇒ 400 + 原因（绝不假装清掉）
      const bad = await clear(inFlight.session_id);
      assert.equal(bad.status, 400);
      const badBody = await bad.json();
      assert.equal(badBody.success, false);
      assert.equal(badBody.code, 'draft_in_flight');
      assert.equal((await sessions.get(`${OWNER}|page|${'c'.repeat(32)}`)).sale.lines.length, 1, '写中的草稿不许动');
    });
  });
});

test('AC-DR3 ⭐ GET .../resume：302 + Set-Cookie（per-page 下发 token / 旧会话清 cookie），token 不进 URL', async () => {
  await withBox(async ({ sessions }) => {
    const token = 'b'.repeat(32);
    const paged = await seed(sessions, `${OWNER}|page|${token}`);
    const legacy = await seed(sessions, OWNER, { lines: [lineOf(42, 300)] });
    await withServer(sessions, async (base) => {
      // ① per-page 会话 ⇒ 下发它自己的 token（HttpOnly / Lax / Path=/）
      const pagedRes = await fetch(`${base}/api/workbench/sales/drafts/${paged.session_id}/resume`,
        { redirect: 'manual' });
      assert.equal(pagedRes.status, 302);
      assert.equal(pagedRes.headers.get('location'), '/r/rec_route_1?from=sales', '回到**同一份**草稿那一页');
      const pagedCookie = String(pagedRes.headers.get('set-cookie') || '');
      assert.match(pagedCookie, new RegExp(`scan_page_id=${token}`), 'per-page 会话要把自己的 token 交回去');
      assert.match(pagedCookie, /HttpOnly/);
      assert.match(pagedCookie, /SameSite=Lax/);
      assert.equal(String(pagedRes.headers.get('location')).includes(token), false, '**token 不进 URL**');

      // ② 旧会话（没有 token）⇒ 清掉 cookie（否则浏览器可能还带着上一份草稿的身份）
      const legacyRes = await fetch(`${base}/api/workbench/sales/drafts/${legacy.session_id}/resume`,
        { redirect: 'manual' });
      assert.equal(legacyRes.status, 302);
      const legacyCookie = String(legacyRes.headers.get('set-cookie') || '');
      assert.match(legacyCookie, /scan_page_id=;/, '旧会话 ⇒ 清 cookie');
      assert.match(legacyCookie, /Max-Age=0/);

      // ③ 不存在的 ⇒ 404（不泄露）
      const missing = await fetch(`${base}/api/workbench/sales/drafts/scan_session_ffffffffffffffff/resume`,
        { redirect: 'manual' });
      assert.equal(missing.status, 404);
    });
  });
});

test('AC-DR4 ⭐ 鉴权继承 + 复用同一份扫码会话（源码哨兵 · 不新开鉴权/不另建存储）', () => {
  // ⚠️ 只扫**代码**（迁移注释里提到旧名字不算"还在" —— 本仓既有哨兵的同一条做法）
  const stripComments = (text) => String(text)
    .replace(/\/\*(?=\s|\*|!)[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const sales = stripComments(fs.readFileSync(path.join(SERVER, 'src/routes/workbench/sales.js'), 'utf8'));
  const workbench = stripComments(fs.readFileSync(path.join(SERVER, 'src/routes/workbench.js'), 'utf8'));
  const routerFactory = stripComments(fs.readFileSync(path.join(SERVER, 'src/routes/workbenchSalesDrafts.js'), 'utf8'));

  // ① 草稿箱路由挂在销售 sub-router 里，并且用的是**扫码页同一份**会话服务
  assert.match(sales, /createWorkbenchSalesDraftsRouter\(\{ sessions: scanSessions \}\)/);
  assert.match(sales, /createScanSessionService\(\)/);
  // ② 销售 sub-router 在工作台的 `requireWorkbenchAccess` 之后被挂载（不新开鉴权 ✓）
  assert.match(workbench, /router\.use\(requireWorkbenchAccess\);/);
  const authIndex = workbench.indexOf('router.use(requireWorkbenchAccess);');
  const salesIndex = workbench.indexOf('router.use(createWorkbenchSalesRoutes(');
  assert.notEqual(salesIndex, -1);
  assert.equal(authIndex < salesIndex, true, '必须先过共享闸门，再挂销售路由（含草稿箱）');
  // ③ 本 router 自己**不装鉴权**、也不碰业务表/Base（只读本地会话 + clearSale）
  assert.equal(/requireWorkbenchAccess/.test(routerFactory), false, '不新开第二套鉴权');
  assert.equal(/bitable|Base|gateway/i.test(routerFactory), false, '草稿箱**零 Base**');
  assert.match(routerFactory, /createScanDraftBoxService/);
});
