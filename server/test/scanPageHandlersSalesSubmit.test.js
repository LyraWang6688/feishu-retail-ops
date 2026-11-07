'use strict';

/** ⭐ 深拆 P2：销售提交 `submit_order` 分支搬进 `routes/scanPage/handlers/salesSubmit.js`（只搬不改）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const handlers = require('../src/routes/scanPage/handlers/salesSubmit');

test('handler 导出销售提交分支', () => {
  assert.equal(typeof handlers.handleSubmitOrder, 'function');
});

test('路由只做分派：分支体已搬走（塞回即红）', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.match(index, /require\('\.\/handlers\/salesSubmit'\)/);
  assert.match(index, /return handleSubmitOrderOf\(\{/);
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'handlers', 'salesSubmit.js'), 'utf8');
  for (const marker of ['buildWriteContext', 'sendPaymentStep', 'redirectWithSubmitToast',
    'deferFunds: true', 'submitSale', 'payments: []']) {
    assert.ok(file.includes(marker), `salesSubmit handler 里必须能看到原分支用的 ${marker}`);
  }
  assert.match(file, /const \{ [^}]+ \} = ctx;/, 'handler 必须用显式 ctx');
});
