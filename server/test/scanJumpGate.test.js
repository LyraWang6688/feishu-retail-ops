'use strict';

/**
 * ⭐⭐⭐ 2026-10-16（task-53 · P0 **第二刀**）：「**跳转资金页**」的**前置判定** —— 验收标准。
 *
 * ## 她的口径（业务负责人，逐字 · 2026-10-16）
 * > 「算了，这样吧，**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
 * >  才可以点击提交跳转到资金页，**不用做那个为空去单价的功能了**」
 * ⇒ 判据 = **尺码已填 且 她填的实收金额已填**；缺任一 ⇒ **400 + 停在货品页 + 人话 + 零写入** ✓
 * ⇒ ⭐ **不再读单价**：`submitView.price_text` ✗ · 草稿行 `service.lookup` ✗ ·「其他配品.单价」✗
 *   ⇒ 判定本体**一次表都不读**（AC-J6 钉着 ✓）。
 *
 * ## 落点（`routes/scanPage.js`）
 * 插在"提交前那一次 `service.lookup`"**之后**、"点提交 ⇒ 跳资金页"那**一个**出口**之前**：
 *   · **贴住出口** ⇒ 一跳资金页就必须先过它（不会"跳了又拦"✓）；
 *   · **不往前挪** ⇒ 更早的出口会连带罩住**幂等连点 / 重复提交 / 刷新 / 资金页动作** ✗
 *     （①刀那 6～13 条红就是挪早了 ✗）；
 *   · 既有那道老闸门（`lineAmountRequired && lineAmounts.some(空)`）**一字不改**，
 *     新判定**独立成块**（不塞进那个 `if` 里 ✗）。
 *
 * ## 验收标准（每条**能真红** ✓；变异法写在括号里）
 * · **AC-J1 ⭐ 缺金额 ⇒ 拦**（只在 body 给尺码、一分钱都没填）⇒ 400 + 不许是资金页 + 人话 + 零写入。
 *   （变异：删掉判定块 ⇒ 红。）
 * · **AC-J2 ⭐ 缺尺码 ⇒ 拦**（钱填了但本单一条尺码都没有）⇒ 同上。（变异：只判金额 ⇒ 红。）
 * · **AC-J3 ⭐ 两个都有 ⇒ 放行**（`size` + `line_amount`）⇒ **200 资金页**。（变异：写成"恒拦" ⇒ 红。）
 * · **AC-J4 ⭐ 会话来源**：本次 body **不带** size/金额，但**草稿行**里 `size:'40'` + `amount:'100'`（= 用例 ⑧ 的形状）⇒
 *   **200 资金页**。（变异：只读 body 不看草稿行 ⇒ 红 —— 这条钉住"会话"是真源。）
 * · **AC-J5 零写入**：被拦那一下 `salesEntry / salesDetail / paymentRecord / inventoryLedger` 全 0。
 * · **AC-J6 判据一次表都不读**：假网关**没有** `get` / `listAll` 调用记录。
 *   （变异：加回 `service.lookup` ⇒ 红。）
 * · **AC-J7 ⭐ 反向哨兵（不许拦）**：重复提交（会话标记 `paymentStep='pending'`）/ 带收款字段那一发 /
 *   资金页那颗动作（`payAction`）⇒ **一律不是 400**。
 *   （变异：把入口条件里的"不带收款字段"或 `paymentStep` 去掉 ⇒ 红。）
 *
 * ⚠️ 走**真的**扫码路由（准入闸门是它的第一层）+ 假 service / 假 writeService
 *   ⇒ 测的是**项目代码**那条路（不是用例里手拼页面 ✓）。
 * ⚠️ 判据里**一个字的旧列名都没有**（「成交金额」/「交易方式」）—— 有既有哨兵钉着
 *   （`scanSaleTwoLayerMoney.test.js:300` / `:1369`）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// 路由模块在 require 时就会 `new V1BitableGateway()`（构造时读飞书凭证）；给一对假凭证只为能加载。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_jump_gate';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_jump_gate_secret';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const SESSION_SECRET = 'scan_jump_gate_test_secret';
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
const OPEN_ID = 'ou_scan_jump_gate';
const PAYMENT_MARK = 'data-view="payment-step"';

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

/** 与 `routes/feishuWebAuth.js` 的 encodeSession 同一套签名（"造一个已登录的会话"）。 */
const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17（AC-P1）：测试服务器**不保持 keep-alive**（临时端口会被 OS 复用 ⇒ 偶发 ECONNRESET）。
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

/** 一条"商品找得到"的只读视图（够渲染销售块）。 */
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
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 10:00',
  product_record_id: 'prod_1',
  ...overrides,
});

/**
 * 假 writeService —— 会话是**可变的**（`saveDraftLines` 真的把 patch 合进去），
 * 这样"她填/没填"两条路都是**真跑了一遍**，不是"看着像"✓。
 * ⚠️ 假**网关**：`get` / `listAll` 都记账 ⇒ AC-J6 才能钉住"判定一次表都不读" ✓。
 */
