'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('销售查询货品卡：货号加粗，销售单号/时间字级保持现状', () => {
  const css = read('public/workbench/features/sales-query/sales-query.css');
  assert.match(css, /\.sq-detail-product\s*\{[^}]*font-weight:\s*var\(--weight-bold\)/,
    '货号必须是粗体');
  assert.match(css, /\.sq-order-title b\s*\{[^}]*font-size:\s*var\(--font-size-sm\)/,
    '销售单号仍为 13px');
  assert.match(css, /\.sq-order-time\s*\{[^}]*font-size:\s*var\(--font-size-xs\)/,
    '销售时间仍为 12px');
});
