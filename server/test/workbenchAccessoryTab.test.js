/**
 * ⭐⭐ 2026-10-14 晚：把「配品」整体搬进工作台「销售 → 配品」子 tab
 *   业务负责人逐字：「把配品给迁移到工作台销售里，新建一个子 tab，整体都迁移过去，只是入口变了，逻辑没有变」
 *                ＋「配品页的成交金额确实要必填」
 * 口径真源：`docs/accessory-in-workbench-2026-10-14.md`（AC-AC1…AC-AC9）· 配置真源：`config/workbenchAccessory.js`
 *
 * ⚠️ 本文件钉的是**工作台这一层**（路由编排 + 配置）：一步成单（1 次 addSaleLine + 1 次 submitSale ✓）·
 *    **零库存动作**（只调这两个既有写方法 ✓ 没有任何库存调用 ✓）· 同键两跑**同一把** `submitKey` ✓ ·
 *    成交金额必填（空/非正数 ⇒ 400 + 人话 **且一个字都不写** ✓）。
 * ⚠️ 「测试 Base 真跑数表」属于**带凭证的环境**（服务器/CI）该跑的那一步 ✓：本文件把它拆成
 *    "路由必须调这两个既有方法 + 只调它们" ✓（写入语义本身由 `test/scanSaleAccessoryAndRemark.test.js` 覆盖 ✓）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_acc_tab_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'acc_tab_test_secret';

const { createWorkbenchRouter } = require('../src/routes/workbench');
const accessoryTab = require('../src/config/workbenchAccessory');
const { SCAN_WRITE } = require('../src/config/scanWrite');

// pass the workbench gate the same way the other route tests do (auth on + signed cookie)
const SESSION_SECRET = 'workbench_accessory_tab_test_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
const sessionCookie = (openId = 'ou_acc_tab') => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 'T', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const COOKIE = sessionCookie();

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
/** 挂真正的 router，只把**写服务**换成探针（既有测试的同一姿势 ✓） */
const appFor = (scanWrite) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({ gateway: {}, scanWrite }));
  app.use((error, req, res, next) => res.status(500).json({ success: false, error: error.message }));
  return app;
};
const spyOf = (list = []) => {
  const calls = [];
  return {
    calls,
    listAccessories: async () => { calls.push({ method: 'listAccessories' }); return list; },
    addSaleLine: async (input) => { calls.push({ method: 'addSaleLine', input }); return { ok: true, count: 1 }; },
    submitSale: async (input) => {
      calls.push({ method: 'submitSale', input });
      return { ok: true, order_no: 'XSD-ACC-1', detail_count: 1, payment_count: 1, reused: calls.filter((c) => c.method === 'submitSale').length > 1 };
    },
  };
};
const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { cookie: COOKIE, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('AC-AC1 ⭐ 工作台「销售」下出现子 tab「配品」（位置 = 订单列表/销售查询/客户往来款之后 ✓）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'config', 'domains.js'), 'utf8');
  const sales = src.slice(src.indexOf("id: 'sales'"));
  const order = sales.indexOf("id: 'sales-orders'");
  const query = sales.indexOf("id: 'sales-query'");
  const acc = sales.indexOf("id: 'sales-accessory'");
  assert.ok(order > -1 && query > -1 && acc > -1, '三个子页都必须在');
  assert.ok(acc > order && acc > query, '配品必须排在订单列表 / 销售查询**之后** ✓');
  assert.match(sales.slice(acc, acc + 120), /kind: 'accessory'/, "配品子页 kind 必须是 'accessory' ✓");
  assert.match(sales.slice(acc, acc + 120), /label: '配品'/, 'label 逐字「配品」✓');
});

