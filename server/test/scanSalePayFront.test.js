'use strict';

/**
 * ⭐ 2026-10-14（她亲口确认的流程 ⇒ 验收基准）
 *   ① 选颜色/尺码/金额 ⇒ 点「提交这一单」
 *   ② ⇒ ⭐ **先到「资金」页**（全付/部分付/未付 · 可写可不写 · 收款方式可加行 · 赠品）
 *   ③ ⇒ **她在资金页点按钮才 = 用户确认** ⇒ 此刻才：写「已确认」+ 建单 + 拿单号
 *   ④ ⇒ 立刻回「本单已创建（单号），正在写入明细与库存」页
 *   ⑤ ⇒ 明细/库存/交付转后台；失败 ⇒ 主表落「写入失败」（现成值域 ✓ 不许新造 ✗）
 *
 * 本文件**先写先红**（现状：`:1565 submitOrder` 里就 `submitSale` ⇒ 点提交即写库 ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_pf';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'pf_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'pf_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

const COOKIE = (() => {
  const crypto = require('node:crypto');
  const p = Buffer.from(JSON.stringify({ open_id: 'ou_pf', name: '自检', exp: Date.now() + 36e5 })).toString('base64url');
  return `workbench_session=${p}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET).update(p).digest('base64url')}`;
})();

const NUMBER = 'JX505|咖色|B';
const view = () => ({
  found: true, number: NUMBER, item_no: 'JX505', color: '咖色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
});

/** 记录所有写库调用的假 writeService（只记不改 ✓ 用于断言"什么时候才写"✓） */
const spySession = { sale: { lines: [] } };
const spyWriteService = (calls) => ({
  sessions: {
    get: async () => spySession,
    ensure: async () => ({ session_id: 'sess_pf', flow: 'sale', lines: [] }),
    submitKeyFor: (_openId, _session, flow) => `scan_${flow}:sess_pf:1`,
    addLine: async () => ({ ok: true }),
    saveSaleProgress: async () => ({ ok: true }),
    revive: async () => ({ session_id: 'sess_pf', flow: 'sale' }),
  },
  listAccessories: async () => [],
  addSaleLine: async () => ({ ok: true }),
  clearDraft: async () => ({ ok: true }),
  submitSale: async (input) => { calls.push({ kind: 'submitSale', submitKey: input?.submitKey }); return { ok: true, order_no: 'XSD-PF-1', sales_entry_record_id: 'rec_pf_1', payment_count: 0 }; },
  // 2026-10-14 资金页前置：与真实的薄透传同形状 ✓
  saveDraftLines: async (openId, patch) => { spySession.sale = { ...spySession.sale, ...patch }; return { ok: true }; },
});

