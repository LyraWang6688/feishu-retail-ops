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