test('AC-AC2 ⭐ 清单来自**既有**只读接口（`GET /sales/accessories`）· 空清单 ⇒ 照样 200 + 空数组 ✓', async () => {
  const spy = spyOf([{ record_id: 'acc_1', name: '腰带' }]);
  await withServer(appFor(spy), async (base) => {
    const res = await fetch(`${base}/api/workbench${accessoryTab.api.list}`, { headers: { cookie: COOKIE } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.accessories, [{ record_id: 'acc_1', name: '腰带' }]);
    assert.equal(spy.calls.filter((c) => c.method === 'listAccessories').length, 1, '走的就是既有 listAccessories ✓');
  });
  const empty = spyOf([]);
  await withServer(appFor(empty), async (base) => {
    const res = await fetch(`${base}/api/workbench${accessoryTab.api.list}`, { headers: { cookie: COOKIE } });
    const body = await res.json();
    assert.equal(res.status, 200, `empty list must be 200 (got ${res.status} ${JSON.stringify(body)})`);
    assert.deepEqual(body.accessories, [], 'empty list -> []');
  });
});

test('AC-AC3 ⭐⭐ 一步成单：提交一次 ⇒ addSaleLine(kind=accessory) 1 次 + submitSale 1 次（收款 1 行 ✓）', async () => {
  const spy = spyOf();
  await withServer(appFor(spy), async (base) => {
    const res = await post(base, `/api/workbench${accessoryTab.api.submit}`, {
      accessoryRecordId: 'acc_1', amount: '199', submitKey: 'k-1', requestId: 'r-1',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.order_no, 'XSD-ACC-1');
    const add = spy.calls.filter((c) => c.method === 'addSaleLine');
    const sub = spy.calls.filter((c) => c.method === 'submitSale');
    assert.equal(add.length, 1, '只加一行配品 ✓');
    assert.equal(add[0].input.kind, 'accessory', 'kind 由**路由**给（不取表单 ✗）');
    assert.equal(add[0].input.accessoryRecordId, 'acc_1');
    assert.equal(add[0].input.amount, '199');
    assert.equal(sub.length, 1, '只提交一次 ✓');
    assert.equal(sub[0].input.payments.length, 1, '收款只写 1 行 ✓');
    assert.equal(sub[0].input.payments[0].amount, '199', '金额原样 ✓');
    assert.equal(sub[0].input.paymentStatus, SCAN_WRITE.sale.paymentStatus.full, "付款方式 = 已拍板值域里的「全付」✓");
    assert.equal(sub[0].input.paidAmount, '199');
  });
});

test('AC-AC4 🔴 零库存动作：这一趟**只**调那两个既有写方法（没有任何库存/流水调用 ✓）', async () => {
  const spy = spyOf();
  await withServer(appFor(spy), async (base) => {
    await post(base, `/api/workbench${accessoryTab.api.submit}`, {
      accessoryRecordId: 'acc_1', amount: '88', submitKey: 'k-stock', requestId: 'r-stock',
    });
  });
  const methods = [...new Set(spy.calls.map((c) => c.method))].sort();
  assert.deepEqual(methods, ['addSaleLine', 'submitSale'],
    `配品这条路**只许**调这两个既有写方法（实际 ${JSON.stringify(methods)}）—— 零库存动作 ✓`);
  // 源码哨兵：工作台配品那两条接口里不许出现库存相关的调用 ✗
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'workbench.js'), 'utf8');
  const block = route.slice(route.indexOf('accessoryTab.api.list'), route.indexOf("router.post('/sales/detail-amounts'"));
  for (const word of ['Inventory', 'inventory', 'stockMovements', 'liveInventory']) {
    assert.equal(block.includes(word), false, `配品接口里不该出现 ${word}（配品不产生库存动作 ✗）`);
  }
});

test('AC-AC5 ⭐ 幂等：**同一把 submitKey**原样下传（同键两跑 ⇒ 服务层只建一单 ✓ 路由不另造键 ✗）', async () => {
  const spy = spyOf();
  await withServer(appFor(spy), async (base) => {
    for (const rid of ['r-a', 'r-b']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await post(base, `/api/workbench${accessoryTab.api.submit}`, {
        accessoryRecordId: 'acc_1', amount: '50', submitKey: 'same-key', requestId: rid,
      });
      assert.equal(res.status, 200);
    }
  });
  const keys = spy.calls.filter((c) => c.method === 'submitSale').map((c) => c.input.submitKey);
  assert.deepEqual(keys, ['same-key', 'same-key'], '两跑必须带**同一把**键 ✓（幂等不许拆 ✗）');
  assert.equal(spy.calls.filter((c) => c.method === 'submitSale').length, 2, '路由不自己去重（去重在服务层 / 同一把键 ✓）');
});

test('AC-AC6 ⭐⭐ 成交金额必填：空 / 0 / 负数 ⇒ **HTTP 400 + 人话**，且**一个字都不写** ✗', async () => {
  for (const amount of ['', '   ', '0', '-5', 'abc']) {
    const spy = spyOf();
    // eslint-disable-next-line no-await-in-loop
    await withServer(appFor(spy), async (base) => {
      const res = await post(base, `/api/workbench${accessoryTab.api.submit}`, {
        accessoryRecordId: 'acc_1', amount, submitKey: 'k-bad', requestId: 'r-bad',
      });
      assert.equal(res.status, 400, `amount=${JSON.stringify(amount)} 必须 400 ✗`);
      const body = await res.json();
      assert.equal(body.success, false, '绝不返回成功 ✗');
      assert.equal(body.error, accessoryTab.texts.amountRequired, '人话来自配置 ✓');
      assert.deepEqual(spy.calls, [], `amount=${JSON.stringify(amount)} 时**四表零写入** ✓（实际 ${JSON.stringify(spy.calls)}）`);
    });
  }
});

