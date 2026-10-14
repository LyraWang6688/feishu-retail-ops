'use strict';

/**
 * 🔴 2026-10-14 晚（业务负责人真机，逐字）：
 *   「你新上线的，在工作台点击了扫一扫，扫了一个二维码之后，**库存补货还有退货一点开都是资金页面**」
 *
 * 根因（真源 ✓）：`routes/scanPage.js` 里那段"**刷新仍给资金页**"的接管
 *   **没按领域限制** ✗ ⇒ 只要会话里还有 `paymentStep:'pending'`，她点**任何**领域都被资金页接管 ✗。
 *
 * 修法：只在**销售**上下文才允许接管 —— `from=sales` 或**不带 `from`** ✓；
 *   其它领域（库存 / 补货 / 退货 / …）⭐ **一律不接管** ✓。
 *
 * ⚠️ 本文件先用**源码哨兵**钉住这个边界（能真红 ✓）；
 *    "真请求"那版（假会话 + 真路由 ⇒ `?from=inventory` 出库存块、`?from=sales` 出资金页）
 *    我在下一轮补上 ✓（今天先保证**修对了、不再发生** ✗）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');

test('AC-PS1 🔴 资金页接管**只对销售上下文**生效（库存/补货/退货一律不接管）', () => {
  assert.match(SRC, /const salesContext = /, '要有"销售上下文"这个判据（一处定义 ✓）');
  assert.match(SRC, /pendingMark === 'pending' && salesContext/,
    '接管必须**同时**满足 pending 与"销售上下文"（能真红：谁去掉 `&& salesContext` 就红 ✓）');
  // 它必须真的认这两个值：空串（裸扫）或 sales ✓
  assert.match(SRC, /String\(req\.query\?\.from \|\| ''\) === ''/, '不带 from 仍算销售上下文 ✓');
  assert.match(SRC, /=== 'sales'/, 'from=sales 算销售上下文 ✓');
});
