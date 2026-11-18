'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('库存子 tab 顺序：手工调整 → 库存流水 → 全仓查询', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/workbench/config/domains.js'), 'utf8');
  const block = src.slice(src.indexOf("id: 'inventory'"), src.indexOf("// ── ③ 供应"));
  const adjust = block.indexOf("id: 'inventory-adjust'");
  const ledger = block.indexOf("kind: 'inventory-ledger'");
  const all = block.indexOf("id: 'inventory-all'");
  assert.ok(adjust >= 0 && ledger >= 0 && all >= 0);
  assert.ok(adjust < ledger, '库存流水必须排在手工调整之后');
  assert.ok(ledger < all, '库存流水必须排在全部查询之前');
});
