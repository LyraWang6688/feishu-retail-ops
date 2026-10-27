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
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
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

// ⭐⭐ 2026-10-16（task-60）**成对迁移**（本仓纪律：**不许删 / 不许 skip / 不许放宽** ⇒ 逐条写清）——
//   依据 = **业务负责人当日亲口选的方案 ②**（逐字）：
//     「**② 还是重扫同一个货品就从头开始（清掉那条未完成 ✓）**」
//   · **改前逐字**：`${base}/r/${encodeURIComponent(NUMBER)}?from=sales`
//     （`?from=sales` ＋ 会话 `paymentStep:'pending'` ⇒ 命中"刷新仍给资金页"那条接管 ⇒ 资金页 ✓）
//   · **改后逐字**：`${base}/r/${encodeURIComponent(NUMBER)}`（**裸 URL**，不带 `?from=`）
//   · **依据**：她 2026-10-16 选 ② ⇒ **点「销售」那一发（`?from=sales`）**按 ② **先清掉那条未完成标记**
//     ⇒ 从**货品页**开始（正面判据在 `test/scanLandingResetOnScan.test.js` 的 **AC-LR1** ✓）。
//     ⚠️ 而**资金页自己那张表单的 POST 目标就是裸 URL**（`postActionFor(target, 'sales')`；
//     `?from=` 只在**非缺省领域**才带）⇒ **"刷新仍给资金页"那条既有体验走的是【裸扫】**：
//     `test/scanSalePayFront.test.js` 的 AC-PF4 ＋ `test/scanPaymentStepStale.test.js` 的
//     AC-SM2/SM3/SM7/SM8 **原样未动** ✓。
//   🔴 **本文件那三条断言一个字没动** ✗ —— 只是把"怎么走到资金页"换成**真实那条路**（裸 URL）：
//     本文件主题是"**候选收款方式读表**"，与"从哪个 URL 进来"无关 ✓
//     （改前靠 `?from=sales` 进来，只是因为当时那条接管也认 `?from=sales`；那条 URL 现在按她选的 ② 另有含义 ✓）。
const getMoneyPage = async (base) => (await fetch(
  `${base}/r/${encodeURIComponent(NUMBER)}`, { headers: { cookie: COOKIE } },
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

test('AC-A2A-3a ⭐ 候选收款方式 = 读「收款方式管理」表：表里那几条都点得到（默认取表里第一项）', async () => {
  const calls = [];
  const gateway = tableGateway(['支付宝', '抖音代金券（89.9）'], calls);
  await withServer(gateway, async (base) => {
    const html = await getMoneyPage(base);
    assert.ok(html.includes('data-view="payment-step"'), '这一趟渲染的是**资金页**（收款行那一列在它上面）');
    for (const name of ['支付宝', '抖音代金券（89.9）']) {
      assert.ok(html.includes(`<option value="${name}"`), `表里的「${name}」必须可选（她点名要过团购券）`);
    }
    // ⭐ 2026-10-18：表是唯一真源。表里没有「微信」（已改名「微信扫码」）⇒ 不再硬塞微信；
    //   默认 = 表里第一项（此 fixture = 支付宝），且下拉里**不许**出现表里没有的选项。
    assert.ok(html.includes('<option value="支付宝" selected>支付宝</option>'),
      '第一行默认选中表里第一项（表里没有微信 ⇒ 不再硬编码微信）');
    assert.equal(html.includes('<option value="微信"'), false,
      '表里没有「微信」⇒ 不许凭空插入');
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

test('AC-A2A-3b 🔴 表读不到 ⇒ 大声 warn，且**不再给配置假选项**（2026-10-26 成对迁移）', async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (line) => { warns.push(String(line)); };
  try {
    const gateway = { async listAll() { throw new Error('bitable 503'); } };
    await withServer(gateway, async (base) => {
      const html = await getMoneyPage(base);
      assert.ok(html.includes('data-view="payment-step"'), '读不到表**不许破她的页面**（照旧出资金页 ✓）');
      // 🔴 改后逐字：不再渲染配置里的「微信/现金/支付宝/银行卡」——
      //    页面显示的值必须与写库校验用同一份表快照；没有快照就不给假选项。
      for (const name of configuredFallback()) {
        assert.ok(!html.includes(`<option value="${name}"`), `读不到表不许给假选项「${name}」`);
      }
      const entries = warns.map((line) => JSON.parse(line));
      const entry = entries.find((item) => item.event === 'scan.sale.payment_methods_unreadable');
      assert.ok(entry, `读不到表必须**大声**warn（实际 warns=${JSON.stringify(warns)}）`);
      assert.equal(entry.reason, 'payment_methods_unreadable');
      assert.match(String(entry.message || ''), /不提供假选项/);
      assert.deepEqual(entry.fallback, configuredFallback(), '日志仍如实带上"原本的配置退路"便于排查');
    });
  } finally { console.warn = original; }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A2A-3d 表在、但**读出来是空的** ⇒ 同样大声 warn + 退回配置
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A2A-3d 🔴 表读出来是**空的** ⇒ 大声 warn，且不再给配置假选项（2026-10-26 成对迁移）', async () => {
  const warns = [];
  const original = console.warn;
  console.warn = (line) => { warns.push(String(line)); };
  try {
    await withServer(tableGateway([]), async (base) => {
      const html = await getMoneyPage(base);
      for (const name of configuredFallback()) {
        assert.ok(!html.includes(`<option value="${name}"`), `空表不许给假选项「${name}」`);
      }
      const entry = warns.map((line) => JSON.parse(line))
        .find((item) => item.event === 'scan.sale.payment_methods_unreadable');
      assert.ok(entry, '空表同样要大声 warn（不许静默 ✓）');
      assert.equal(entry.reason, 'payment_methods_empty');
    });
  } finally { console.warn = original; }
});