test('AC-AC9 ⭐ 旧入口不死：扫码页 `?from=accessory` 仍**回落销售** ✓（#523 已定 · 不回归 ✗）', () => {
  const { resolveRealm } = require('../src/views/scanPageRealm');
  assert.equal(resolveRealm('accessory'), 'sales', 'accessory 已搬走 ⇒ 扫码页回落销售 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 前端（AC-AC7 / AC-AC8）—— 源码级哨兵：默认值 · 配置化文案 · 44px · 即时反馈
// ═══════════════════════════════════════════════════════════════════════════
const FEATURE = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'features', 'accessory', 'index.js'), 'utf8');
const FE_CONFIG = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'config', 'accessory.js'), 'utf8');
const DOMAINS_FEATURE = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'features', 'domains', 'index.js'), 'utf8');

test('AC-AC1b: the sub-page is really mounted (kind accessory has its own module)', () => {
  assert.ok(DOMAINS_FEATURE.includes("page.kind === 'accessory'"), 'domains 特性必须分派 accessory ✓');
  assert.ok(DOMAINS_FEATURE.includes("from '../accessory/index.js'"), 'import 必须指向新模块 ✓');
  assert.ok(FEATURE.includes('export const createAccessoryModule'), '模块必须导出 createAccessoryModule ✓');
});

test('AC-AC7 ⭐ 数量默认 **1**（页面渲染值 ✓ 不填也能提交 ✓）', () => {
  assert.match(FE_CONFIG, /ACCESSORY_DEFAULT_QUANTITY\s*=\s*1;/, '默认值必须在配置里且 = 1 ✓');
  assert.ok(FEATURE.includes('value="${ACCESSORY_DEFAULT_QUANTITY}"'), '渲染时用配置里的默认值 ✓');
  assert.ok(FEATURE.includes('inputmode="numeric"'), '数量是数字输入 ✓');
});

test('AC-AC8 ⭐⭐ UI 硬规矩：文案**全部走配置** ✓ · 控件 ≥44px（既有令牌 ✓）· 点击**即时反馈** ✓', () => {
  // ① 文案零硬编码：这个 feature 文件里**不许有中文**（全部来自 `config/accessory.js` ✓）
  // ⚠️ 先剥注释（注释里解释口径会用中文 ✗）—— 判据本意是**渲染文案**零硬编码 ✓
  const featureCode = FEATURE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/[\u4e00-\u9fff]/.test(featureCode), false, '前端 feature 的**代码**里不许有中文字面量（走配置 ✗）');
  assert.ok(FE_CONFIG.includes('ACCESSORY_TEXTS'), '文案配置必须在 ✓');
  // ② 44px：控件用的是既有 `.btn` / `input` / `select`（base.css 里给了 --control-height ✓）
  const base = fs.readFileSync(path.join(__dirname, '..', 'public', 'workbench', 'styles', 'base.css'), 'utf8');
  assert.match(base, /\.btn,\s*input,\s*select\s*\{[^}]*min-height:\s*var\(--control-height\)/, '既有控件样式必须给 ≥44px ✓');
  assert.ok(FEATURE.includes('class="btn btn-primary"'), '提交按钮用既有按钮样式 ✓');
  // ③ 即时反馈：请求**之前**就置灰 + 换文案 ✓（不是等响应 ✗）
  const submitBody = FEATURE.slice(FEATURE.indexOf('const submit = async'), FEATURE.indexOf('return {'));
  assert.ok(submitBody.indexOf('button.disabled = true') < submitBody.indexOf('await api.post'),
    '必须先置灰再发请求（点击即时反馈 ✓）');
  assert.ok(submitBody.includes('button.textContent = T.submitting'), '文案也要立刻换 ✓');
  // ④ 失败**如实**：有 catch + 人话，且不吞错 ✗
  assert.ok(submitBody.includes('catch (error)'), '要有 catch ✓');
  assert.ok(submitBody.includes('error?.message || T.submitFailed'), '失败给服务端人话或兜底人话 ✓');
  // ⑤ 空清单 ⇒ 人话空态卡（不留空下拉 ✗）
  assert.ok(FEATURE.includes('data-view="accessory-empty"'), '空清单要有人话卡 ✓');
});
