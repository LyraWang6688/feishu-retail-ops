'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('采购页固定 tab，库存调整 / 信息完善与货品标题同一行', () => {
  const css = read('procurement.css');
  const config = read('config/procurement.js');
  assert.match(css, /\.pr-sticky-head\s*\{[^}]*position:\s*sticky/, 'tab + 搜索框固定在顶部');
  assert.match(css, /\.pr-sticky-head\s*\{[^}]*top:\s*env\(safe-area-inset-top/, '避开安全区');
  assert.match(css, /\.pr-search\s*\{/, '供应商页搜索框在固定头部');
  const base = read('styles/base.css');
  assert.match(base, /\.html, body|html, body/, '有全局横向约束');
  assert.match(base, /overflow-x:\s*clip/, '不能再用 overflow-x:hidden 创建滚动容器');
  assert.match(css, /\.pr-product-actions\s*\{[^}]*width:\s*auto/, '操作区跟随货品标题');
  assert.match(css, /\.pr-product-actions\s*\{[^}]*flex:\s*0 1 auto/, '操作区与货品标题同一行');
  assert.match(read('features/procurement/render.js'), /pr-group-title-wrap[\s\S]*productActionsHtml/, '操作区必须渲染在标题行内');
  assert.match(config, /infoLabel:\s*'信息完善'/, '资料不齐入口显示「信息完善」');
});

test('验收明细不显示标题/批次/供应商，tab + 汇总条一起固定在顶部', () => {
  const source = read('features/acceptance-detail/index.js');
  const css = read('features/acceptance-detail/detail.css');
  assert.equal(source.includes('arrival-detail-head'), false, '验收明细标题区已删除');
  assert.equal(source.includes('detailPageTitle'), false, '不再渲染验收明细标题');
  assert.equal(source.includes('arrival-batch-label'), false, '不再渲染批次号');
  assert.equal(source.includes('arrival-supplier-label'), false, '不再渲染供应商');
  assert.match(source, /pr-sticky-head arrival-sticky-head/, '验收区 / 预览区复用采购页固定头部');
  assert.match(css, /\.arrival-summary\[hidden\]\s*\{[^}]*display:\s*none/, '切换 tab 时只显示对应汇总条');
});
