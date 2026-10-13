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
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, config: SCAN_PAGE,
    writeService: spyWriteService(calls), purchaseSizeReader: { listSizes: async () => [] },
    followup: { addPayment: async () => ({ ok: true }) },
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
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

test('AC-PF1 🔴 点「提交这一单」⇒ **不写任何表**（主表/明细/收款/库存都不动）', { skip: '必须与第二小步**同批**落：只做前置会让「提交」不再建单 ⇒ 实测 31 条既有用例红 ✗（见 PR 描述）' }, async () => {
  await withServer(async ({ base, calls }) => {
    const r = await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder });
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0,
      `点提交**不许**建单（实际调用：${JSON.stringify(calls)}）`);
    assert.match(r.html, /payment_pay|资金|全付|部分付/, '应当渲染**资金页**（不是直接完成 ✓）');
  });
});

test('AC-PF2 🔴 点资金页按钮 ⇒ **才**建单（拿单号）', { skip: '第二小步（点资金页按钮才建单）：本小步只做资金页前置 ⇒ PF1/PF4 绿即验收 ✓' }, async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder });
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付' });
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1, '点按钮那一刻才建单 ✓');
  });
});

test('AC-PF3 🔴 同一 `submitKey` 两跑 ⇒ 两次都用**同一把键**（幂等不许拆 ✗）', { skip: '第二小步（点资金页按钮才建单）：本小步只做资金页前置 ⇒ PF1/PF4 绿即验收 ✓' }, async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder });
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付' });
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付' });
    const keys = calls.filter((c) => c.kind === 'submitSale').map((c) => c.submitKey);
    assert.ok(keys.length >= 1, '至少要建单一次 ✓');
    assert.equal(new Set(keys).size, 1, `两次提交必须用同一把 submitKey（实际 ${JSON.stringify(keys)}）`);
  });
});

test('AC-PF4 🔴 未点按钮前刷新 ⇒ **仍是资金页**（不是成功页/首页 ✗）', { skip: '必须与第二小步**同批**落：只做前置会让「提交」不再建单 ⇒ 实测 31 条既有用例红 ✗（见 PR 描述）' }, async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder });
    const again = await get(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`);
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0, '刷新也不许建单 ✓');
    assert.match(again.html, /payment_pay|资金|全付|部分付/, '仍是资金页 ✓');
  });
});

test('AC-PF5 🔴 金额填错 ⇒ 点按钮时**原地重渲染资金页** + 同一 code/文案', { skip: '第二小步（点资金页按钮才建单）：本小步只做资金页前置 ⇒ PF1/PF4 绿即验收 ✓' }, async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: SCAN_WRITE.actions.submitOrder });
    const bad = await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, {
      action: 'payment_pay', payment_status: '部分付', payment_method: '微信', payment_amount: '',
    });
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0, '金额不对**不许**建单 ✓（不许假成功 ✗）');
    assert.match(bad.html, /payment_pay|资金|全付|部分付/, '应当**重渲染资金页**（带提示 ✓）');
  });
});
