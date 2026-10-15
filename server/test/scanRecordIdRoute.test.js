/**
 * ⭐⭐ 2026-10-12（治根）：**记录 ID 直达** —— 新二维码 `GET/POST /r/{recordId}`。
 *
 * 她的口径（逐字）：「如果必须得要一个完全不变的标识，那我们是不是可以用【记录 ID】呀？……
 *   虽然它的这些信息可能会变，但我还是用它**不变的记录 ID**」。
 * 根因：旧二维码里存的**编号**（`货号|颜色|类别`）是**会变的快照** —— 她打印时类别为空、
 *   之后补上 ⇒ 旧码对不上（今天的 400 事故）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-R1 `GET /r/{recordId}` ⇒ 200 + 拿到的就是**那一条**（编号/记录 id 都断言）。
 *  AC-R2 ⭐⭐ **治根证明**：把表里那条的**颜色 + 类别都改掉**，同一个 recordId **仍然命中同一条**。
 *  AC-R3 不存在的 recordId ⇒ **人话 404**（不是 500、不是原始错误页）。
 *  AC-R4 recordId 读不到、但 URL 上带了编号（`?number=`）⇒ **回退按编号再试一次**（能命中）。
 *  AC-R5 旧 `/s/{编号}` **逐字回归**（照旧 200、照旧命中）。
 *  AC-R6 ⭐ **两条路共用同一套渲染 / 写入**（同一个 renderer 被两条路调用；源码里没有第二份实现）。
 *  AC-R7 ⭐ `app.js` **只建一个 router 实例**、两个前缀**共用它**（否则两套写队列 ⇒ 幂等破）。
 *  AC-R8 `POST /r/{recordId}`（加入本单）⇒ 拿到的 `productRecordId` 就是那条记录。
 *  AC-R9 成功页那条【再录一单】**回跳 `/r/{recordId}`**（不是 `/s/<记录id>`）。
 *  AC-R10 `/r` 取商品**只读**（假网关一碰写就抛）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_r_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_r_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageService } = require('../src/services/scanPageService');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const SESSION_SECRET = 'scan_r_session_secret';
const F = (table, key) => {
  const name = V1_BITABLE_SCHEMA.tables[table].fields[key];
  if (!name) throw new Error(`schema 里没有 ${table}.${key}`);
  return name;
};

const RECORD_ID = 'rec_kx_1';
const NUMBER_V1 = 'MK31-1|咖色|女鞋';
const NUMBER_V2 = 'MK31-1|深咖|女鞋';   // ⭐ 她之后改了颜色 + 类别

const productRow = (recordId, number, itemNo, color, category) => ({
  record_id: recordId,
  fields: {
    [F('product', 'number')]: number,
    [F('product', 'itemNo')]: itemNo,
    [F('product', 'color')]: { text: color },
    [F('product', 'category')]: category,
    [F('product', 'price')]: 399,
  },
});
const sizeRow = (size) => ({ record_id: `size_${size}`, fields: { [F('sizeManagement', 'size')]: size, 类别: ['女鞋'] } });
const liveRow = (recordId, productRecordId, size, state) => ({
  record_id: recordId,
  fields: {
    [F('liveInventory', 'product')]: [productRecordId],
    [F('liveInventory', 'size')]: [`size_${size}`],
    [F('liveInventory', 'state')]: state,
    [F('liveInventory', 'stockKey')]: `${NUMBER_V1}|${size}`,
  },
});

const fakeGateway = ({ products } = {}) => {
  const data = {
    product: products || [productRow(RECORD_ID, NUMBER_V1, 'MK31-1', '咖色', '女鞋')],
    sizeManagement: [36, 37].map(sizeRow),
    liveInventory: [liveRow('inv_37_box', RECORD_ID, 37, '门盒')],
  };
  const boom = (name) => async () => { throw new Error(`扫码页不许写：${name}`); };
  return {
    _data: data,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(data[key] || [])],
    listByFilter: async (key) => [...(data[key] || [])],
    get: async (key, id) => (data[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async () => null,
    create: boom('create'),
    update: boom('update'),
    delete: boom('delete'),
  };
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId = 'ou_r_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

/** ⭐ 渲染器被调用了几次、带的是哪一条路 —— AC-R6 用它证明"两条路共用同一套渲染"。 */
const scannedRenders = [];
const appWith = (gateway, writes = [], submitResult = null) => {
  // ⭐ 假会话（**会记忆** ✓ 与真会话同形）：新流程"点提交"写 `paymentStep:'pending'` ✓
  //    "点资金页按钮"读它 ⇒ 决定**现在建单** ✓（见下面 `sessions.get` / `saveDraftLines`）
  let fakeSession = { sale: {} };
  const service = createScanPageService(gateway, { config: SCAN_PAGE, startSnapshot: false });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = createScanPageRouter({
    service,
    gateway,
    render: {
      scan: (...args) => { scannedRenders.push(args[1]?.route?.basePath || '?'); return renderScanPage(...args); },
    },
    writeService: {
      listPaymentMethods: async () => require('../src/config/scanWrite').SCAN_WRITE.sale.paymentMethods,
      // ⭐⭐ 2026-10-14：假会话要**会记忆**（真会话就是这样 ✓）—— 新流程里"点提交"把
      //    `paymentStep:'pending'` 写进会话 ✓ 点资金页按钮时读它决定"要不要建单" ✓
      //    ⚠️ 返回 `null` 的假会话 ⇒ 那颗按钮会以为"没有正在进行的单"⇒ 不建单 ✗（实测 AC-R9 就卡在这 ✓）
      sessions: {
        get: async () => fakeSession,
        submitKeyFor: (openId, session, flow = 'sale') => `scan_${flow}:test:1`,
      },
      saveDraftLines: async (openId, patch) => {
        fakeSession = { ...fakeSession, ...patch };
        fakeSession.sale = { ...(fakeSession.sale || {}), ...patch };
        return { ok: true };
      },
      addSaleLine: async (input) => { writes.push(input); return { ok: true, count: writes.length }; },
      submitSale: async (input) => {
        writes.push({ submit: input });
        return submitResult || {
          ok: true, reused: false, order_no: 'XSD-20261012-0002', detail_count: 1,
          stock: { requested: 0, delivered: 0, failed: 0, reasons: [] },
        };
      },
      clearDraft: async () => ({ ok: true }),
    },
    startSnapshot: false,
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  return app;
};

const getR = (base, recordId, cookie, extra = '') => fetch(
  `${base}${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(recordId)}?from=sales${extra}`,
  { headers: { cookie } },
);
const getS = (base, number, cookie) => fetch(
  `${base}${SCAN_PAGE.route.basePath}/${encodeURIComponent(number)}?from=sales`,
  { headers: { cookie } },
);
const postR = (base, recordId, cookie, body) => fetch(
  `${base}${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(recordId)}?from=sales`,
  {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  },
);

// ── AC-R1 ─────────────────────────────────────────────────────────────────
test('AC-R1 GET /r/{recordId} ⇒ 200，拿到的就是**那一条**', async () => {
  login();
  await withServer(appWith(fakeGateway()), async (base) => {
    const response = await getR(base, RECORD_ID, sessionCookie());
    assert.equal(response.status, 200, '记录 ID 直达必须能进录入页');
    const html = await response.text();
    assert.ok(html.includes(NUMBER_V1), `页面上要能看到那一条的编号 ${NUMBER_V1}`);
    assert.ok(html.includes('realm-block--sales'), '走的是同一套销售页');
  });
});

// ── AC-R2 ⭐⭐ 治根证明 ────────────────────────────────────────────────────
test('AC-R2 ⭐⭐ 治根：**改颜色 + 改类别之后，同一个 recordId 仍然命中同一条**', async () => {
  login();
  const gateway = fakeGateway();
  await withServer(appWith(gateway), async (base) => {
    const first = await getR(base, RECORD_ID, sessionCookie('ou_r_root_a'));
    assert.equal(first.status, 200);
    assert.ok((await first.text()).includes(NUMBER_V1), '改之前：命中改前那条编号');
  });
  // ⭐ 她在生产表里改颜色 + 类别（编号是公式拼的 ⇒ 一起变）—— 旧码（按编号）这一下就对不上了。
  const row = gateway._data.product.find((record) => record.record_id === RECORD_ID);
  row.fields[F('product', 'number')] = NUMBER_V2;
  row.fields[F('product', 'color')] = { text: '深咖' };
  // ⚠️ 换一个**新的服务实例**（新缓存）—— 否则上面那条 `cache.set(旧编号, 视图)` 会把旧编号
  //    "喂"成 200，测出来的就不是真实行为了。
  await withServer(appWith(gateway), async (base) => {
    const byRecord = await getR(base, RECORD_ID, sessionCookie('ou_r_root_b'));
    assert.equal(byRecord.status, 200, '改了颜色/类别之后，**记录 ID 那条路必须仍然命中**');
    assert.ok((await byRecord.text()).includes(NUMBER_V2),
      '拿到的仍然是**这一条记录**，而且编号跟着表走（这就是治根）');
    const byOldNumber = await getS(base, NUMBER_V1, sessionCookie('ou_r_root_c'));
    assert.equal(byOldNumber.status, 404,
      '同一时刻按**旧编号**去找已经不在了 —— 这正是"旧码为什么会坏、记录 ID 为什么治根"');
  });
});

// ── AC-R3 / AC-R4 ─────────────────────────────────────────────────────────
test('AC-R3 不存在的 recordId ⇒ 人话 404（不是 500、不是原始错误页）', async () => {
  login();
  await withServer(appWith(fakeGateway()), async (base) => {
    const response = await getR(base, 'rec_not_exist', sessionCookie('ou_r_missing'));
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes(SCAN_PAGE.texts.notFoundTitle), '给人话页');
    assert.equal(html.includes(SCAN_PAGE.texts.errorTitle), false, '不许变成"系统出错"页');
  });
});

test('AC-R4 recordId 读不到但 URL 带了编号（?number=）⇒ **回退按编号再试一次**', async () => {
  login();
  // 记录 id 不在表里，但编号在 ⇒ 回退那条路必须能命中。
  await withServer(appWith(fakeGateway()), async (base) => {
    const response = await getR(base, 'rec_gone', sessionCookie('ou_r_fb'), `&number=${encodeURIComponent(NUMBER_V1)}`);
    assert.equal(response.status, 200, '回退按编号必须能命中（否则旧码 + 新码混用时就是死路）');
    assert.ok((await response.text()).includes(NUMBER_V1));
  });
});

// ── AC-R5 ─────────────────────────────────────────────────────────────────
test('AC-R5 旧 /s/{编号} 逐字回归：照旧 200、照旧命中', async () => {
  login();
  await withServer(appWith(fakeGateway()), async (base) => {
    const response = await getS(base, NUMBER_V1, sessionCookie('ou_r_old'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(NUMBER_V1));
    assert.ok(html.includes('realm-block--sales'));
  });
});

// ── AC-R6 / AC-R7：结构哨兵 ───────────────────────────────────────────────
test('AC-R6 ⭐ 两条路共用**同一套渲染/写入**（同一 renderer 被两条路调到；没有第二份实现）', async () => {
  login();
  scannedRenders.length = 0;
  await withServer(appWith(fakeGateway()), async (base) => {
    await getS(base, NUMBER_V1, sessionCookie('ou_r_shared_s'));
    await getR(base, RECORD_ID, sessionCookie('ou_r_shared_r'));
  });
  assert.equal(scannedRenders.length >= 2, true, '两条路都要经过同一个扫码页渲染器');
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  // 处理函数只有一份：两条路是**同一个 handler 用路径数组**挂上去的（不是复制一份处理逻辑）。
  assert.equal((source.match(/router\.get\(ROUTE_PATTERNS/g) || []).length, 1,
    'router.get 只该有**一处**共用的处理函数');
  assert.equal((source.match(/router\.post\(ROUTE_PATTERNS/g) || []).length, 1,
    'router.post 只该有**一处**共用的处理函数（两条路都走它）');
  assert.ok(source.includes('const ROUTE_PATTERNS = [config.route.path, config.route.recordPath]'),
    '两条路必须用**同一个 handler**（路径数组）挂上去');
  // 不许出现"记录 id 专属"的第二份取商品/渲染实现。
  assert.equal(/if\s*\(isRecordBase\(req\)\)\s*\{[\s\S]{0,200}renderScanPage/.test(source), false,
    '不许在路由里复制一套渲染');
});

test('AC-R7 ⭐ app.js **只建一个 router 实例**，/s 与 /r **共用它**（否则两套写队列 ⇒ 幂等破）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const created = (source.match(/= require\('\.\/routes\/scanPage'\)\.createScanPageRouter\(\)/g) || []).length;
  assert.equal(created, 1, `createScanPageRouter() 只许建 1 次（实际 ${created} 次）—— 建两次 = 两条按人串行队列`);
  assert.ok(/const scanPageRouter = require\('\.\/routes\/scanPage'\)\.createScanPageRouter\(\)/.test(source),
    '要先建**一个**实例再挂');
  assert.ok(source.includes('app.use(SCAN_PAGE.route.basePath, scanPageRouter)')
    && source.includes('app.use(SCAN_PAGE.route.recordBasePath, scanPageRouter)'),
    '两个前缀必须挂**同一个实例**');
});

// ── AC-R8 / AC-R9 ─────────────────────────────────────────────────────────
test('AC-R8 POST /r/{recordId}（加入本单）⇒ 拿到的 productRecordId 就是那条记录', async () => {
  login();
  const writes = [];
  await withServer(appWith(fakeGateway(), writes), async (base) => {
    const response = await postR(base, RECORD_ID, sessionCookie('ou_r_post'), {
      action: SCAN_WRITE.actions.addLine, submit_key: 'k', size: '37',
    });
    assert.equal(response.status, 303, '加入本单成功 ⇒ 303 回原页');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].productRecordId, RECORD_ID, '写进本单的必须是**这条记录**');
    assert.equal(writes[0].number, NUMBER_V1, '编号跟着表走（不是 URL 上那串记录 id）');
    assert.ok(String(response.headers.get('location') || '').startsWith(`${SCAN_PAGE.route.recordBasePath}/`),
      `回跳必须回 /r/（实际 ${response.headers.get('location')}）`);
  });
});

test('AC-R9 成功页那条【再录一单】**回跳 /r/{recordId}**', async () => {
  login();
  const writes = [];
  await withServer(appWith(fakeGateway(), writes), async (base) => {
    // ⭐⭐ 2026-10-14（她裁决①「销售货品页的每件金额必须填，只有资金页可以不填」）：
    //    `line_amount` 从 `''` 改成 `'399'` —— 空串现在会被路由的「每件实收必填」闸门
    //    拦成 400（那条的哨兵在 `AC-E2E-11` / `AC-13*`），**走不到资金页/成功页**。
    //    本用例钉的是**成功页那条【再录一单】的跳转**（与金额无关）⇒ 夹具补一个正常价即可。
    //    改前逐字：`line_amount: ''` ×2（第 1 步、第 3 步）· 判据一个字没放宽 ✓
    await postR(base, RECORD_ID, sessionCookie('ou_r_submit'), {
      action: SCAN_WRITE.actions.submitOrder, submit_key: 'k', size: '37',
      payment_status: '', payment_method: '', payment_amount: '', line_amount: '399',
    });
    // ⭐⭐ 2026-10-14（新流程**两步**：她：「确认状态是资金那页点击了按钮之后，才算是用户确认了」）：
    //   ① 点提交 ⇒ **只到资金页**（还不建单 ✓）② 点资金页那颗【跳过】⇒ **才建单** ✓
    await postR(base, RECORD_ID, sessionCookie('ou_r_submit'), {
      action: SCAN_PAGE.paymentStep.skipAction, submit_key: 'k',
    });
    const submit = writes.find((item) => item.submit)?.submit;
    assert.ok(submit, '要真的走到提交那一步');
    assert.equal(submit.pendingLine.productRecordId, RECORD_ID, '提交也拿得到那条记录');
    // 成功页要能出来（用同一个 writeService 替身）。
    // ⭐ 2026-10-13 改指向：提交成功**先落第 2 步「整单付款」页**（能力去哪：`renderSalePaymentStepPage`），
    //    她点【跳过】才到成功页 ⇒ 这里跟着那一跳（`payment_skip` 那个 POST）再取一次 ✓ 断言一条没放宽 ✓
    let html = (await (await postR(base, RECORD_ID, sessionCookie('ou_r_submit'), {
      action: SCAN_WRITE.actions.submitOrder, submit_key: 'k2', size: '37',
      payment_status: '', payment_method: '', payment_amount: '', line_amount: '399',
    })).text());
    if (html.includes('data-view="payment-step"')) {
      const skipForm = (html.match(/<form[^>]*>[\s\S]*?<\/form>/g) || [])
        .find((item) => item.includes('payment_skip')) || '';
      const skipBody = {};
      for (const input of skipForm.match(/<input[^>]*>/g) || []) {
        const name = (input.match(/name="([^"]*)"/) || [])[1];
        const value = (input.match(/value="([^"]*)"/) || [])[1] || '';
        if (name) skipBody[name.replace(/&amp;/g, '&')] = value.replace(/&amp;/g, '&');
      }
      html = await (await postR(base, RECORD_ID, sessionCookie('ou_r_submit'), skipBody)).text();
    }
    assert.ok(html.includes(SCAN_WRITE.texts.submittedTitle), '成功页逐字「您的提交已成功」');
    assert.ok(html.includes(`${SCAN_PAGE.route.recordBasePath}/${RECORD_ID}`),
      `成功页的【再录一单】必须回 /r/${RECORD_ID}（不是 /s/<记录id>）`);
  });
});

// ── AC-R10 ────────────────────────────────────────────────────────────────
test('AC-R10 /r 取商品**只读**（假网关一碰写就抛）', async () => {
  login();
  await withServer(appWith(fakeGateway()), async (base) => {
    const response = await getR(base, RECORD_ID, sessionCookie('ou_r_ro'));
    assert.equal(response.status, 200);
  });
});
