'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('售后换款式入口绑定销售扫码领域', () => {
  const config = read('public/workbench/config/afterSalesPage.js');
  const ui = read('public/workbench/features/after-sales/index.js');
  const flows = read('src/config/scanFlows.js');
  assert.match(config, /exchangeRealm:\s*'sales'/, '换款式领域必须是 sales');
  assert.match(ui, /from:\s*AFTER_SALES_PAGE\.exchangeRealm/, '换款式跳转必须带 from=sales');
  assert.match(flows, /entry:\s*'\/r\/\{number\}\?from=sales&flow=afterSalesExchange'/, 'flow entry 也必须带 from=sales');
});
