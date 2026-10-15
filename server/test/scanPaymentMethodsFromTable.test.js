'use strict';

/**
 * ⭐⭐ 2026-10-16 A2a ③：**候选收款方式改读表**（`services/paymentMethodsService.js`）。
 *
 * 她 2026-10-14 逐字：「**付款方式用交易方式管理，可选择**」⇒ 资金页那一列候选 =
 * 「收款方式管理」表里**真实那几条**（只读 ✓ + TTL 缓存 ✓）—— 她点名要过「抖音团购券」。
 * 🔴 **读不到表** ⇒ **大声 `logWarn` + 退回配置里的方式**：
 *    · **不许静默**（静默 ⇒ 表坏了没人知道 ✗）；
 *    · **不许留白**（这一页是**展示** —— 候选为空 ⇒ 她"点不出来"，收款这一步就走不下去 ✗）。
 *
 * ⚠️ 本文件**只钉这一件事**（页面其余行为在既有用例里 ✓ 不重复）。
 * ⚠️ 与 `listAccessories` 的口径**刻意不同**（配品读不到给空清单 ✗）—— 见路由里那份注释。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_pm';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'pm_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'pm_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

const COOKIE = (() => {
  const crypto = require('node:crypto');
  const p = Buffer.from(JSON.stringify({ open_id: 'ou_pm', name: '自检', exp: Date.now() + 36e5 })).toString('base64url');
  return `workbench_session=${p}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET).update(p).digest('base64url')}`;
})();

const NUMBER = 'JX505|咖色|B';
const VIEW = () => ({
  found: true, number: NUMBER, item_no: 'JX505', color: '咖色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
});

/** 走**真路由**（只把只读 service 与写服务换成假的 ✓ 表那一读走真 `paymentMethodsService` ✓）。 */
const withServer = async (gateway, run) => {
  const app = express();
  app.use((req, res, next) => { req.requestId = 'req_pm'; next(); });
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    gateway,
    config: SCAN_PAGE,
    startSnapshot: false,
    service: { lookup: async () => VIEW() },
    writeService: {
      sessions: {
        get: async () => ({
          // ⭐ `paymentStep: 'pending'` + 草稿有行 ⇒ GET 走**资金页**那一支（收款行就在这页上 ✓）
          sale: { paymentStep: 'pending', lines: [{ item_no: 'JX505', size: '40', amount: '100' }] },
        }),
        submitKeyFor: () => 'scan_sale:pm:1',
      },
    },
  }));
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const getMoneyPage = async (base) => (await fetch(
  `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, { headers: { cookie: COOKIE } },
)).text();

/** 假的「收款方式管理」表（只回答这一个 tableKey ✓ 别的读一律空表）。 */
const tableGateway = (methods, calls = []) => ({
  async listAll(tableKey) {
    calls.push(tableKey);
    if (tableKey !== 'paymentMethod') return [];
    return methods.map((name, index) => ({ record_id: `pm_${index}`, fields: { 收款方式: name } }));
  },
});

const configuredFallback = () => [...new Set([
  SCAN_WRITE.sale.defaultPaymentMethod, ...(SCAN_WRITE.sale.paymentMethods || []),
].filter(Boolean))];

// ═══════════════════════════════════════════════════════════════════════════
// AC-A2A-3a / 3c 读得到表 ⇒ 表里那几条都点得到（且 TTL 缓存）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A2A-3a ⭐ 候选收款方式 = 读「收款方式管理」表：表里那几条都点得到（默认微信仍排第一）', async () => {
  const calls = [];
  const gateway = tableGateway(['支付宝', '抖音代金券（89.9）'], calls);
  await withServer(gateway, async (base) => {
    const html = await getMoneyPage(base);
    assert.ok(html.includes('data-view="payment-step"'), '这一趟渲染的是**资金页**（收款行那一列在它上面）');
    for (const name of ['支付宝', '抖音代金券（89.9）']) {
      assert.ok(html.includes(`<option value="${name}"`), `表里的「${name}」必须可选（她点名要过团购券）`);
    }
    // ⭐ 默认方式（配置）照旧**排在第一位**并选中 —— 她 2026-10-08：「默认微信」
    assert.ok(html.includes('<option value="微信" selected>微信</option>'),
      '第一行默认选中「微信」（与改前同一口径 ✓ 排在第一位）');
    assert.equal(calls.filter((key) => key === 'paymentMethod').length, 1, '这一趟**恰好读一次**收款方式表');
  });
});

test('AC-A2A-3c ⭐ TTL 缓存：连着渲染两次只读一次表（这一页不该每次扫码都多打一次飞书）', async () => {
  const calls = [];
  await withServer(tableGateway(['现金'], calls), async (base) => {
    await getMoneyPage(base);
    await getMoneyPage(base);
    assert.equal(calls.filter((key) => key === 'paymentMethod').length, 1,
      `TTL 内第二次渲染必须命中缓存（实际读了 ${calls.filter((k) => k === 'paymentMethod').length} 次）`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A2A-3b 读不到 ⇒ 大声 warn + 退回配置（**不许静默 ✗ 不许留白 ✗**）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A2A-3b 🔴 表读不到 ⇒ **大声 warn**（"收款方式表读不到 / 退回配置"）+ **退回配置里的方式**（不留白）', async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (line) => { warns.push(String(line)); };
  try {
    const gateway = { async listAll() { throw new Error('bitable 503'); } };
    await withServer(gateway, async (base) => {
      const html = await getMoneyPage(base);
      assert.ok(html.includes('data-view="payment-step"'), '读不到表**不许破她的页面**（照旧出资金页 ✓）');
      // 🔴 **不许留白**：配置里那几条一条不少（否则她"点不出来"，收款这一步走不下去 ✗）
      for (const name of configuredFallback()) {
        assert.ok(html.includes(`<option value="${name}"`), `读不到表也必须退回配置里的「${name}」`);
      }
      assert.ok(html.includes('<option value="微信" selected>微信</option>'), '默认方式照旧选中');
      // 🔴 **不许静默**：必须有一条可 grep、写清"表读不到 / 退回配置"的 warn
      const entries = warns.map((line) => JSON.parse(line));
      const entry = entries.find((item) => item.event === 'scan.sale.payment_methods_unreadable');
      assert.ok(entry, `读不到表必须**大声**warn（实际 warns=${JSON.stringify(warns)}）`);
      assert.equal(entry.reason, 'payment_methods_unreadable');
      assert.match(String(entry.message || ''), /收款方式表读不到.*退回配置/, '文案要写清"表读不到 / 退回配置"');
      assert.deepEqual(entry.fallback, configuredFallback(), '日志要如实带上"退回了哪几条"');
    });
  } finally { console.warn = original; }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A2A-3d 表在、但**读出来是空的** ⇒ 同样大声 warn + 退回配置
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A2A-3d 🔴 表读出来是**空的** ⇒ 也按"读不到"处理（warn + 退回配置，绝不给一张空下拉）', async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (line) => { warns.push(String(line)); };
  try {
    await withServer(tableGateway([]), async (base) => {
      const html = await getMoneyPage(base);
      assert.ok(html.includes('<option value="微信" selected>微信</option>'), '空表也必须退回配置（不留白）');
      const entry = warns.map((line) => JSON.parse(line))
        .find((item) => item.event === 'scan.sale.payment_methods_unreadable');
      assert.ok(entry, '空表同样要大声 warn（不许静默 ✓）');
      assert.equal(entry.reason, 'payment_methods_empty');
    });
  } finally { console.warn = original; }
});