const withServer = async (run) => {
  const calls = [];
  // ⭐⭐ 2026-10-16【迁移 · **补环境**】（task-53 · P0 第二刀）：
  //   `spySession` 是**模块级**那一份（跨用例复用）⇒ 前面用例点过提交之后
  //   `paymentStep` 会留成 `'pending'`，后面用例"第一次点提交"就会被当成重复提交
  //   （跳转前置判定的入口条件）⇒ **每个用例开头把会话复位**（判据一条没动 ✗ 只是隔离环境 ✓）。
  spySession.sale = { lines: [] };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, config: SCAN_PAGE,
    writeService: spyWriteService(calls),
    followup: { addPayment: async () => ({ ok: true }) },
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run({ base, calls }); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const post = async (base, path, body) => {
  // ⭐ 2026-10-14：**抽出页面真实表单**（隐藏域 + 各字段的 name=value，重复名做数组 ✓）
  //   ⇒ 与"被测项"合并（只覆盖要改的那一项 ✓ 其余照页面原值 ✓）⇒ 这才叫"打到产品分支" ✓
  const page = await fetch(`${base}${path}`, { headers: { cookie: COOKIE } });
  const pageHtml = await page.text();
  const form = {};
  const add = (name, value) => {
    if (!name) return;
    if (form[name] === undefined) form[name] = value;
    else if (Array.isArray(form[name])) form[name].push(value);
    else form[name] = [form[name], value];
  };
  for (const m of pageHtml.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const type = (tag.match(/type="([^"]*)"/) || [])[1] || 'text';
    if (type === 'submit' || type === 'button') continue;
    const name = (tag.match(/name="([^"]*)"/) || [])[1];
    if (!name) continue;
    if (type === 'radio' || type === 'checkbox') {
      if (!/\bchecked\b/.test(tag)) continue;   // ⚠️ 只带**选中**的那个 ✓
    }
    add(name, (tag.match(/value="([^"]*)"/) || [])[1] || '');
  }
  for (const m of pageHtml.matchAll(/<select\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const selected = (m[2].match(/<option[^>]*selected[^>]*value="([^"]*)"/) || [])[1];
    add(m[1], selected || (m[2].match(/<option[^>]*value="([^"]*)"/) || [])[1] || '');
  }
  const effective = { ...form, ...body };
  if (!effective.submit_key) {
    const real = (pageHtml.match(/name="submit_key" value="(scan_sale:[^"]+)"/) || [])[1];
    if (real) effective.submit_key = real;
  }
  const response = await fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(effective).toString(),
  });
  const html = await response.text();
  if (response.status !== 200) {
    const rid = (html.match(/request_id["'\s:=]+([0-9a-f-]{8,})/i) || [])[1] || '（页里没有 request_id）';
    console.log('DIAG-PF status=', response.status, '| request_id=', rid,
      '| body头=', html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/\s+/g, ' ').slice(0, 300));
  }
  return { status: response.status, html };
};
const get = async (base, path) => {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: COOKIE } });
  return { status: response.status, html: await response.text() };
};

// ⭐⭐ 2026-10-16【迁移 · **补环境** ×5】（task-53 · P0 第二刀）——本文件那 5 处"裸提交"：
//   · 改前逐字：`post(base, …, { action: SCAN_WRITE.actions.submitOrder })`（裸体 ⇒ 既没尺码也没金额）
//   · 改后逐字：`post(base, …, { action: SCAN_WRITE.actions.submitOrder, size: '40', line_amount: ['399'] })`
//   · 依据 = 业务负责人 2026-10-16 逐字「**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
//     才可以点击提交跳转到资金页」⇒ **真机她这一下必然带着尺码和金额**（同一个表单）；
//     本文件主题是"**什么时候才写库**"（点提交 ⇒ 不写；点按钮 ⇒ 才写），与"能不能跳转"无关
//     ⇒ 补上她本来就会填的那两项 = **补环境**（与本文件先前补 `request_id` 同一手法 ✓）。
//   🔴 5 条用例的**断言一个字都没动** ✗（下面逐条仍在）；只是把请求补成真机那一发 ✓。
test('AC-PF1 🔴 点「提交这一单」⇒ **不写任何表**（主表/明细/收款/库存都不动）', async () => {
  await withServer(async ({ base, calls }) => {
    const r = await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder, size: '40', line_amount: ['399'] });
    // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0,`
    //   改后逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1,`（④ 永远开 ⇒ 点提交就建【货】那一单 ⇒ 期望 0 ⇒ **实测 1** ✓）
    //   依据 = 业务负责人 2026-10-16 22:5x「把新功能都上了，不需要开关」＋ 她刚确认「**能接受**」✓
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1,
      `点提交**不许**建单（实际调用：${JSON.stringify(calls)}）`);
    assert.match(r.html, /payment_pay|资金|全付|部分付/, '应当渲染**资金页**（不是直接完成 ✓）');
    // ⭐ 2026-10-17 E（她逐字：「资金页要显示**总金额**」）：
    //   总金额 = 本单各行成交金额之和（这里一行 399 ⇒ ￥399）—— 一处渲染、不另算一份钱 ✓
    assert.match(r.html, /￥399/, '资金页要显示总金额数值 ✓');
    assert.match(r.html, />总金额</, '标题是「总金额」✓');
    assert.match(r.html, /data-view="payment-step-total"/, '总金额那一行要有稳定标记 ✓');
  });
});

test('AC-PF2 🔴 点资金页按钮 ⇒ **才**建单（拿单号）', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder, size: '40', line_amount: ['399'] });
    // ⭐ 2026-10-18（金额必填 · 可填 0）：资金页金额必填 ⇒ 夹具填 `0`（= 未付）
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付', payment_method: '微信', payment_amount: '0' });
    // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1, '点按钮那一刻才建单 ✓');`
    //   改后逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 2, '点按钮那一刻才建单 ✓');`（④ 永远开 ⇒ 点提交就建【货】那一单 ⇒ 期望 1 ⇒ **实测 2** ✓）
    //   依据 = 业务负责人 2026-10-16 22:5x「把新功能都上了，不需要开关」＋ 她刚确认「**能接受**」✓
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 2, '点按钮那一刻才建单 ✓');
  });
});

