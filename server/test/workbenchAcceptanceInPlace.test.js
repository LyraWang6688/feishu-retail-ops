'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ 2026-10-14「验收改造进工作台」的验收标准（口径 (a) · **先写先红**）。
 *
 * 口径真源：`docs/acceptance-into-workbench-2026-10-14.md`
 *   她的原话（逐字）：「**连它一起改造进工作台（变成工作台自己的页面）**」
 *   ⭐ **诚实分界**：能搬进工作台的是「**录入 + 确认到货 + 入库**」那一半 ✓；
 *      「**扫码**」那一步**物理上仍在扫码页**（标签二维码印的就是 `/r/{编号}` ✗ 不换标签绕不开）
 *      ⇒ `/r/accept` **保留、仍能用，不许删** ✓，只是**工作台不再从它进** ✓
 *
 * ⚠️ 改动前：`features/orders/index.js` 的批次卡上有一颗
 *    `<a data-action="scan-arrival" href="/r/accept?batch=…">扫码验收</a>` ⇒ **跳扫码页** ✗
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

test('AC-AW1 🔴 工作台「验收」页**不再有**指向 `/r/accept` 的入口（那颗按钮已退场）', () => {
  const block = FEATURE.slice(FEATURE.indexOf('const purchaseBatchCardHtml'), FEATURE.indexOf('const purchaseBatchCardHtml') + 2000);
  assert.ok(block.length > 0, '拿得到批次卡那一段 ✓');
  // ⚠️ 只判**代码**（我的说明注释里当然会写清"为什么退场"，那是给人看的 ✓ 不算入口 ✗）
  const code = FEATURE.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/\/s\/accept/.test(code), false,
    '工作台订单那支的**代码**里不许再出现 `/r/accept`（原来那颗【扫码验收】就是它 ✗）');
  assert.equal(/ARRIVAL_SCAN/.test(code), false, '也不许再用 `ARRIVAL_SCAN` 当入口 ✗');
});

test('AC-AW1b ⭐ 那一屏**有**提交到既有 confirm 接口的表单（判据不许松 ✗）', () => {
  // ① 提交目标 = **既有** `ORDERS_API.arrivalConfirm`（工作台自己不新开接口 ✓）
  assert.ok(FEATURE.includes('ORDERS_API.arrivalConfirm'), '卡片上的提交走既有 confirm 接口 ✓');
  assert.equal(ORDERS_CONFIG.includes("arrivalConfirm: '/api/workbench/purchase/arrivals/confirm'"), true,
    '接口路径只在这里写一次 ✓');
  // ② 工作台内那张表单三件套（发生金额 / 验收原话 / 提交按钮）都在
  // ⭐⭐ 2026-10-16（她逐字：「到货说明必须得删……数据表里面已经没有验收原话了……你必须得删」）
  //   · 改前逐字：needle 列表里有 `'data-field="arrival-note"',`
  //   · 改后逐字：该项删除 ＋ 下面那条**反向**断言（塞回即红 ✓）
  //   · 依据 = 她 2026-10-16 逐字（同上）✓
  for (const needle of ['data-action="verify-arrival"', 'data-field="arrival-amount"', 'data-action="submit-arrival"']) {
    assert.ok(FEATURE.includes(needle), `卡上缺 ${needle}（工作台内的确认路径 ✓）`);
  }
  assert.equal(FEATURE.includes('data-field="arrival-note"'), false, '⛔「到货说明」输入框不许再回来 ✗');
  // ③ 明细（只读）也在：批次号 + 每行货号/尺码/数量
  assert.ok(/data-purchase-batch=/.test(FEATURE) && /order-line/.test(FEATURE), '明细那一块还在 ✓');
});

