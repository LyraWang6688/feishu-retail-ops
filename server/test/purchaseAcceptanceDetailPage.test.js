'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('AC-PAD1 批次卡跳独立验收明细页，不再原地展开', () => {
  const orders = read('public/workbench/features/orders/index.js');
  assert.ok(orders.includes('purchase-acceptance-detail.html?'), '批次卡指向独立明细页 ✓');
  assert.ok(orders.includes('data-action="open-arrival"'), '验收是跳转入口 ✓');
  const page = read('public/workbench/purchase-acceptance-detail.html');
  assert.match(page, /acceptance-detail\/index\.js/, '明细页挂载独立模块 ✓');
  assert.match(page, /acceptance-detail\/detail\.css/, '明细页有独立样式 ✓');
});

test('AC-PAD2 明细页有应到/实到/多到、固定底栏和自定义尺码入口', () => {
  const src = read('public/workbench/features/acceptance-detail/index.js');
  const config = read('public/workbench/config/orders.js');
  assert.ok(src.includes('Intl.Collator(\'zh-CN\', { numeric: true'), '按货号自然排序 ✓');
  assert.ok(src.includes('data-add-size'), '每个商品卡片有添加尺码入口 ✓');
  assert.ok(src.includes('arrival-summary'), '正文顶部有应到/实到/多到汇总 ✓');
  assert.ok(src.includes('data-view="arrival-total"'), '底部有到货合计 ✓');
  assert.ok(src.includes('pr-bottom'), '底部固定条复用采购页样式 ✓');
  assert.ok(src.includes('ARRIVAL_FULL_API.accept'), '提交走既有 accept 接口 ✓');
  assert.ok(config.includes('summaryExpected:'), '应到文案走配置 ✓');
  assert.ok(config.includes('summaryActual:'), '实到文案走配置 ✓');
  assert.ok(config.includes('summaryExtra:'), '多到文案走配置 ✓');
  assert.ok(config.includes('customSizeLabel:'), '自定义尺码文案走配置 ✓');
});

test('AC-PAD3 自定义尺码重复 / 非法在本页提交前拦住', () => {
  const src = read('public/workbench/features/acceptance-detail/index.js');
  assert.ok(src.includes('duplicateSize'), '重复尺码拦截 ✓');
  assert.ok(src.includes('customSizeInvalid'), '非法尺码拦截 ✓');
  assert.ok(src.includes('validateRows()'), '提交前执行行校验 ✓');
});
