'use strict';

/** ⭐ 深拆 P0：补货/退货分支搬进 `routes/scanPage/handlers/purchase.js`（只搬不改）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const handlers = require('../src/routes/scanPage/handlers/purchase');

test('handler 导出两个提交分支（补货/退货）', () => {
  assert.equal(typeof handlers.handleReplenish, 'function');
  assert.equal(typeof handlers.handlePurchaseReturn, 'function');
});

test('路由只做分派：两个分支体已搬走（塞回即红）', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.match(index, /require\('\.\/handlers\/purchase'\)/);
  assert.match(index, /return handleReplenishOf\(\{/);
  assert.match(index, /return handlePurchaseReturnOf\(\{/);
  // 分支体关键语句不许再留在 index（搬回 = 红）；
  //   ⚠️ `parseReplenishEntries` 在「加货」分支里也有合法调用 ⇒ 只钉**提交分支特有**的那句。
  assert.equal(index.includes('purchaseEntryViolation({ chain: \'replenish\''), false);
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'handlers', 'purchase.js'), 'utf8');
  for (const marker of ['parseReplenishEntries', 'parseReturnEntries', 'purchaseEntryViolation',
    'schedulePurchaseWrite', 'submitMultiItemOrder', 'redirectWithSubmitToast']) {
    assert.ok(file.includes(marker), `handler 里必须能看到原分支用的 ${marker}`);
  }
  assert.match(file, /const \{ [^}]+ \} = ctx;/, 'handler 必须用显式 ctx（不再读路由闭包）');
});