test('AC-AW4 🔴 `/r/accept` 那条路**已彻底拆掉**（本 AC 换判据 —— 旧口径被她晚间的原话覆盖）', () => {
  // ⭐⭐ 2026-10-14 晚 **改指向**（依据：业务负责人逐字「**`/r/accept` 这条路要彻底拆掉**」）
  //   改前逐字：`assert.ok(ORDERS_CONFIG.includes("pagePath: '/r/accept'"), '`ARRIVAL_SCAN` 常量保留 ✓（只是不再是工作台入口）')`
  //             ＋ `assert.ok(/accept/.test(route), '扫码页那条验收路由仍在 ✓')`
  //             ＋ `assert.ok(/renderAcceptancePage/.test(renderer), '扫码页那张落地页仍在 ✓')`  ← **旧口径"不许删"** ✗
  //   改后：**扫码页那边必须没有**（路由不再注册 `/accept`；三个渲染函数一个都不在 ✓）
  //    ⚠️ 工作台那屏**照旧**（能力搬进工作台 ✓ 由本文件 AC-AW1/AW1b 罩着 ✓）
  const route = read('src/routes/scanPage.js');
  assert.equal(/router\.(get|post|all)\('\/accept'/.test(route), false, '扫码页那条验收路由必须已退场 ✗');
  const renderer = rendererSource();
  assert.equal(/renderAcceptance(Page|DonePage|SelfServe)/.test(renderer), false, '三个验收渲染函数必须已退场 ✗');
  assert.equal(/data-view="acceptance"/.test(renderer), false, '验收块也一并退场 ✗');
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
  // ⚠️ 卡片模板里**本来是**有一处既有中文字面量（`row.product_number || '未填货号'`）
  //    —— 那是**既有债**。
  assert.ok(/T\.verifyArrival/.test(block), '【验收到货】文案走 `T.verifyArrival`（config ✓）');
  const stripped = block.replace(/<!--[\s\S]*?-->/g, '');
  const literals = stripped.match(/[\u4e00-\u9fff]+/g) || [];
  // ⭐⭐ 2026-10-15（task-27）**逐字记录，判据只紧不松** ✓：
  //   改前逐字：`assert.deepEqual(literals, ['未填货号'], ...)`
  //   改后逐字：`assert.deepEqual(literals, [], ...)`
  //   依据：那处既有债（`未填货号`）**唯一的使用者**是"第一屏把明细铺开"那张列表；
  //     她 2026-10-15 逐字「验收页展示应该是采购主表里未到货的**批次号**，然后**用户点击之后**
  //     才是对应的采购明细情况」⇒ 那张列表（连同 `未填货号`）**整块撤出第一屏** ✓
  //     ⇒ 卡片模板里现在**一个中文字面量都没有**（比原来**更严** —— 原来允许债，现在零容忍 ✓）。
  assert.deepEqual(literals, [],
    `卡片模板里不许有中文字面量（新文案一律走 config，实际 ${literals.join(' / ')}）✓`);
});

test('AC-AW7 ⭐ 既有断言：没有"工作台点验收会跳扫码页"的哨兵被放宽（也没有被删/跳过）', () => {
  const SELF = 'workbenchAcceptanceInPlace.test.js';
  const files = fs.readdirSync(__dirname)
    .filter((name) => /^workbench.*\.test\.js$/.test(name) && name !== SELF);
  const hits = [];
  for (const name of files) {
    // ⚠️ **先剥注释**（改指向，判据没放宽 ✗）：注释里写清"已退场 + 依据"是**必须**的 ✓
    //    只有**活引用**（代码里真去跳 `/r/accept`）才算命中 ✓
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
      .replace(/\/\/[^\n]*/g, '');
    if (/scan-arrival|\/s\/accept/.test(src)) hits.push(name);
  }
  assert.deepEqual(hits, [],
    `工作台那批用例里不该再有"跳扫码页"的断言（实际 ${hits.join(',')}）—— 若确实有，请**改指向 + 写她原话依据**，不许删/跳过 ✗`);
});

test('AC-AW8/9 回归：`confirmArrival` 语义与入库路径**一字不动**', () => {
  const route = read('src/routes/workbench.js');
  assert.match(route, /router\.post\('\/purchase\/arrivals\/confirm'/, '确认到货接口仍在 ✓');
  // ⭐⭐ 2026-10-16（她逐字「到货说明必须得删……数据表里已经没有验收原话了」）
  //   · 改前逐字：`/confirmArrival\(\{[\s\S]{0,200}?batchNo[\s\S]{0,200}?actualAmount[\s\S]{0,200}?acceptanceText/`（含"验收原话"）
  //   · 改后逐字：去掉尾部那段 ⇒ 只钉 `batchNo` + `actualAmount`（＋下面反向断言"不许再传原话"）
  //   · 依据 = 她 2026-10-16 逐字 ✓
  assert.match(route, /confirmArrival\(\{[\s\S]{0,200}?batchNo[\s\S]{0,200}?actualAmount/,
    '整批一键 + 发生金额 的入参形状未变 ✓（"验收原话"已按她那句退场 ✓）');
  assert.equal(/confirmArrival\(\{[\s\S]{0,300}?acceptanceText/.test(route), false,
    '⛔ 不许再把「到货说明」传给 confirmArrival ✗');
  // 工作台侧**不许直连表**：那一支里不该出现任何 bitable/网关写调用
  const slice = route.slice(route.indexOf("router.post('/purchase/arrivals/confirm'"), route.indexOf("router.post('/purchase/arrivals/confirm'") + 800);
  assert.equal(/gateway|bitable|v1BitableGateway/.test(slice), false, '工作台路由不许直连表（入库只走 InventoryService ✓）');
});