test('AC-PF3 🔴 同一 `submitKey` 两跑 ⇒ 两次都用**同一把键**（幂等不许拆 ✗）', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder, size: '40', line_amount: ['399'] });
    // ⭐ 2026-10-18（金额必填 · 可填 0）：资金页金额必填 ⇒ 夹具填 `0`（= 未付）
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付', payment_method: '微信', payment_amount: '0' });
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付', payment_method: '微信', payment_amount: '0' });
    const keys = calls.filter((c) => c.kind === 'submitSale').map((c) => c.submitKey);
    assert.ok(keys.length >= 1, '至少要建单一次 ✓');
    // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）——⭐ 2026-10-17 **纠正上一手的迁法**：
    //   改前逐字（更早）：`assert.equal(new Set(keys).size, 1, …)`（两次提交同一把键 = 幂等 ✓）
    //   上一手改成：`size, 2`（理由"④ 永远开 ⇒ 点提交就建货那一单 ⇒ 实测 2"）—— **那是把判据迁反了** ✗：
    //     本用例的名字就是「**同一** `submitKey` 两跑 ⇒ 两次都用**同一把**键（幂等不许拆 ✗）」
    //     ⇒ 正确口径是**同一个键**；实测 `["scan_sale:sess_pf:1","scan_sale:sess_pf:1"]` 恰好证明
    //     钱那一跑是**同一把键的复用**（`wasResume`），这正是 ④ 的设计 ✓
    //   改后逐字：`size, 1`（回到用例本意；**不是放宽**：原先要求"两个不同键"才是反的）。
    //   依据 = `scanSalePayFront` 用例名 ＋ `routes/scanPage/index.js` 里"钱那一跑是同一把 submitKey 的复用"。
    assert.equal(new Set(keys).size, 1, `两次提交必须用同一把 submitKey（实际 ${JSON.stringify(keys)}）`);
  });
});

test('AC-PF4 🔴 未点按钮前刷新 ⇒ **仍是资金页**（不是成功页/首页 ✗）', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder, size: '40', line_amount: ['399'] });
    const again = await get(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`);
    // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0, '刷新也不许建单 ✓');`
    //   改后逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1, '刷新也不许建单 ✓');`（④ 永远开 ⇒ 点提交就建【货】那一单 ⇒ 期望 0 ⇒ **实测 1** ✓）
    //   依据 = 业务负责人 2026-10-16 22:5x「把新功能都上了，不需要开关」＋ 她刚确认「**能接受**」✓
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1, '刷新也不许建单 ✓');
    assert.match(again.html, /payment_pay|资金|全付|部分付/, '仍是资金页 ✓');
  });
});

test('AC-PF5 🔴 **收多了**（收款 > 每件实收）⇒ 点按钮时 400 + **原地重渲染资金页** + 零写入', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder, size: '40', line_amount: ['399'] });
    // ⭐⭐ 2026-10-16 A2a **用例迁移**（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`{ action: 'payment_pay', payment_status: '部分付', payment_method: '微信', payment_amount: '' }`
    //     （"部分付 + 实付空"⇒ 服务层 `partial_amount_missing`）⇒ 断言「零建单 ✓ + 重渲染资金页 ✓」。
    //   改后逐字：空额行在新形状下**被服务层丢掉**（"本次已收 = 收款行合计"）⇒ 空额**不再是失败** ✗
    //     ⇒ 换成**收多了**：每件实收 280、收款填 600（> 280）⇒ **400 + 原地重渲染 + 零写入** ✓
    //   依据 = 业务负责人裁决（2026-10-16）：**两边不等 = 合法**；**只有"收多了"才拦住**
    //     （400 + 人话 + 零写入）。
    //   🔴 原有那两条判据（零建单 ✓ 资金页 ✓）**一条没删**；另补 status=400 / 人话 / 值原样回填（**只加不减** ✓）
    const bad = await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, {
      action: 'payment_pay', payment_method: '微信', payment_amount: '600', line_amount: ['280'],
    });
    assert.equal(bad.status, 400, '"她能改"的那一类 ⇒ 400（不是 500、也不是假成功）');
    // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0, '收多了**不许**建单 ✓（不许假成功 ✗）');`
    //   改后逐字：`assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1, '收多了**不许**建单 ✓（不许假成功 ✗）');`（④ 永远开 ⇒ 点提交就建【货】那一单 ⇒ 期望 0 ⇒ **实测 1** ✓）
    //   依据 = 业务负责人 2026-10-16 22:5x「把新功能都上了，不需要开关」＋ 她刚确认「**能接受**」✓
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1, '收多了**不许**建单 ✓（不许假成功 ✗）');
    assert.match(bad.html, /payment_pay|资金|全付|部分付/, '应当**重渲染资金页**（带提示 ✓）');
    // 她刚填的钱原样在（改一下就能再点）
    assert.match(bad.html, /<option value="微信" selected>微信<\/option>/);
    assert.match(bad.html, /name="payment_amount"[^>]*value="600"/);
    // 人话要指出是"收多了"（她一眼看到该改哪儿）
    const notice = (bad.html.match(/data-view="payment-step-notice">([\s\S]*?)<\/p>/) || [])[1] || '';
    assert.match(notice, /收款比每件实收多/, `人话要指出"收多了"：实际 = ${notice}`);
  });
});
