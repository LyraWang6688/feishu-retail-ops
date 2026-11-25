'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('配品销售成功 = 统一回执跳工作台，不再页面内绿条/本地成功文案', () => {
  const page = read('features/accessory-sale/index.js');
  assert.equal(page.includes('data-as-success'), false, '删除页面内绿色成功条');
  assert.equal(page.includes('T.success'), false, '不再弹本地「销售已提交」');
  assert.ok(page.includes('window.location.assign'), '成功后回工作台');
  assert.ok(page.includes('result?.redirect'), '落点由服务端统一回执生成');
  const texts = read('config/accessorySalePage.js');
  assert.equal(texts.includes('success:'), false, '不再保留本地成功文案');
  assert.equal(texts.includes('orderNoLabel'), false, '单号不在页面上展示');
});
