'use strict';

/**
 * ⭐⭐ ⑨b-1 UI（**服务端那一半**）：订单列表行的「**没写完**」判据（`write_incomplete`）。
 *
 * 依据（她逐字）：「失败落「**写入失败**」、工作台显示「**未完成，可点重试**」」
 *   ⇒ 列表那一行要带**能不能点重试**的判据；判据**必须**用已合并的那一份（`isOrderIncomplete`），
 *     **不另发明** ✗、**不额外读表** ✗（只从已经读到的那条记录里取）。
 *
 * ⚠️ 这里测的是 `services/salesFollowupService` 导出的**纯函数** `writeFlagsOf(order, fields)`
 *   —— 不起网关、不起缓存，直接把"三个维度 → 没写完"的映射钉住 ✓
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_retry_ui_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'retry_ui_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { writeFlagsOf } = require('../src/services/salesFollowupService');
const {
  SALES_STATUS_WRITE_VALUES: W, SALES_STATUS_FIELDS,
} = require('../src/config/salesStatusDimensions');

const SERVER_SRC = path.join(__dirname, '..', 'src');
// 真表那一列的字段名（服务端给的映射就是这一份 ⇒ 用例照它走 ✓ 不猜 ✗）
const FIELDS = { writeStatus: SALES_STATUS_FIELDS.writeStatus };
const rowOf = ({ writeStatus = '' } = {}) => ({
  fields: writeStatus ? { [FIELDS.writeStatus]: writeStatus } : {},
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ASU1 三条维度 → 「没写完」的映射
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ASU1 ⭐ 只有**没写完**的单才是 `write_incomplete: true`（已写完 ⇒ false）', () => {
  // ⭐ 2026-10-18：四维已合并成「写入状态」；未完成/部分失败/失败都算没写完。
  assert.equal(writeFlagsOf(rowOf({ writeStatus: '成功' }), FIELDS).write_incomplete, false,
    '成功 ⇒ 不显示「可点重试」✓');
  for (const status of ['未完成', '部分失败', '失败']) {
    assert.equal(writeFlagsOf(rowOf({ writeStatus: status }), FIELDS).write_incomplete, true,
      `写入状态「${status}」⇒ 未完成 ✓`);
  }
  // 读不到（老单 / 列还没写）⇒ 不猜：不是未完成（但也不会乱发按钮）
  const blank = writeFlagsOf(rowOf({}), FIELDS);
  assert.equal(blank.write_incomplete, false, '读不到就不说"未完成"（不猜 ✗）');
  assert.deepEqual([blank.salesStatus, blank.stockStatus, blank.fundsStatus], ['', '', ''],
    '读不到就给空串（不编 ✗）');
});

test('AC-ASU2 ⭐ 判据用**已合并的** `isOrderIncomplete`（不另写一套 ✗）；状态字面量不许散写', () => {
  const source = fs.readFileSync(path.join(SERVER_SRC, 'services', 'salesFollowupService.js'), 'utf8');
  assert.ok(source.includes("require('./v1WorkbenchService')"),
    '要复用 `services/v1WorkbenchService` 那一份判据 ✓');
  assert.match(source, /isOrderIncomplete\(\{ salesStatus, stockStatus, fundsStatus/,
    '必须直接把三个维度交给那一份判据 ✓');
  assert.equal(/===\s*'已写入'|===\s*'写入失败'|===\s*'未写入'/.test(source), false,
    '不许在 service 里散写状态字面量 ✗（值域只有 `config/salesStatusDimensions` 一份真源）');
});

test('AC-ASU3 ⭐ 零额外读表：只从**已经读到**的那条记录取（`order.fields`）', () => {
  const source = fs.readFileSync(path.join(SERVER_SRC, 'services', 'salesFollowupService.js'), 'utf8');
  const start = source.indexOf('const writeFlagsOf = ');
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  for (const forbidden of ['gateway', 'listAll', 'findOneBy', 'await ']) {
    assert.equal(body.includes(forbidden), false,
      `writeFlagsOf 里不许出现「${forbidden}」（纯映射，不读表 ✗）`);
  }
  assert.ok(body.includes('order') && body.includes('fields'), '只从已经读到的那条记录里取 ✓');
  // 列表那一行**确实**带上了它（否则前端拿不到判据 ✗）
  assert.match(source, /\.\.\.writeFlagsOf\(order, orderFields\)/,
    '建行时要把三维度 + `write_incomplete` 摊进去 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ASU4 / AC-ASU5 ⭐ 工作台列表：**只有没写完的单**才出那一句 + 那颗按钮
// ═══════════════════════════════════════════════════════════════════════════

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');

/** 前端模块真跑起来（与 `orderThreeStates2026_10_11.test.js` 同一套做法）。 */
const loadOrdersModule = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-ui-'));
  const copy = (from, to, replacements = []) => {
    let source = fs.readFileSync(path.join(WORKBENCH, from), 'utf8');
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  return import(pathToFileURL(path.join(dir, 'orders-index.mjs')).href);
};

