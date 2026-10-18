'use strict';

/**
 * ⭐⭐ 2026-10-18（task-2「扫码会话按页面/设备隔离，防两页混单」）—— 回归判据。
 *
 * 先写"按我们的链路应该是什么效果"（业务负责人 2026-10-06 定的测试流程），再逐条对照：
 *   AC-PT1  GET 首次访问 ⇒ **Set-Cookie**（`HttpOnly` / `SameSite=Lax` / `Path=/`）；
 *           带同一 cookie 再访问 ⇒ **不再发新 token**（同一页面刷新仍是同一份草稿）。
 *   AC-PT2  **两个 token 各加各的货不混**：token A 加 40、token B 加 41 ⇒ 两个会话文件各 1 行；
 *           同一 token 再加一件 ⇒ 它自己变 2 行，另一个**仍是 1 行**（同一 token 累积 = 原行为）。
 *   AC-PT3  **提交互不影响**：token A 提交后自己的草稿清空 / 轮换幂等键；
 *           token B 的草稿 / 幂等键**一个字节都没动**，B 随后也能正常提交（两张单各一次写入）。
 *           同一 token 同一把键再点一次 ⇒ **重放（reused）**、不再写第二遍。
 *   AC-PT4  **补货 / 退货也按 token 分**（路由 → 后台那一跑 → 写服务的 `sessionKey` 一路透传）：
 *           两个 token 各提交一次 ⇒ 各自的会话块 submitted、`completed` 各 1 条；互不覆盖。
 *   AC-PT5  **无 cookie 的旧页面 ⇒ 回落 openId 共享路径且不报错**（POST 303、会话键 = openId）；
 *           它与带 token 的会话**同时存在、互不覆盖**。
 *   AC-PT6  **同一 token 过期/重试行为不变**：过期后加货会 `revive`（草稿保留）；
 *           `clearDraft` 只清它自己的会话；提交重试仍走既有幂等（reused）。
 *
 * 🔴 本文件**不改写库逻辑**：真实 `scanWriteService` + 真实 `scanSessionService` 只在
 *    飞书网关 / 销售业务层 / 采购服务上是假件（与 `test/scanPageWrite.test.js` 同一手法）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_page_isolation';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'page_isolation_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_page_isolation';
// 扫码页挂在**工作台同一道**身份闸门后面（`requireWorkbenchAccess`）——本文件只管会话隔离，
// 身份用既有那套签名 cookie 给一个固定 openId（与 `scanPageWrite.test.js` 同一个手法）。
const SESSION_SECRET = 'scan_page_token_test_session_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { createScanWriteService, waitForPendingSaleBackgrounds } = require('../src/services/scanWriteService');
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');
const pageToken = require('../src/routes/scanPage/pageToken');

const NUMBER = 'YD6693-2|黑色|A';
const OPEN_ID = 'ou_scan_page_token';

// ── 夹具（承接 `scanPageWrite.test.js` 的列形状；本文件只要"页面能渲染 + 写服务能跑"）─────
const productFields = V1_BITABLE_SCHEMA.tables.product.fields;
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    [productFields.number]: NUMBER,
    [productFields.itemNo]: 'YD6693-2',
    [productFields.color]: { text: '黑色' },
    [productFields.supplier]: ['sup_1'],
    [productFields.price]: 399,
  },
};

const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-18 20:00',
  product_record_id: 'prod_1',
  ...overrides,
});

const createFakeGateway = () => {
  const tables = { product: [PRODUCT], paymentMethod: [] };
  return {
    tables,
    listAll: async (key) => [...(tables[key] || [])],
    // 只读链路遇到 filter 会回落整表读（既有行为）；这里直接抛，用来钉"没有额外读路径"。
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async () => null,
    create: async () => { throw new Error('本文件不期望业务表 create（销售确认/采购写入都是假件）'); },
    update: async () => { throw new Error('本文件不期望业务表 update（销售确认/采购写入都是假件）'); },
    delete: async () => { throw new Error('本文件不期望业务表 delete'); },
  };
};

/**
 * 一套"真的在跑"的扫码写链路：
 *   · 会话 = **真** `createScanSessionService`（临时目录，判据直接读它的文件）；
 *   · 写服务 = **真** `createScanWriteService`（`sessionKey` / 幂等 / 轮换全是真的）；
 *   · 只有飞书网关 + 销售业务层 + 采购服务是假件（与既有 `scanPageWrite.test.js` 同手法）。
 */
