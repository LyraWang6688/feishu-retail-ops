'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('采购页固定 tab，库存调整 / 信息完善单独占一行', () => {
  const css = read('procurement.css');
  const config = read('config/procurement.js');
  assert.match(css, /\.pr-tabs\s*\{[^}]*position:\s*sticky/, '补货/上新/扫一扫固定在顶部');
  assert.match(css, /\.pr-tabs\s*\{[^}]*top:\s*env\(safe-area-inset-top/, '避开安全区');
  assert.match(css, /\.pr-product-actions\s*\{[^}]*width:\s*100%/, '操作区独占一行');
  assert.match(css, /\.pr-product-actions\s*\{[^}]*flex:\s*0 0 100%/, '不再和尺码卡抢同一行');
  assert.match(config, /gapLinkLabel:\s*'信息完善'/, '资料不齐入口显示「信息完善」');
});

test('验收明细不显示标题/批次/供应商，汇总条固定在顶部', () => {
  const source = read('features/acceptance-detail/index.js');
  const css = read('features/acceptance-detail/detail.css');
  assert.equal(source.includes('arrival-detail-head'), false, '验收明细标题区已删除');
  assert.equal(source.includes('detailPageTitle'), false, '不再渲染验收明细标题');
  assert.equal(source.includes('arrival-batch-label'), false, '不再渲染批次号');
  assert.equal(source.includes('arrival-supplier-label'), false, '不再渲染供应商');
  assert.match(css, /\.arrival-summary\s*\{[^}]*position:\s*sticky/, '应到/实到/多到固定在顶部');
});
