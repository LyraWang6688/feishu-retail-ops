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

test('AC-SS1 单行金额用 currentAmount，不许引用已删除的 singleRowAmount', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'handlers', 'salesSubmit.js'), 'utf8');
  assert.equal(file.includes('singleRowAmount'), false, 'singleRowAmount 已在 2026-10-29 删除，禁止再引用');
  assert.match(file, /const singleLineAmount = currentAmount && finalLines\.length === 1 \? \[currentAmount\] : \[\];/,
    '单行金额必须回落到当前行金额');
});

test('路由只做分派：分支体已搬走（塞回即红）', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'actionRoutes.js'), 'utf8');
  assert.match(index, /require\('\.\/handlers\/salesSubmit'\)/);
  assert.match(index, /return handleSubmitOrderOf\(\{/);
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'handlers', 'salesSubmit.js'), 'utf8');
  for (const marker of ['buildWriteContext', 'sendPaymentStep', 'redirectWithSubmitToast',
    'deferFunds: true', 'submitSale', 'payments: []']) {
    assert.ok(file.includes(marker), `salesSubmit handler 里必须能看到原分支用的 ${marker}`);
  }
  assert.match(file, /const \{ [^}]+ \} = ctx;/, 'handler 必须用显式 ctx');
});
