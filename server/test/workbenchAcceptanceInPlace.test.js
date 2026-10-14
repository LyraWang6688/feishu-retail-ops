'use strict';

/**
 * ⭐⭐ 2026-10-14「验收改造进工作台」的验收标准（口径 (a) · **先写先红**）。
 *
 * 口径真源：`docs/acceptance-into-workbench-2026-10-14.md`
 *   她的原话（逐字）：「**连它一起改造进工作台（变成工作台自己的页面）**」
 *   ⭐ **诚实分界**：能搬进工作台的是「**录入 + 确认到货 + 入库**」那一半 ✓；
 *      「**扫码**」那一步**物理上仍在扫码页**（标签二维码印的就是 `/s/{编号}` ✗ 不换标签绕不开）
 *      ⇒ `/s/accept` **保留、仍能用，不许删** ✓，只是**工作台不再从它进** ✓
 *
 * ⚠️ 改动前：`features/orders/index.js` 的批次卡上有一颗
 *    `<a data-action="scan-arrival" href="/s/accept?batch=…">扫码验收</a>` ⇒ **跳扫码页** ✗
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const FEATURE = read('public/workbench/features/orders/index.js');
const ORDERS_CONFIG = read('public/workbench/config/orders.js');
const CONFIG_SRC = read('public/workbench/config/orders.js') + read('public/workbench/config/domains.js');
const CSS = read('public/workbench/features/orders/orders.css');

const CJK = /[\u4e00-\u9fff]/;

test('AC-AW1 🔴 工作台「验收」页**不再有**指向 `/s/accept` 的入口（那颗按钮已退场）', () => {
  const block = FEATURE.slice(FEATURE.indexOf('const purchaseBatchCardHtml'), FEATURE.indexOf('const purchaseBatchCardHtml') + 2000);
  assert.ok(block.length > 0, '拿得到批次卡那一段 ✓');
  // ⚠️ 只判**代码**（我的说明注释里当然会写清"为什么退场"，那是给人看的 ✓ 不算入口 ✗）
  const code = FEATURE.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/\/s\/accept/.test(code), false,
    '工作台订单那支的**代码**里不许再出现 `/s/accept`（原来那颗【扫码验收】就是它 ✗）');
  assert.equal(/ARRIVAL_SCAN/.test(code), false, '也不许再用 `ARRIVAL_SCAN` 当入口 ✗');
});

test('AC-AW1b ⭐ 那一屏**有**提交到既有 confirm 接口的表单（判据不许松 ✗）', () => {
  // ① 提交目标 = **既有** `ORDERS_API.arrivalConfirm`（工作台自己不新开接口 ✓）
  assert.ok(FEATURE.includes('ORDERS_API.arrivalConfirm'), '卡片上的提交走既有 confirm 接口 ✓');
  assert.equal(ORDERS_CONFIG.includes("arrivalConfirm: '/api/workbench/purchase/arrivals/confirm'"), true,
    '接口路径只在这里写一次 ✓');
  // ② 工作台内那张表单三件套（实际金额 / 验收原话 / 提交按钮）都在
  for (const needle of ['data-action="verify-arrival"', 'data-field="arrival-amount"', 'data-field="arrival-note"', 'data-action="submit-arrival"']) {
    assert.ok(FEATURE.includes(needle), `卡上缺 ${needle}（工作台内的确认路径 ✓）`);
  }
  // ③ 明细（只读）也在：批次号 + 每行货号/尺码/数量
  assert.ok(/data-purchase-batch=/.test(FEATURE) && /order-line/.test(FEATURE), '明细那一块还在 ✓');
});

test('AC-AW4 🔴 `/s/accept` **保留、仍能用**（不许删 ✗ —— 扫码那半还在它那儿）', () => {
  assert.ok(ORDERS_CONFIG.includes("pagePath: '/s/accept'"), '`ARRIVAL_SCAN` 常量保留 ✓（只是不再是工作台入口）');
  const route = read('src/routes/scanPage.js');
  assert.ok(/accept/.test(route), '扫码页那条验收路由仍在 ✓');
  const renderer = read('src/views/scanPageRenderer.js');
  assert.ok(/renderAcceptancePage/.test(renderer), '扫码页那张落地页仍在 ✓');
});

test('AC-AW5 ⭐ 命中区 ≥44px · 文案走配置（工作台侧不写死中文 ✗）', () => {
  // ⚠️ 工作台的 `.btn` 最小高度定义可能在 shared/base 那份样式里（本支 css 只覆盖颜色）⇒ 两份一起判
  const shared = fs.readdirSync(path.join(ROOT, 'public/workbench/features/shared'))
    .filter((name) => name.endsWith('.css'))
    .map((name) => read('public/workbench/features/shared', name)).join('\n');
  const all = `${CSS}\n${shared}`;
  assert.ok(/min-height:\s*var\(--control-height\)/.test(all),
    '可点元素 ≥44px（`--control-height` = 44px ✓）');
  const block = FEATURE.slice(FEATURE.indexOf('const purchaseBatchCardHtml'), FEATURE.indexOf('const purchaseBatchCardHtml') + 2000);
  // ⚠️ 卡片模板里**本来是**有一处既有中文字面量（`row.product_number || '未填货号'`，见 `purchaseBatchCardHtml`）
  //    —— 那是**既有债**，本刀**不碰**（不扩大改动面 ✗）。本刀只要求：**按钮文案全部走 config** ✓
  assert.ok(/T\.verifyArrival/.test(block), '【验收到货】文案走 `T.verifyArrival`（config ✓）');
  // ⭐ 本刀新增的只是一段**注释**（不引入任何用户可见文字 ✓）
  //   ⇒ 把注释整段剥掉后，模板里剩下的中文字面量**只该是那一处既有债**（`未填货号`）✓
  const stripped = block.replace(/<!--[\s\S]*?-->/g, '');
  const literals = stripped.match(/[\u4e00-\u9fff]+/g) || [];
  assert.deepEqual(literals, ['未填货号'],
    `除既有那一处外不许再有中文字面量（实际 ${literals.join(' / ')}）—— 新文案一律走 config ✓`);
});

test('AC-AW7 ⭐ 既有断言：没有"工作台点验收会跳扫码页"的哨兵被放宽（也没有被删/跳过）', () => {
  const SELF = 'workbenchAcceptanceInPlace.test.js';
  const files = fs.readdirSync(__dirname)
    .filter((name) => /^workbench.*\.test\.js$/.test(name) && name !== SELF);
  const hits = [];
  for (const name of files) {
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
    if (/scan-arrival|\/s\/accept/.test(src)) hits.push(name);
  }
  assert.deepEqual(hits, [],
    `工作台那批用例里不该再有"跳扫码页"的断言（实际 ${hits.join(',')}）—— 若确实有，请**改指向 + 写她原话依据**，不许删/跳过 ✗`);
});

test('AC-AW8/9 回归：`confirmArrival` 语义与入库路径**一字不动**', () => {
  const route = read('src/routes/workbench.js');
  assert.match(route, /router\.post\('\/purchase\/arrivals\/confirm'/, '确认到货接口仍在 ✓');
  assert.match(route, /confirmArrival\(\{[\s\S]{0,200}?batchNo[\s\S]{0,200}?actualAmount[\s\S]{0,200}?acceptanceText/,
    '整批一键 + 实际金额 + 验收原话 的入参形状未变 ✓');
  // 工作台侧**不许直连表**：那一支里不该出现任何 bitable/网关写调用
  const slice = route.slice(route.indexOf("router.post('/purchase/arrivals/confirm'"), route.indexOf("router.post('/purchase/arrivals/confirm'") + 800);
  assert.equal(/gateway|bitable|v1BitableGateway/.test(slice), false, '工作台路由不许直连表（入库只走 InventoryService ✓）');
});
