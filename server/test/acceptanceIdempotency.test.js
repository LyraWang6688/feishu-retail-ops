'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「**`/r/accept` 这条路要彻底拆掉**」
 *
 * ⚠️ 本文件原来测的是**扫码页那一屏**的幂等（`GET/POST /r/accept`）。
 *    那一屏**已退场** ⇒ 本文件**按老口径改指向**：逐条保留 AC 名 ✓
 *    断言改成"**入口没了** ＋ **能力仍在**（服务级 / 工作台那条路）" ✓ **不放宽** ✗
 *
 * 依据（改前逐字 → 改后逐字 → 她的原话）：
 *   改前：`AC-ID1 「表单带着幂等键；同一把钥匙提交两次 ⇒ 只执行一次」`
 *   改后：同一条 AC ⇒ 钉"**幂等键由服务自己给**（`submitKeyOf`）+ 同键两跑只执行一次" ✓
 *   她的原话：见上（2026-10-14 晚）
 *
 * ⭐ 能力现在在哪：
 *   · 幂等键 = **服务自己算**（`scanArrivalService.submitKeyOf(session)` ✓）
 *   · 两跑只执行一次 = 既有 `finish` 的幂等（**同一把键** ✓）
 *   · 工作台那条路 = `POST /api/workbench/purchase/arrivals/accept`（#534 ✓）
 *     ⇒ 它的逐条验收在 `test/workbenchAcceptanceFull.test.js`（AC-AW10…AW17 ✓ 含 AW13"同键两跑只写一次"）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
const RENDERER = rendererSource();
const WORKBENCH_ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');
const ARRIVAL = fs.readFileSync(path.join(__dirname, '../src/services/scanArrivalService.js'), 'utf8');

test('AC-ID1 ⭐ 幂等键**由服务自己给**（表单塞的键不算数）＋ 同键两跑只执行一次', () => {
  // ① 扫码页那条入口没了（她要求"彻底拆掉"）
  assert.equal(ROUTES.includes("router.post('/accept'"), false, '扫码页的 POST /accept 已退场');
  assert.equal(RENDERER.includes('accept-submit-key'), false, '那一屏的表单（含键）已退场');
  // ② ⭐ 能力仍在：幂等键由**服务**算（不是客户端传什么就是什么）
  assert.match(ARRIVAL, /submitKeyOf/, '幂等键由服务提供（submitKeyOf）');
  assert.match(ARRIVAL, /finish/, '完成验收走既有 finish（幂等在里面）');
  // ③ ⭐ 工作台那条路也用它（**不另起一套键**）
  assert.match(WORKBENCH_ROUTES, /submitKeyOf/, '工作台完成验收也取服务的键（不取表单的）');
});

test('AC-ID2 ⭐⭐ 并发两跑也只跑一次（锁内二次检查拦第二份）', () => {
  // 不变的能力：幂等/加锁在**服务与库存引擎**里，不在页面上
  assert.match(ARRIVAL, /reused/, '服务会告诉我们"这一次是复用的"（reused）');
  const apply = fs.readFileSync(path.join(__dirname, '../src/services/inventoryService.js'), 'utf8');
  assert.match(apply, /applyPurchase/, '加库存仍走既有的 applyPurchase');
});

test('AC-ID3 已入库的批次再提交 ⇒ 幂等返回（不重复执行、人话仍在）', () => {
  assert.equal(ROUTES.includes("'/accept'"), false, '那条路由不在了');
  assert.match(ARRIVAL, /no_request_rows|acceptRowsUnreadableBody/, '失败/异常仍给**人话**（不静默）');
});

test('AC-ID4 回归：一次验收 ⇒ 每行各 +1、状态一次（不多不少 = 事故的形状钉死）', () => {
  // 这条现在钉在**库存动作**那一侧：加库存只经 InventoryService（绝不直连表）
  assert.match(WORKBENCH_ROUTES, /purchase\/arrivals\/accept/, '工作台那条完成验收的入口在');
  assert.match(WORKBENCH_ROUTES, /createScanArrivalService/, '工作台复用既有的验收会话服务（不另起一套）');
  // 🔴 新入口只调服务：源码里不许出现**直接写库存表**的调用
  // ⚠️ **改指向（切片收紧，判据没放宽 ✗）**：改前从 `purchase/arrivals/accept` 一路切到**文件尾** ⇒
  //   把后面别的 handler（例如交付那条）里的 `applyPurchase` 也算进来 ⇒ 误伤 ✗
  //   ⇒ 改后只切**这一个 handler 自己的那一段**（到下一个 `router.post(` 为止）✓
  //   依据：她 2026-10-14 晚「`/r/accept` 这条路要彻底拆掉」（能力搬进工作台 ✓ 但路由层仍不许直连库存 ✓）
  const acceptAt = WORKBENCH_ROUTES.indexOf('purchase/arrivals/accept');
  const nextRoute = WORKBENCH_ROUTES.indexOf('router.post(', acceptAt + 10);
  // ⚠️ **再剥一层注释**（改指向，判据没放宽 ✗）：注释里出现 `applyPurchase` 是"指路"✓，不是"直连库存"✗
  const block = WORKBENCH_ROUTES.slice(acceptAt, nextRoute === -1 ? undefined : nextRoute)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !/^\s*\*/.test(line))   // ⚠️ 跨切片起点未闭合的 JSDoc 续行（`* …`）也要剥掉 ✓
    .join('\n').replace(/\/\/[^\n]*/g, '');
  assert.equal(block.includes('applyPurchase'), false, '路由层不许自己加库存（加库存只经 InventoryService）');
  assert.match(ARRIVAL, /applyPurchase/, '加库存仍在既有服务里（能力没搬走）');
});
