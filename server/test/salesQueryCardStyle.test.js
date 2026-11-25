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

test('销售订单卡：录单人 / 售后人（方案 A：单独一行，空则不渲染）', () => {
  const js = read('public/workbench/features/shared/salesOrderCard.js');
  const css = read('public/workbench/features/sales-query/sales-query.css');
  const cfg = read('public/workbench/config/salesOrderCard.js');
  assert.match(js, /sq-order-people/, '卡片要有人员行');
  assert.match(js, /sq-person--after/, '售后人要有个可区分的标签');
  assert.match(js, /order\.sender/, '必须读 sender');
  assert.match(js, /order\.after_sales_by/, '必须读 after_sales_by');
  assert.match(js, /\(sender \|\| afterSales\)/, '两个都没有时整行不渲染');
  assert.match(css, /\.sq-order-head--people \{[^}]*grid-template-areas/, '有人员时用三行网格（方案 A）');
  assert.match(css, /\.sq-person--after \{[^}]*var\(--primary-soft\)/, '售后人用主色浅底');
  assert.match(cfg, /sender: '录单人'/);
  assert.match(cfg, /afterSales: '售后人'/);
});
