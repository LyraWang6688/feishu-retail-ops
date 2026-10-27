'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../public/workbench');
const tabs = fs.readFileSync(path.join(root, 'config/tabs.js'), 'utf8');
const domains = fs.readFileSync(path.join(root, 'config/domains.js'), 'utf8');

test('资金是独立一级领域，排在货品之后', () => {
  assert.match(tabs, /\{ module: 'funds', label: '资金' \}/);
  const order = [...tabs.matchAll(/module: '(sales|inventory|purchase|product|funds)'/g)].map((m) => m[1]);
  assert.deepEqual(order, ['sales', 'inventory', 'purchase', 'product', 'funds']);
});

test('资金领域有独立占位页，不复用其他领域页面', () => {
  const block = domains.slice(domains.indexOf("id: 'funds'"), domains.indexOf("// ── ④ 货品"));
  assert.match(block, /id: 'funds-overview'/);
  assert.match(block, /label: '资金总览'/);
  assert.match(block, /kind: 'placeholder'/);
  assert.doesNotMatch(block, /scanRealm|sales-orders|inventory-/);
});