const createHarness = () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-page-token-'));
  const gateway = createFakeGateway();
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const calls = { sales: [], replenish: [], returns: [] };
  let entrySeq = 0;
  const write = createScanWriteService({
    gateway,
    sessions,
    readCache: false,
    // 同步跑（本文件验的是**会话隔离**，不是异步调度；异步另有用例钉着）
    saleAsyncWrite: { enabled: false },
    references: { resolveBehavior: async () => ({ recordId: 'bh_order', fields: {} }) },
    // 每张单一个主表 id（数"到底成了几张单"靠它 —— 货/钱两跑会各调一次 confirm，用同一条主表 id）
    createSalesEntry: async () => ({ recordId: `entry_${++entrySeq}` }),
    sales: {
      confirm: async ({ salesEntryRecordId, items = [], payments = [] }) => {
        calls.sales.push({
          salesEntryRecordId,
          items: items.map((item) => ({ recordId: item.productRecordId, size: item.size })),
          payments: payments.length,
        });
        return {
          detailRecordIds: items.map((_, index) => `detail_${calls.sales.length}_${index}`),
          paymentRecordIds: payments.map((_, index) => `payment_${calls.sales.length}_${index}`),
          sourceNo: `XSD-TEST-${String(calls.sales.length).padStart(4, '0')}`,
        };
      },
    },
    status: { write: async () => ({}) },
    delivery: { deliver: async () => ({ sampleConsumedQuantity: 0 }) },
    purchase: {
      publishPurchaseRequest: async (taskId, task) => {
        calls.replenish.push({ taskId, operator: task?.draft?.operator_open_id });
        return {
          batch_no: `CGD-TEST-${calls.replenish.length}`,
          request_ids: [`req_${calls.replenish.length}`],
          batch_record_id: `batch_${calls.replenish.length}`,
        };
      },
    },
    purchaseStore: {
      get: async () => null,
      create: async (task) => task,
    },
    purchaseReturnService: {
      submit: async (taskId, draft) => {
        calls.returns.push({ taskId, operator: draft?.operator_open_id });
        return {
          batch_no: `CGD-RET-${calls.returns.length}`,
          request_ids: [`ret_${calls.returns.length}`],
          batch_record_id: `batch_ret_${calls.returns.length}`,
          taken_count: 1,
          shortfall: 0,
          shortfalls: [],
        };
      },
    },
  });
  return {
    gateway, sessions, write, calls, sessionDir,
    cleanup: () => fs.rmSync(sessionDir, { recursive: true, force: true }),
  };
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

/** 与生产同形的扫码页 App（只把"看库存"和两个页面出口换成最简替身）。 */
const createApp = (harness) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = req.requestId || crypto.randomUUID(); next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: harness.gateway,
    writeService: harness.write,
    render: {
      success: () => '<html>OK success</html>',
      message: (payload) => `<html>MSG ${payload?.title || ''}</html>`,
    },
  }));
  return app;
};

const pageUrl = (base) => `${base}${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`;

/** 既有的工作台会话 cookie（只用来过扫码页那道身份闸门；与会话隔离无关）。 */
const workbenchCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

/** 把"身份 cookie"和"页面 token cookie"拼起来（旧页面就是不拼 token 那一段）。 */
const cookieOf = (pageCookie = '') => (pageCookie ? `${workbenchCookie()}; ${pageCookie}` : workbenchCookie());

