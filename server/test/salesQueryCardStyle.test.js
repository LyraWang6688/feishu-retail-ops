'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('销售查询货品卡：货号加粗，销售单号与销售时间格式一致', () => {
  const css = read('public/workbench/features/sales-query/sales-query.css');
  assert.match(css, /\.sq-detail-product\s*\{[^}]*font-weight:\s*var\(--weight-bold\)/,
    '货号必须是粗体');
  assert.match(css, /\.sq-order-title b\s*\{[^}]*font-size:\s*var\(--font-size-xs\)/,
    '销售单号与销售时间同为 12px');
  assert.match(css, /\.sq-order-title b\s*\{[^}]*color:\s*var\(--text-muted\)/,
    '销售单号与销售时间同色');
  assert.match(css, /\.sq-order-title b\s*\{[^}]*font-weight:\s*var\(--weight-normal\)/,
    '销售单号与销售时间同字重');
  assert.match(css, /\.sq-order-time\s*\{[^}]*font-size:\s*var\(--font-size-xs\)/,
    '销售时间仍为 12px');
});
