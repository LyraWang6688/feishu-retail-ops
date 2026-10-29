'use strict';

/** ⭐ 深拆 P1：资金处理 `payment_pay` 分支搬进 `routes/scanPage/handlers/payment.js`（只搬不改）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const handlers = require('../src/routes/scanPage/handlers/payment');

test('handler 导出资金处理分支', () => {
  assert.equal(typeof handlers.handlePaymentPay, 'function');
});

test('路由只做分派：分支体已搬走（塞回即红）', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.match(index, /require\('\.\/handlers\/payment'\)/);
  assert.match(index, /return handlePaymentPayOf\(\{/);
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'handlers', 'payment.js'), 'utf8');
  for (const marker of ['respondSettlementBlock', 'sendPaymentStep', 'redirectWithSubmitToast',
    'scan_sale_paid', 'PAYMENT_STATUS', 'submitSale']) {
    assert.ok(file.includes(marker), `payment handler 里必须能看到原分支用的 ${marker}`);
  }
  assert.match(file, /const \{ [^}]+ \} = ctx;/, 'handler 必须用显式 ctx');
});