const getToken = async (base) => {
  const response = await fetch(pageUrl(base), { redirect: 'manual', headers: { cookie: workbenchCookie() } });
  assert.equal(response.status, 200, '扫码页应 200');
  const setCookie = String(response.headers.get('set-cookie') || '');
  const match = setCookie.match(new RegExp(`${pageToken.PAGE_TOKEN.cookieName}=([^;]+)`));
  assert.ok(match, `GET 首次访问必须种 per-page token（实际 Set-Cookie = ${setCookie || '(空)'}）`);
  const token = match[1];
  return { token, cookie: cookieOf(`${pageToken.PAGE_TOKEN.cookieName}=${token}`) };
};

const postForm = (base, cookie, fields) => fetch(pageUrl(base), {
  method: 'POST',
  redirect: 'manual',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    // `cookie` 是"页面 token 段"（可能为空 = 旧页面）⇒ 身份 cookie 永远带上
    cookie: cookieOf(cookie),
  },
  body: new URLSearchParams(fields).toString(),
});

const addLineForm = (size, extra = {}) => ({
  [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.addLine,
  [SCAN_WRITE.fields.size]: String(size),
  ...extra,
});

/**
 * ⭐ 两步走（2026-10-14 晚起）：「提交这一单」只到**资金页**，点「提交整单付款」才走
 * 收口那一跑（`completeSale`）。本文件要验"提交后 A 的草稿/键怎么变"⇒ 必须把第二步也走完。
 * 手法与 `test/scanPageWrite.test.js` 的 `followPaymentStep` **逐字同形**（不另发明一套）。
 */
const followPaymentStep = async (base, cookie, response) => {
  const html = await response.clone().text().catch(() => '');
  if (!html.includes('data-view="payment-pay"')) return response;
  const form = (html.match(/<form[^>]*>[\s\S]*?<\/form>/g) || [])
    .find((item) => item.includes('data-view="payment-pay"'));
  if (!form) return response;
  const actionUrl = (form.match(/action="([^"]*)"/) || [])[1] || '';
  const params = new URLSearchParams();
  for (const input of form.match(/<input[^>]*>/g) || []) {
    const name = (input.match(/name="([^"]*)"/) || [])[1];
    const value = (input.match(/value="([^"]*)"/) || [])[1] || '';
    if (!name) continue;
    const cleanName = name.replace(/&amp;/g, '&');
    let cleanValue = value.replace(/&amp;/g, '&');
    // 资金页金额必填（可填 0 = 未付）—— 与既有用例同一口径
    if (cleanName === SCAN_WRITE.fields.paymentAmount && !String(cleanValue).trim()) cleanValue = '0';
    params.append(cleanName, cleanValue);
  }
  if (!params.has(SCAN_WRITE.fields.paymentMethod)) params.set(SCAN_WRITE.fields.paymentMethod, '微信');
  const url = (actionUrl.startsWith('http') ? actionUrl : `${base}${actionUrl}`).replace(/&amp;/g, '&');
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
};

const sessionKeyFor = (token) => pageToken.pageSessionKey(OPEN_ID, token);

// ═══════════════════════════════════════════════════════════════════════════
// AC-PT1 ⭐ cookie 生命周期：首次种、之后复用（属性逐字：HttpOnly / SameSite=Lax / Path=/）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-PT1 GET 首次访问种 token（HttpOnly/SameSite=Lax/Path=/）；同一 cookie 再访问不换 token', async () => {
  const h = createHarness();
  try {
    await withServer(createApp(h), async (base) => {
      const first = await fetch(pageUrl(base), { redirect: 'manual', headers: { cookie: workbenchCookie() } });
      assert.equal(first.status, 200);
      const setCookie = String(first.headers.get('set-cookie') || '');
      assert.match(setCookie, new RegExp(`${pageToken.PAGE_TOKEN.cookieName}=[a-f0-9]{32}`),
        'token 必须是 32 位 hex 随机串（只活在 cookie 里）');
      for (const must of [/HttpOnly/, /SameSite=Lax/, /Path=\//]) {
        assert.match(setCookie, must, `cookie 必须带 ${must}`);
      }
      assert.equal(/Secure/i.test(setCookie), false, '刻意不加 Secure（本机/内网 http 也要能种上）');

      const token = setCookie.match(/scan_page_id=([^;]+)/)[1];
      const again = await fetch(pageUrl(base), {
        redirect: 'manual', headers: { cookie: cookieOf(`scan_page_id=${token}`) },
      });
      assert.equal(again.status, 200);
      assert.equal(String(again.headers.get('set-cookie') || '').includes('scan_page_id='), false,
        '已有合法 token ⇒ **不许**再发一个新的（否则刷新一次就换一份草稿 ✗）');

      // 坏 cookie 不认（不抛、按"没有"处理 ⇒ 发新的）
      const broken = await fetch(pageUrl(base), {
        redirect: 'manual', headers: { cookie: cookieOf('scan_page_id=bad') },
      });
      assert.equal(broken.status, 200);
      assert.match(String(broken.headers.get('set-cookie') || ''), /scan_page_id=[a-f0-9]{32}/,
        '认不出的 token ⇒ 当作没有 ⇒ 发一个新的');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PT2 ⭐⭐ 两个 token 各加各的货不混（同一个 openId）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-PT2 ⭐⭐ 两个 token 各加各的货不混：A 加 40、B 加 41 ⇒ 两份额外的草稿；同一 token 再加仍是它自己', async () => {
  const h = createHarness();
  try {
    await withServer(createApp(h), async (base) => {
      const a = await getToken(base);
      const b = await getToken(base);
      assert.notEqual(a.token, b.token, '两个"页面/设备"必须拿到不同 token');

      assert.equal((await postForm(base, a.cookie, addLineForm(40))).status, 303, 'A 加货 ⇒ 303 回原页');
      assert.equal((await postForm(base, b.cookie, addLineForm(41))).status, 303, 'B 加货 ⇒ 303 回原页');

      const keyA = sessionKeyFor(a.token);
      const keyB = sessionKeyFor(b.token);
      const sessionA = await h.sessions.get(keyA);
      const sessionB = await h.sessions.get(keyB);
      assert.deepEqual((sessionA?.sale?.lines || []).map((line) => line.size), [40], 'A 的草稿只有自己加的 40');
      assert.deepEqual((sessionB?.sale?.lines || []).map((line) => line.size), [41], 'B 的草稿只有自己加的 41');

      // 同一 token 再加一件 ⇒ **它自己**累积（"一部手机连着扫"的既有体验不变）
      assert.equal((await postForm(base, a.cookie, addLineForm(41))).status, 303);
      assert.deepEqual(((await h.sessions.get(keyA))?.sale?.lines || []).map((line) => line.size), [40, 41],
        '同一 token 再扫一件 ⇒ 还是它自己那份草稿（累积 ✓）');
      assert.deepEqual(((await h.sessions.get(keyB))?.sale?.lines || []).map((line) => line.size), [41],
        '另一个 token 的草稿**一个字节都没动**');

      // 旧页面的 openId 共享会话**没有被这两个 token 碰过**
      assert.equal(await h.sessions.get(OPEN_ID), null, '带 token 的加货不许再写 openId 共享会话');

      // GET 渲染出来的提交键也按页：A 页面带 A 的键、B 页面带 B 的键
      const idOf = h.sessions.idOf;
      const htmlA = await (await fetch(pageUrl(base), { headers: { cookie: a.cookie } })).text();
      const htmlB = await (await fetch(pageUrl(base), { headers: { cookie: b.cookie } })).text();
      assert.ok(htmlA.includes(`value="${sessionA.sale.key}"`), 'A 的页面要带 A 的 submit_key');
      assert.ok(htmlB.includes(`value="${sessionB.sale.key}"`), 'B 的页面要带 B 的 submit_key');
      assert.equal(htmlA.includes(sessionB.sale.key), false, 'A 页面**不许**出现 B 的幂等键');
      assert.equal(htmlB.includes(sessionA.sale.key), false, 'B 页面**不许**出现 A 的幂等键');
      assert.notEqual(idOf(keyA), idOf(keyB), '两 token 的会话 id（文件名）必须不同');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PT3 ⭐⭐ 提交互不影响（两 token 各自成单；同一 token 重放仍幂等）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-PT3 ⭐⭐ 提交互不影响：A 提交只清 A 的草稿 / 只轮换 A 的键；B 的草稿与键原样，B 随后能提交', async () => {
  const h = createHarness();
  try {
    await withServer(createApp(h), async (base) => {
      const a = await getToken(base);
      const b = await getToken(base);
      const keyA = sessionKeyFor(a.token);
      const keyB = sessionKeyFor(b.token);

      await postForm(base, a.cookie, addLineForm(40));
      await postForm(base, b.cookie, addLineForm(41));
      const submitA = (await h.sessions.get(keyA)).sale.key;
      const submitB = (await h.sessions.get(keyB)).sale.key;

      const paidForm = (key, size) => ({
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.submitOrder,
        [SCAN_WRITE.fields.submitKey]: key,
        [SCAN_WRITE.fields.size]: String(size),
        [SCAN_WRITE.fields.amount]: '100',
      });

      // ① A 提交：真实 submitSale（假业务层）⇒ 只消费 A 的草稿
      const submittedA = await postForm(base, a.cookie, paidForm(submitA, 40));
      assert.equal(submittedA.status, 200, `A 提交应走资金页 200（实际 ${submittedA.status}）`);
      // ⚠️ 2026-10-18 成对迁移（第 4 步提速）：货品页**只建主表**（不调业务层）⇒ 0 次；
      //   业务层在资金页那一跑（一次跑完）才被调 ⇒ 计在下面那一步（依据 = 第 4 步：明细/收款全留给资金页）。
      assert.equal(h.calls.sales.length, 0, 'A 提交（只建主表）⇒ 业务层尚未被调 ✓');
      const completedA = await followPaymentStep(base, a.cookie, submittedA);
      assert.equal(completedA.status, 200, `A 资金页点付款应 200（实际 ${completedA.status}）`);
      assert.equal(h.calls.sales.length, 1, 'A 资金页提交 ⇒ 业务层被调 1 次（一次跑完）✓');
      const afterA = await h.sessions.get(keyA);
      assert.equal(afterA.sale.status, SCAN_WRITE.session.statuses.submitted);
      assert.deepEqual(afterA.sale.lines, [], 'A 提交成功 ⇒ A 的草稿清空');
      assert.equal(afterA.sale.completed.length, 1, 'A 记下了这一单（幂等留档）');

      const untouchedB = await h.sessions.get(keyB);
      assert.equal(untouchedB.sale.status, SCAN_WRITE.session.statuses.draft, 'B 仍是 draft（没被 A 顶掉 ✗）');
      assert.deepEqual((untouchedB.sale.lines || []).map((line) => line.size), [41], 'B 的草稿仍原样');
      assert.equal(untouchedB.sale.key, submitB, 'B 的幂等键**没被轮换**');
      assert.equal(untouchedB.sale.completed.length, 0, 'B 的 completed 仍是空');

      // ② B 提交：它自己那份照常成单（互不影响是双向的）
      const submittedB = await postForm(base, b.cookie, paidForm(submitB, 41));
      assert.equal(submittedB.status, 200);
      assert.equal(h.calls.sales.length, 1, 'B 提交（只建主表）⇒ 业务层仍 1 次（B 的那次在资金页）');
      const completedB = await followPaymentStep(base, b.cookie, submittedB);
      assert.equal(completedB.status, 200, `B 资金页点付款应 200（实际 ${completedB.status}）`);
      // 第 4 步起：一笔单在业务层只调一次 confirm（资金页一次跑完）⇒ 按**主表 id** 数单仍成立
      assert.equal(h.calls.sales.length, 2, 'B 资金页提交 ⇒ 业务层第 2 次（B 自己那一单）');
      const orderIds = new Set(h.calls.sales.map((call) => call.salesEntryRecordId));
      assert.equal(orderIds.size, 2, 'A/B 各自成单 ⇒ **两张**主表（不是同一张被合账 ✗）');
      const afterB = await h.sessions.get(keyB);
      assert.equal(afterB.sale.status, SCAN_WRITE.session.statuses.submitted);
      assert.deepEqual(afterB.sale.lines, []);

      // ③ 同一 token 同一把键再点一次 ⇒ 既有幂等：**reused**、不再写第二遍
      const replay = await postForm(base, a.cookie, paidForm(submitA, 40));
      assert.equal(replay.status, 200, '重放仍回资金页/成功那一页（不 500）');
      assert.equal(h.calls.sales.length, 2, '重放**不许**再写一遍业务层（复用既有幂等 ✓）');
      const replaySession = await h.sessions.get(keyA);
      assert.equal(replaySession.sale.completed.length, 1, '重放不新增 completed（同一把键只写一次）');
      assert.equal(replaySession.sale.completed[0].key, submitA);
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PT4 ⭐⭐ 补货 / 退货也按 token 分（路由 → 后台那一跑 → 写服务 sessionKey）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-PT4 ⭐⭐ 补货按 token 分：A/B 各提交一次 ⇒ 各自 replenish 块 submitted；互不覆盖', async () => {
  const h = createHarness();
  try {
    await withServer(createApp(h), async (base) => {
      const a = await getToken(base);
      const b = await getToken(base);
      const keyA = sessionKeyFor(a.token);
      const keyB = sessionKeyFor(b.token);

      // 补货不要求先加货（"扫开就直接补货"是正常用法）：先把两份会话建出来，拿各自的补货键
      await h.write.sessions.ensure(keyA);
      await h.write.sessions.ensure(keyB);
      const replenishKeyA = (await h.sessions.get(keyA)).replenish.key;
      const replenishKeyB = (await h.sessions.get(keyB)).replenish.key;
      assert.notEqual(replenishKeyA, replenishKeyB, '两 token 的补货幂等键必须不同');

      const form = (key) => ({
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.replenish,
        [SCAN_WRITE.fields.submitKey]: key,
        [SCAN_WRITE.fields.replenishSizes]: '40',
        [`${SCAN_WRITE.fields.replenishQuantityPrefix}40`]: '1',
      });

      assert.equal((await postForm(base, a.cookie, form(replenishKeyA))).status, 200);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(h.calls.replenish.length, 1, 'A 的补货 ⇒ 真的走到既有写层 1 次');

      assert.equal((await postForm(base, b.cookie, form(replenishKeyB))).status, 200);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(h.calls.replenish.length, 2, 'B 的补货 ⇒ 第 2 次（没被 A 的键吸收 ✗）');

      const afterA = await h.sessions.get(keyA);
      const afterB = await h.sessions.get(keyB);
      assert.equal(afterA.replenish.status, SCAN_WRITE.session.statuses.submitted);
      assert.equal(afterB.replenish.status, SCAN_WRITE.session.statuses.submitted);
      assert.deepEqual(afterA.replenish.completed.map((item) => item.key), [replenishKeyA], 'A 只留自己的完成记录');
      assert.deepEqual(afterB.replenish.completed.map((item) => item.key), [replenishKeyB], 'B 只留自己的完成记录');
      // 业务层的"操作人"仍是真 open_id（不是会话键）
      assert.deepEqual(h.calls.replenish.map((call) => call.operator), [OPEN_ID, OPEN_ID]);
    });
  } finally { h.cleanup(); }
});

test('AC-PT4b ⭐⭐ 退货按 token 分：A/B 各提交一次 ⇒ 各自 purchaseReturn 块 submitted；互不覆盖', async () => {
  const h = createHarness();
  try {
    await withServer(createApp(h), async (base) => {
      const a = await getToken(base);
      const b = await getToken(base);
      const keyA = sessionKeyFor(a.token);
      const keyB = sessionKeyFor(b.token);
      await h.write.sessions.ensure(keyA);
      await h.write.sessions.ensure(keyB);
      const returnKeyA = (await h.sessions.get(keyA)).purchaseReturn.key;
      const returnKeyB = (await h.sessions.get(keyB)).purchaseReturn.key;

      const form = (key) => ({
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.purchaseReturn,
        [SCAN_WRITE.fields.submitKey]: key,
        [SCAN_WRITE.fields.returnSizes]: '40',
        [`${SCAN_WRITE.fields.returnQuantityPrefix}40`]: '1',
        [SCAN_WRITE.fields.purchaseAmount]: '399',
      });

      assert.equal((await postForm(base, a.cookie, form(returnKeyA))).status, 200);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(h.calls.returns.length, 1);

      assert.equal((await postForm(base, b.cookie, form(returnKeyB))).status, 200);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(h.calls.returns.length, 2, 'B 的退货是**第 2 次**（没被 A 的键吸收）');

      const afterA = await h.sessions.get(keyA);
      const afterB = await h.sessions.get(keyB);
      assert.equal(afterA.purchaseReturn.status, SCAN_WRITE.session.statuses.submitted);
      assert.equal(afterB.purchaseReturn.status, SCAN_WRITE.session.statuses.submitted);
      assert.deepEqual(afterA.purchaseReturn.completed.map((item) => item.key), [returnKeyA]);
      assert.deepEqual(afterB.purchaseReturn.completed.map((item) => item.key), [returnKeyB]);
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PT5 ⭐ 无 cookie 的旧页面 ⇒ 回落 openId 共享路径，且与 token 会话互不覆盖
// ═══════════════════════════════════════════════════════════════════════════
test('AC-PT5 ⭐ 无 cookie（旧页面）⇒ POST 照常 303、会话键 = openId；带 token 的会话与它并存互不覆盖', async () => {
  const h = createHarness();
  try {
    await withServer(createApp(h), async (base) => {
      // 先给"新设备"拿到 token（此时还没有任何旧会话 ⇒ 正常发）
      const a = await getToken(base);

      // 旧页面（没有 token cookie）：POST 照常写 openId 共享会话
      const legacy = await postForm(base, '', addLineForm(40));
      assert.equal(legacy.status, 303, '旧页面（没有 token）也必须照常 303，**不许**报错');
      assert.equal(String(legacy.headers.get('set-cookie') || '').includes('scan_page_id='), false,
        'POST 没有 cookie ⇒ **不生成**新 token（不给她凭空开一份新草稿 ✗）');
      const baseSession = await h.sessions.get(OPEN_ID);
      assert.deepEqual((baseSession?.sale?.lines || []).map((line) => line.size), [40],
        '回落到既有 openId 共享路径（与改前同一个会话键）');

      // 带 token 的页面加自己的货 ⇒ 是**另一个**会话文件，旧页面那份不动
      assert.equal((await postForm(base, a.cookie, addLineForm(41))).status, 303);
      const tokenSession = await h.sessions.get(sessionKeyFor(a.token));
      assert.deepEqual((tokenSession?.sale?.lines || []).map((line) => line.size), [41]);
      assert.deepEqual(((await h.sessions.get(OPEN_ID))?.sale?.lines || []).map((line) => line.size), [40],
        '旧页面那份草稿**一个字节都没动**');

      // 旧会话还在 ⇒ 再打开扫码页（没有 token cookie）**不发**新 token（不然她眼前的本单会消失）
      const keepLegacy = await fetch(pageUrl(base), { redirect: 'manual', headers: { cookie: workbenchCookie() } });
      assert.equal(keepLegacy.status, 200);
      assert.equal(String(keepLegacy.headers.get('set-cookie') || '').includes('scan_page_id='), false,
        'openId 那份会话还在 ⇒ 过渡期先不换身份（否则她手上"本单 N 双"会消失 ✗）');
      const legacyPage = await keepLegacy.text();
      assert.ok(legacyPage.includes('40'), '旧页面的那一页仍能看见她刚加的那一双');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PT6 ⭐ 同一 token 的过期 / 清空 / 重试行为不变（不因 token 而改变既有语义）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-PT6 ⭐ 同一 token：过期后加货会 revive（草稿保留）· clearDraft 只清自己 · 提交重试仍幂等', async () => {
  const h = createHarness();
  try {
    const keyA = sessionKeyFor('tokenaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const keyB = sessionKeyFor('tokenbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const add = (sessionKey, size) => h.write.addSaleLine({
      openId: OPEN_ID, sessionKey, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2',
      color: '黑色', size, inStock: true,
    });
    assert.equal((await add(keyA, 40)).ok, true);
    assert.equal((await add(keyA, 41)).ok, true);
    assert.equal((await add(keyB, 42)).ok, true);

    // ① 过期 ⇒ 加货走既有 `revive`：**草稿保留**（不新建空的）——与没有 token 时同一条路径
    await h.sessions.store.update(h.sessions.idOf(keyA), {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const revived = await add(keyA, 42);
    assert.equal(revived.ok, true);
    assert.equal(revived.count, 3, '过期后加货 ⇒ 续上原会话（40/41/42 三双都在），不丢草稿');

    // ② clearDraft 只清它自己的会话
    const cleared = await h.write.clearDraft({ openId: OPEN_ID, sessionKey: keyA });
    assert.equal(cleared.ok, true);
    assert.deepEqual((await h.sessions.get(keyA)).sale.lines, [], 'A 清空');
    assert.deepEqual(((await h.sessions.get(keyB))?.sale.lines || []).map((line) => line.size), [42],
      'B 的草稿**没被 A 的清空碰过**');

    // ③ 提交重试 / 重放：同一把键第二次 ⇒ reused（既有幂等一字未改）
    await add(keyA, 40);
    const submitKey = (await h.sessions.get(keyA)).sale.key;
    const first = await h.write.submitSale({
      openId: OPEN_ID, sessionKey: keyA, submitKey,
      payments: [], lineAmounts: ['100'], paymentStatus: PAYMENT_STATUS.unpaid, noDefer: true,
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.reused, false);
    const wroteOnce = h.calls.sales.length;
    const second = await h.write.submitSale({
      openId: OPEN_ID, sessionKey: keyA, submitKey,
      payments: [], lineAmounts: ['100'], paymentStatus: PAYMENT_STATUS.unpaid, noDefer: true,
    });
    assert.equal(second.ok, true);
    assert.equal(second.reused, true, '同一把键重试 ⇒ 既有幂等（reused）');
    assert.equal(h.calls.sales.length, wroteOnce, '重试**不再写业务层**');
    assert.equal(second.order_no, first.order_no, '重试把上一单结果还给她（同一单号）');
    await waitForPendingSaleBackgrounds();
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PT7 纯函数 / 包装的边界：无 token ⇒ 原样（旧路径一个字节都不变）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-PT7 没有 token ⇒ 包装函数原样返回 base（不注入 sessionKey、不改任何入参形状）', () => {
  const h = createHarness();
  try {
    assert.equal(pageToken.withPageSession(h.write, ''), h.write, '无 token ⇒ withPageSession 原样返回');
    assert.equal(pageToken.withPageSession(null, 'tok'), null);
    assert.equal(pageToken.pageSessionKey(OPEN_ID, ''), OPEN_ID, '无 token ⇒ 会话键就是 openId（改前逐字）');
    assert.equal(pageToken.pageSessionKey('', 'tok'), '', '没有 openId ⇒ 空串（不编）');

    // 幂等：已经是"openId + token"的键再传一次 ⇒ 不套娃
    const once = pageToken.pageSessionKey(OPEN_ID, 'a'.repeat(32));
    assert.equal(pageToken.pageSessionKey(once, 'a'.repeat(32)), once);
    assert.ok(once.startsWith(`${OPEN_ID}${pageToken.SESSION_KEY_SEPARATOR}`));

    // cookie 解析：多个 cookie / 坏值都不抛
    const parsed = pageToken.parseCookieHeader('a=1; scan_page_id=deadbeef; b=2');
    assert.equal(parsed.scan_page_id, 'deadbeef');
    assert.equal(pageToken.parseCookieHeader('scan_page_id=%zz').scan_page_id, undefined, '坏百分号编码不抛、当没有');
  } finally { h.cleanup(); }
});
