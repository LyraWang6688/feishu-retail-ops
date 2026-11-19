'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const domains = fs.readFileSync(path.join(ROOT, 'public/workbench/config/domains.js'), 'utf8');

test('库存子 tab：手工调整 → 库存流水；全仓查询已退场', () => {
  const block = domains.slice(domains.indexOf("id: 'inventory'"), domains.indexOf('// ── ③ 供应'));
  const adjust = block.indexOf("id: 'inventory-adjust'");
  const ledger = block.indexOf("kind: 'inventory-ledger'");
  const all = block.indexOf("id: 'inventory-all'");
  assert.ok(adjust >= 0 && ledger >= 0);
  assert.ok(adjust < ledger, '库存流水必须排在手工调整之后');
  assert.equal(all, -1, '全仓查询子 tab 已删除');
  assert.equal(block.includes('全仓查询'), false, '库存子 tab 不许再出现全仓查询');
});

test('全仓查询链路文件已删除', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'public/workbench/config/query.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'public/workbench/features/query/index.js')), false);
});
