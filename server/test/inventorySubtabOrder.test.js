'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('库存子 tab 顺序：手工调整在前，全仓查询在后', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/workbench/config/domains.js'), 'utf8');
  const block = src.slice(src.indexOf("id: 'inventory'"), src.indexOf("// ── ③ 供应"));
  const adjust = block.indexOf("id: 'inventory-adjust'");
  const all = block.indexOf("id: 'inventory-all'");
  assert.ok(adjust >= 0 && all >= 0);
  assert.ok(adjust < all, '手工调整必须排在全部查询前面');
});
