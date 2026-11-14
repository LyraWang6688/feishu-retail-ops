'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-PP9 货品上新结果卡片可打开货品记录', () => {
  const page = read('features/domains/productProfile.js');
  assert.match(page, /data-pp-record-url="\$\{esc\(item\.recordUrl/);
  assert.match(page, /window\.open\(row\.dataset\.ppRecordUrl/);
  assert.ok(page.includes('issueChipsOf'), '搜索结果按缺失维度生成标签');
  assert.ok(page.includes('pp-issue'), '问题标签有独立样式');
  assert.equal(page.includes('货号 ${esc(item.itemNo)} · 颜色'), false, '不再重复货号/颜色/类别');
});

test('AC-PP12 货品完善三维度 tab：样例图 / 商品信息缺失 / 标签信息缺失', () => {
  const page = read('features/domains/productProfile.js');
  assert.ok(page.includes('data-pp-complete-tabs'));
  assert.equal(page.includes('data-pp-select'), false, '不再有缺失信息下拉');
  assert.equal(page.includes('data-pp-complete-search'), false, '不再有货品完善搜索框');
  assert.ok(page.includes('data-pp-dimension'));
  assert.ok(page.includes('PRODUCT_PROFILE_API.completion'));
  assert.ok(page.includes("dimension.key === 'product'"));
  assert.ok(page.includes('item.missingTag'), '标签信息缺失用公式字段');
  assert.ok(page.includes('item.imageUrl'), '有样例图时显示缩略图');
  assert.ok(page.includes('item.recordUrl'), '去完善打开飞书记录');
});

test('AC-PP13 #1204：缩略图懒加载 / 分页 / 失败可重试', () => {
  const page = read('features/domains/productProfile.js');
  const texts = read('config/productProfile.js');
  assert.ok((page.match(/loading="lazy"/g) || []).length >= 2, '两处缩略图都要懒加载');
  assert.ok(page.includes('COMPLETE_PAGE_SIZE'), '完整度列表分页');
  assert.ok(page.includes('data-pp-more'), '有「加载更多」');
  assert.ok(page.includes('data-pp-retry'), '失败可点重试');
  assert.match(texts, /thumbFailed: '加载失败 · 点击重试'/);
  assert.match(texts, /more: '加载更多（还有 \{count\} 条）'/);
});