const ROW = (extra = {}) => ({
  record_id: 'rec_1',
  order_no: 'XSD-20261015-0001',
  fulfillment_status: '部分交付',
  receivable_amount: 100,
  paid_amount: 0,
  pending_amount: 100,
  pending_delivery_quantity: 1,
  details: [{
    record_id: 'd1', product: 'A', color: '黑', size: 40, actual_amount: 100, fulfillment_status: '待交付',
  }],
  ...extra,
});

test('AC-ASU4 ⭐ 只有 `write_incomplete: true` 的那一行才有「未完成，可点重试」+ 那颗按钮', async () => {
  const mod = await loadOrdersModule();

  const bad = mod.ordersListHtml([ROW({ write_incomplete: true })]);
  assert.ok(bad.includes('未完成，可点重试'), '没写完的单要看到**她逐字**那一句 ✓');
  assert.ok(bad.includes('data-action="retry-write"'), '还要有一颗能点的按钮 ✓');
  assert.ok(bad.includes('data-view="order-incomplete"'), '那一句要有可断言的锚点 ✓');
  // 老单那一行还在（列表其余部分不受影响 ✓）
  assert.ok(bad.includes('XSD-20261015-0001'), '单号照旧显示 ✓');
  assert.ok(bad.includes('data-action="open-order"'), '"查看 / 操作"那颗按钮不受影响 ✓');

  const good = mod.ordersListHtml([ROW({ write_incomplete: false })]);
  assert.equal(good.includes('未完成，可点重试'), false, '写完了**不许**显示"可点重试" ✗');
  assert.equal(good.includes('retry-write'), false, '写完了**不该**有那颗按钮 ✗');

  // 判据缺失（老单 / 那一列还没写）⇒ **不猜**：既不显示那句话、也不发按钮
  const unknown = mod.ordersListHtml([ROW()]);
  assert.equal(unknown.includes('未完成，可点重试'), false, '判据缺失 ⇒ 不显示（不猜 ✗）');
  assert.equal(unknown.includes('retry-write'), false, '判据缺失 ⇒ 不发按钮（不猜 ✗）');
});

test('AC-ASU5 ⭐ 那句话与她逐字一致 · 路由只有一处来源 · 页面里不写死 URL', () => {
  const config = fs.readFileSync(path.join(WORKBENCH, 'config', 'orders.js'), 'utf8');
  assert.match(config, /incomplete: '未完成，可点重试'/, '那句话必须与她逐字一致 ✓');
  assert.match(config, /retry: '\/api\/workbench\/sales\/retry'/, '路由在配置里（唯一来源 ✓）');

  const source = fs.readFileSync(path.join(WORKBENCH, 'features', 'orders', 'index.js'), 'utf8');
  assert.ok(source.includes('ORDERS_API.retry'), '页面用配置里那条路由 ✓');
  assert.equal(/['"]\/api\/workbench\/sales\/[a-z-]*['"]/.test(source), false,
    '页面里**不许写死** `/api/workbench/sales/*` 的 URL ✗');
  // 🔴 幂等不许拆：页面只发一个 HTTP 请求，**绝不直调 `_confirm`** ✗
  // ⚠️ 判据是"**有没有真的调它**"，不是"字面上出现过这个词" —— 注释里当然可以提它 ✓
  //    （同形状的坑本项目踩过三次：拿 `background` 当判据命中 CSS、拿 `_confirm` 当判据命中注释）
  assert.equal(/\b_confirm\s*\(/.test(source), false, '页面里**不许真的调** `_confirm` ✗');
});