const fakeWriteService = (sale = {}) => {
  const patches = [];
  const calls = [];
  const writes = [];
  const session = { sale: { ...sale } };
  const sessions = {
    async get() { return { sale: { ...session.sale } }; },
    async submitKeyFor() { return 'scan_sale:key:1'; },
    async saveSaleProgress(unusedOpenId, patch) {
      patches.push(patch);
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === undefined) delete session.sale[key];
        else session.sale[key] = value;
      }
      return { sale: { ...session.sale } };
    },
  };
  return {
    patches,
    calls,
    writes,
    session,
    sessions,
    saveDraftLines: (openId, patch) => sessions.saveSaleProgress(openId, patch),
    listAccessories: async () => [],
    // ⭐ AC-J5 的"零写入"哨兵：**任何**写库动作都要经过这两个口（她这一单真写库就是它们）——
    //   被拦时它们**一次都不许被调** ✓（假网关那三个读口由 AC-J6 钉 ✓）。
    async submitSale(input) { calls.push({ kind: 'submitSale' }); writes.push({ kind: 'submitSale', input }); return { ok: true, order_no: 'XSD-J5' }; },
    async addSaleLine(input) { calls.push({ kind: 'addSaleLine' }); writes.push({ kind: 'addSaleLine', input }); return { ok: true }; },
  };
};

/** 假网关：只记"有没有被读过表"（判定本体**不该**读任何表 ✓）。 */
const fakeGateway = () => {
  const reads = [];
  return {
    reads,
    async get(...args) { reads.push(['get', ...args]); return null; },
    async listAll(...args) { reads.push(['listAll', ...args]); return []; },
    async listByFilter(...args) { reads.push(['listByFilter', ...args]); return []; },
  };
};

const appFor = ({ write, gateway, lookup = async () => view() } = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // 生产里每个请求都带 `req.requestId`（`app.js` 的中间件）⇒ 照摆一个（只是补环境 ✓）。
  app.use((req, res, next) => { req.requestId = 'req_scan_jump_gate'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup },
    gateway,
    writeService: write,
    startSnapshot: false,
  }));
  return app;
};

