'use strict';

/**
 * ⭐⭐ 2026-10-15（task-48 b 的最后一跳 · Lead 放行）
 *
 * 判据：**一次点击的 `tap_id` 必须能在【写库日志】里 grep 到同一个 id** ——
 *   前端点击 → 请求（body 里带 `tap_id`）→ 写库日志（`bitable.record.*` / `v1.sale.posted` / …）✓
 * 三个入口各一条判据（少接一处就红 ✓）；**取不到 `tap_id` ⇒ 字段压根不出现**（**绝不编** ✗）。
 *
 * 🔴 不放宽：白名单仍逐字（`test/logCorrelation.test.js` 那条一个字节没动 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// 夹具：路由模块加载时会现场建一个网关 ⇒ 先给假凭证（既有用例同一套做法 ✓）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_tap_wire';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'tap_wire_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_token_tap_wire';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'tap_wire_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { createWorkbenchRouter } = require('../src/routes/workbench');
const { tapIdFromRequest } = require('../src/utils/correlationFields');

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const captureLogs = () => {
  const lines = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { lines.push(String(chunk)); return real(chunk, ...rest); };
  return { lines, restore: () => { process.stdout.write = real; } };
};

const appFor = ({ followup = {}, gateway = {} } = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', (req, res, next) => { req.workbenchUser = { open_id: 'ou_tap' }; next(); },
    createWorkbenchRouter({ gateway, followup, ordersCache: { invalidate: () => {} } }));
  return app;
};

test('AC-TAP2 ⭐ 售后入口带 `tap_id`（二次交付入口已随旧订单列表退场，不再要求）', () => {
  const actions = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/routes/workbenchOrderActions.js'), 'utf8');
  assert.match(actions, /afterSales\([\s\S]{0,400}?correlation: tapIdFromRequest\(req\)/, '售后入口要带 tap_id ✓');
});

test('AC-TAP3 ⭐⭐ 贯穿：同一个 `tap_id` 出现在【写库日志】里（能与 `ui.tap` 串起来）', async () => {
  const { PaymentService } = require('../src/services/paymentService');
  const { mergeCorrelation } = require('../src/utils/correlationFields');
  // 假网关：真的走 `utils/logger` 那条结构化日志（`bitable.record.created`）—— 这正是"写库那半" ✓
  const writes = [];
  const gateway = {
    // `PaymentService` 要按 schema 解析列名 ⇒ 给一个最小的 `table()` 替身 ✓
    table: (key) => ({ fields: { salesEntry: '销售单号', method: '收款方式', amount: '收款金额',
      status: '收款状态', receivedAt: '收款日', tradeDirection: '交易方向', receiptId: '收款明细ID' } , key }),
    // `PaymentService.record` 会先读一次销售主表（拿单号/状态）⇒ 给个最小替身 ✓
    get: async () => ({ record_id: 'rec_entry_1', fields: { 销售单号: 'XSD-20261016-0001' } }),
    listByFilter: async () => [],
    listAll: async () => [],
    create: async (table, fields, options) => {
      const { logInfo } = require('../src/utils/logger');
      logInfo('bitable.record.created', {
        table_key: table, record_id: 'rec_payment_1', ...(options?.correlation || {}),
      });
      writes.push({ table, fields, options });
      return { record_id: 'rec_payment_1' };
    },
  };
  const payment = new PaymentService({ gateway, references: { resolvePaymentMethod: async () => true } });

  // ① 模拟"她点了一下"那条 beacon 日志（既有实现打的，客户端把同一个 id 带回来）
  const { logInfo } = require('../src/utils/logger');
  const captured = captureLogs();
  logInfo('ui.tap', { target: 'workbench:orders:pay', tap_id: 'tap-pay-9', page: 'workbench' });
  // ② 请求体里带回来的同一个 id ⇒ 取出来（**取不到就 `{}`**，绝不编）
  const fromRequest = tapIdFromRequest({ body: { tap_id: 'tap-pay-9' } });
  assert.deepEqual(fromRequest, { tap_id: 'tap-pay-9' }, '从 body 取到 ✓');
  // ③ 写库那一半：同一个 id 必须出现在 `bitable.record.created` 里
  await payment.record({ salesEntryRecordId: 'rec_1', method: '微信', amount: 100, operatorOpenId: 'ou_tap' },
    { correlation: mergeCorrelation(fromRequest) });
  captured.restore();

  const joined = captured.lines.join('');
  assert.match(joined, /"event":"ui\.tap"[^\n]*"tap_id":"tap-pay-9"/, '① 点击那半有 tap_id ✓');
  assert.match(joined, /"event":"bitable\.record\.created"[^\n]*"tap_id":"tap-pay-9"/,
    '⭐ ② 写库那半也有**同一个** tap_id ⇒ 一次点击 → 一次写入 串起来了 ✓（去掉接线 ⇒ 红）');
  assert.equal(writes.length, 1, '确实写了一次 ✓');
  console.log('SAMPLE_UI_TAP=' + captured.lines.join('').split('\n').find((l) => l.includes('"ui.tap"')));
  console.log('SAMPLE_WRITE=' + captured.lines.join('').split('\n').find((l) => l.includes('bitable.record.created')));

  // ④ 取不到 ⇒ **不编**：字段压根不出现 ✓
  const captured2 = captureLogs();
  await payment.record({ salesEntryRecordId: 'rec_2', method: '微信', amount: 1, operatorOpenId: 'ou_tap' },
    { correlation: mergeCorrelation(tapIdFromRequest({ body: {} })) });
  captured2.restore();
  const line = captured2.lines.join('').split('\n').find((l) => l.includes('bitable.record.created')) || '';
  assert.equal(line.includes('tap_id'), false, '⛔ 没有 tap_id 时**不许编一个**（字段不出现 ✓）');
});
