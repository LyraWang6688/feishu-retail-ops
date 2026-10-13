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
const spyWriteService = (calls) => ({
  sessions: {
    get: async () => ({ session_id: 'sess_pf', flow: 'sale', lines: [{ number: NUMBER, cells: [{ size: '40', count: 1 }] }] }),
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
  const response = await fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return { status: response.status, html: await response.text() };
};
const get = async (base, path) => {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: COOKIE } });
  return { status: response.status, html: await response.text() };
};

test('AC-PF1 🔴 点「提交这一单」⇒ **不写任何表**（主表/明细/收款/库存都不动）', async () => {
  await withServer(async ({ base, calls }) => {
    const r = await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'submitOrder' });
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0,
      `点提交**不许**建单（实际调用：${JSON.stringify(calls)}）`);
    assert.match(r.html, /payment_pay|资金|全付|部分付/, '应当渲染**资金页**（不是直接完成 ✓）');
  });
});

test('AC-PF2 🔴 点资金页按钮 ⇒ **才**建单（拿单号）', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'submitOrder' });
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付' });
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 1, '点按钮那一刻才建单 ✓');
  });
});

test('AC-PF3 🔴 同一 `submitKey` 两跑 ⇒ 两次都用**同一把键**（幂等不许拆 ✗）', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'submitOrder' });
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付' });
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'payment_pay', payment_status: '未付' });
    const keys = calls.filter((c) => c.kind === 'submitSale').map((c) => c.submitKey);
    assert.ok(keys.length >= 1, '至少要建单一次 ✓');
    assert.equal(new Set(keys).size, 1, `两次提交必须用同一把 submitKey（实际 ${JSON.stringify(keys)}）`);
  });
});

test('AC-PF4 🔴 未点按钮前刷新 ⇒ **仍是资金页**（不是成功页/首页 ✗）', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'submitOrder' });
    const again = await get(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`);
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0, '刷新也不许建单 ✓');
    assert.match(again.html, /payment_pay|资金|全付|部分付/, '仍是资金页 ✓');
  });
});

test('AC-PF5 🔴 金额填错 ⇒ 点按钮时**原地重渲染资金页** + 同一 code/文案', async () => {
  await withServer(async ({ base, calls }) => {
    await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, { action: 'submitOrder' });
    const bad = await post(base, `${SCAN_PAGE.route.basePath}/${encodeURIComponent(NUMBER)}`, {
      action: 'payment_pay', payment_status: '部分付', payment_method: '微信', payment_amount: '',
    });
    assert.equal(calls.filter((c) => c.kind === 'submitSale').length, 0, '金额不对**不许**建单 ✓（不许假成功 ✗）');
    assert.match(bad.html, /payment_pay|资金|全付|部分付/, '应当**重渲染资金页**（带提示 ✓）');
  });
});