/** 她点「提交这一单」那一下（POST；`extra` 就是"她这一发带了什么"）。 */
const postSubmit = (base, extra = {}, cookie = sessionCookie()) => fetch(`${base}/s/${ENCODED}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ action: SCAN_WRITE.actions.submitOrder, ...extra }).toString(),
});

const NOTICE = SCAN_PAGE.texts.jumpGateNoticeTitle;

// ═══════════════════════════════════════════════════════════════════════════
// AC-J1 / J2 / J3 / J4 / J5 / J6：判定本体
// ═══════════════════════════════════════════════════════════════════════════

test('AC-J1 ⭐ 缺金额（只给了尺码）⇒ 400 + 停在货品页 + 人话 + 零写入', async () => {
  login();
  const write = fakeWriteService({ lines: [], paymentStep: '' });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    const response = await postSubmit(base, {
      submit_key: 'scan_sale:key:1', [SCAN_WRITE.fields.size]: '40',
    });
    const html = await response.text();
    assert.equal(response.status, 400, `缺金额 ⇒ 拦住（实际 ${response.status}）：${html.slice(0, 200)}`);
    assert.equal(html.includes(PAYMENT_MARK), false, '🔴 不许跳资金页（就停在货品页 ✓）');
    assert.ok(html.includes(NOTICE), `必须有那句人话「${NOTICE}」`);
    // AC-J5 零写入：**任何**写库动作一次都没有（`submitSale` / `addSaleLine` 两个口）
    assert.deepEqual(write.writes, [], `被拦下 ⇒ 零写入（实际写了：${JSON.stringify(write.calls)}）`);
    assert.deepEqual(gateway.reads, [], 'AC-J6 判定本体**一次表都不读**（少一次飞书读 ✓）');
  });
});

test('AC-J2 ⭐ 缺尺码（钱填了但本单一条尺码都没有）⇒ 400 + 人话 + 零写入', async () => {
  login();
  const write = fakeWriteService({ lines: [], paymentStep: '' });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    const response = await postSubmit(base, {
      submit_key: 'scan_sale:key:1', [SCAN_WRITE.fields.amount]: '399',
    });
    const html = await response.text();
    assert.equal(response.status, 400, `缺尺码 ⇒ 拦住（实际 ${response.status}）：${html.slice(0, 200)}`);
    assert.equal(html.includes(PAYMENT_MARK), false, '🔴 不许跳资金页（就停在货品页 ✓）');
    assert.ok(html.includes(NOTICE), `必须有那句人话「${NOTICE}」`);
    assert.deepEqual(write.writes, [], 'AC-J5 被拦下 ⇒ 零写入 ✓');
    assert.deepEqual(gateway.reads, [], 'AC-J6 判定本体**一次表都不读** ✓');
  });
});

test('AC-J3 ⭐ 尺码 + 金额都有 ⇒ 放行到资金页（200）', async () => {
  login();
  const write = fakeWriteService({ lines: [], paymentStep: '' });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    const response = await postSubmit(base, {
      submit_key: 'scan_sale:key:1', [SCAN_WRITE.fields.size]: '40', [SCAN_WRITE.fields.amount]: '399',
    });
    const html = await response.text();
    assert.equal(response.status, 200, `两个都有 ⇒ 放行（实际 ${response.status}）：${html.slice(0, 200)}`);
    assert.ok(html.includes(PAYMENT_MARK), '⭐ 到资金页 ✓');
    assert.equal(html.includes(NOTICE), false, '放行那一发**不许**出现拦住那句人话 ✗');
  });
});

test('AC-J4 ⭐ 会话是真源：本次 body 不带 size/金额，但**草稿行**里有 ⇒ 放行', async () => {
  login();
  // = 用例 ⑧ 的形状：多行时那一发 body 不带 size/金额，真值都在会话草稿行里。
  const write = fakeWriteService({
    lines: [{ kind: 'shoe', size: 40, amount: '100' }],
    paymentStep: '',
  });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    const response = await postSubmit(base, { submit_key: 'scan_sale:key:1' });
    const html = await response.text();
    assert.equal(response.status, 200, `草稿行里有尺码+金额 ⇒ 放行（实际 ${response.status}）：${html.slice(0, 200)}`);
    assert.ok(html.includes(PAYMENT_MARK), '⭐ 到资金页 ✓');
  });
});

test('AC-J6 ⭐ 判据一次表都不读：缺任一被拦时，假网关**一条读记录都没有**', async () => {
  login();
  const write = fakeWriteService({ lines: [], paymentStep: '' });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    // 缺金额那一发（判定**进了**、并且真的拦住）——它不该读任何表。
    const blocked = await postSubmit(base, { submit_key: 'scan_sale:key:1', [SCAN_WRITE.fields.size]: '40' });
    assert.equal(blocked.status, 400, '先确认这一发真的进了判定 + 被拦住 ✓');
    await blocked.text();
    assert.deepEqual(gateway.reads, [],
      `判定本体**一次表都不读**（少一次飞书读 ✓）—— 实际读了：${JSON.stringify(gateway.reads)}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-J7 ⭐ 反向哨兵：这些**一律不许**拦成 400
// ═══════════════════════════════════════════════════════════════════════════

test('AC-J7a ⭐ 反向哨兵：幂等重复提交（会话已 `paymentStep=pending` + 缺金额）⇒ **不许**拦', async () => {
  login();
  // 她**第一次**点提交被放行过（标记落成 pending）；这一刻她再点一次 / 刷新之后又点一次 ⇒
  //   与 ⑨ 同形（也没带金额）⇒ 只能靠"第一发"这个入口条件区分 ✓（去掉它 ⇒ 这条红 ✓）。
  const write = fakeWriteService({ lines: [{ kind: 'shoe', size: 40, amount: '399' }], paymentStep: 'pending' });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    const response = await postSubmit(base, { submit_key: 'scan_sale:key:1' });
    const html = await response.text();
    assert.notEqual(response.status, 400, `重复提交**不许**被拦（实际 ${response.status}）：${html.slice(0, 200)}`);
    assert.ok(html.includes(PAYMENT_MARK), '照旧给资金页 ✓');
  });
});

test('AC-J7b ⭐ 反向哨兵：这一发**带着收款字段** ⇒ **不许**进判定（资金页那一跳照旧）', async () => {
  login();
  const write = fakeWriteService({ lines: [], paymentStep: '' });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    const response = await postSubmit(base, {
      submit_key: 'scan_sale:key:1',
      [SCAN_WRITE.fields.size]: '40',
      [SCAN_WRITE.fields.lineAmount]: '280',
    });
    await response.text();
    assert.notEqual(response.status, 400, `带收款字段那一发**不许**被拦（实际 ${response.status}）`);
  });
});

test('AC-J7c ⭐ 反向哨兵：资金页那颗动作（`payAction` · 带金额）⇒ **不是 400**', async () => {
  login();
  const write = fakeWriteService({
    lines: [{ kind: 'shoe', size: 40, amount: '280' }],
    paymentStep: 'pending',
    submitPending: { size: '40', amount: '280' },
  });
  const gateway = fakeGateway();
  await withServer(appFor({ write, gateway }), async (base) => {
    for (const action of [SCAN_PAGE.paymentStep.payAction]) {
      const response = await fetch(`${base}/s/${ENCODED}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
        // ⭐ 2026-10-18（金额必填 · 可填 0）：资金页现在**金额必填** ⇒ 这条反向哨兵补一个合法金额 `0`
        //   （它守的是「跳转闸门不许拦资金页动作」；金额必填闸门由 `scanSaleE2E` 的 AC-E2E-19 单独钉）
        body: new URLSearchParams({
          action, submit_key: 'scan_sale:key:1',
          [SCAN_WRITE.fields.paymentMethod]: '微信', [SCAN_WRITE.fields.paymentAmount]: '0',
        }).toString(),
      });
      const html = await response.text();
      assert.notEqual(response.status, 400, `${action} 不许被拦成 400（实际 ${response.status}）：${html.slice(0, 200)}`);
    }
  });
});
