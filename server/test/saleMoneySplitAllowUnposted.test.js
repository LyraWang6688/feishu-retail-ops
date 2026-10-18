'use strict';

/**
 * ⭐⭐ task-62【货 / 钱分离】**接线**的源码哨兵（Lead 指定的"其它调用方不变"**唯一硬证据** ✓）。
 *
 * 依据 = 业务负责人 2026-10-16 22:0x 逐字：
 *   「**货就是货，资金就是资金，它俩是独立的呀**：…**如果是现货，就是要扣库存**；如果是预订，就不扣库存，
 *     等二次交付的时候再扣库存」＋「**啥叫钱没入账就不许出库存？不用呀。**」
 *
 * 判据（**先写后做** ✓ 每条能真红 ✓）：
 *   **AC-MS-G1** ⭐ **`allowUnposted: true` 全仓【恰好一处】** ✓（在冻结件 `:1318` 那个三元里 ✓）
 *     ＋ ⭐ **另外 3 个调用点（工作台 / 二次交付 / 销售话题进度）一个都不许有** ✓ ⇒ 谁给它们加了 ⇒ 红 ✓
 *   **AC-MS-G2** ⭐ **两处的缺省都是显式 `false`** ✓（**禁 `||` 兜底** ✗ 源码哨兵 ✓）
 *   **AC-MS-G3** ⭐ **`fundsDeferred !== true` 时**：⭐ 交给 `deliver` 的入参**不含** `allowUnposted: true` ✓
 *     ⇒ 反向哨兵：把 `allowUnposted: fundsDeferred` 换成恒 `true` ⇒ **红** ✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SERVER, ...p), 'utf8');

const FROZEN = read('src', 'services', 'scanWriteService.js');
const DELIVERY = read('src', 'services', 'salesDeliveryService.js');
/** 另外 3 个调用点（**它们一个字都不许改** ✗）。 */
const OTHER_CALLERS = ['src/routes/workbench.js', 'src/services/secondDeliveryService.js', 'src/services/salesThreadProgressService.js'];

test('AC-MS-G1 ⭐⭐ `allowUnposted: true` 全仓**恰好一处**（只在货那一跑 ✓ 别的调用方一个都没有 ✗）', () => {
  const routable = [
    ['src/services/scanWriteService.js', FROZEN],
    ...OTHER_CALLERS.map((f) => [f, read(f)]),
  ];
  // ⭐ 口径：那"开门"动作**只许有一处**，且必须是 `allowUnposted: <跟着 fundsDeferred 走>` ✓
  //    ⚠️ 实现用的是 `allowUnposted: fundsDeferred`（**不是**恒 `true` ✗ —— 恒 true 会让"关着开关"也开门 ✗）
  const hits = routable.filter(([, text]) => /allowUnposted\s*:/.test(text));
  assert.deepEqual(hits.map(([f]) => f), ['src/services/scanWriteService.js'],
    '⭐ "开门"那一处只许在冻结件里（别的调用方一个都不许有 ✗）');
  const all = routable.map(([, t]) => t).join('\n');
  assert.equal(/allowUnposted\s*:\s*true/.test(all), false,
    '🔴 全仓不许出现**恒 true** 的开门（那样关着开关也会开门 ⇒ 零回归没了 ✗）');
  for (const [file, text] of routable.slice(1)) {
    assert.equal(text.includes('allowUnposted'), false, `🔴 ${file} 一个字都不许改（不许传 allowUnposted ✗）`);
  }
  // ⭐ 那**一处**必须写成"跟着 `fundsDeferred` 走"，不许恒 true ✗
  assert.ok(/allowUnposted:\s*fundsDeferred/.test(FROZEN),
    '⭐ 必须是 `allowUnposted: fundsDeferred`（**不是**恒 `true` ✗ —— 关着开关时不传/传 false ⇒ 逐字同今天 ✓）');
});

test('AC-MS-G2 ⭐ 两处的缺省都是**显式布尔 false**（禁 `||` 兜底 ✗）', () => {
  // ⚠️ 2026-10-18 成对迁移（第 4 步提速 · 文件大小门禁）：`deliverStockLines` 整段**原样搬到**
  //   `src/services/sales/deliveryStep.js`（纯搬家）⇒ 缺省/转发这两条改读新模块；
  //   冻结件里只剩"调用点"（`allowUnposted: fundsDeferred || singlePass`）。
  const read = require('node:fs').readFileSync;
  const path = require('node:path');
  const DELIVERY_STEP = read(path.join(__dirname, '..', 'src', 'services', 'sales', 'deliveryStep.js'), 'utf8');
  assert.ok(/allowUnposted = false/.test(DELIVERY_STEP), '`deliverStockLines` 的形参缺省必须是 `false` ✓');
  assert.ok(/allowUnposted = false/.test(DELIVERY), '交付服务 `_deliver` 的形参缺省必须是 `false` ✓');
  assert.equal(/allowUnposted\s*\|\|/.test(DELIVERY_STEP + DELIVERY), false, '🔴 不许 `allowUnposted || …` 那种兜底 ✗');
  assert.ok(/allowUnposted,/.test(DELIVERY_STEP), '必须把形参**转发**给 `delivery().deliver({…})` ✓');
  assert.ok(/if \(!allowUnposted && !isPosted/.test(DELIVERY),
    '交付服务的守门必须是 `!allowUnposted && !isPosted(…)`（**只对货那一跑开门** ✓）');
});

test('AC-MS-G3 ⭐ 反向哨兵：`fundsDeferred` 不是恒 true ⇒ 关着开关时交付出参里没有"开门"', () => {
  // ⭐ 把"跟着 fundsDeferred 走"改回"恒 true" ⇒ 这条红（另见变异记录 ✓）
  const m = /const stock = await deliverStockLines\(\{[\s\S]*?\}\);/m.exec(FROZEN);
  assert.ok(m, '找不到货那一跑的交付调用 ✗');
  assert.ok(/allowUnposted:\s*fundsDeferred/.test(m[0]), '⭐ 必须显式跟着 `fundsDeferred` ✓（恒 true ⇒ 关着开关也会开门 ⇒ 红 ✓）');
  assert.equal(/allowUnposted:\s*true/.test(m[0]), false, '🔴 不许恒 `true` ✗');
  // ⭐ 而且 `fundsDeferred` 自己必须是"显式布尔"口径（`=== true` ✓）
  assert.ok(/const fundsDeferred = deferFunds === true;/.test(FROZEN), '`fundsDeferred` 必须是 `deferFunds === true` ✓');
});
