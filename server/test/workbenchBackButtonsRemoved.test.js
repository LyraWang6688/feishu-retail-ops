'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public', 'workbench');
const read = (relative) => fs.readFileSync(path.join(PUBLIC, relative), 'utf8');

test('工作台不再渲染「返回」按钮', () => {
  const files = [
    'features/domains/productProfile.js',
    'features/domains/productFeatureConfig.js',
    'features/inventory/adjustment.js',
  ];
  for (const file of files) {
    const source = read(file);
    assert.equal(source.includes('data-pp-back'), false, `${file} 还有 data-pp-back`);
    assert.equal(source.includes('data-feature-back'), false, `${file} 还有 data-feature-back`);
    assert.equal(source.includes('data-back'), false, `${file} 还有 data-back`);
    assert.equal(source.includes('‹ 返回'), false, `${file} 还有返回文案`);
  }
});

test('内页没有返回按钮，但当前 active tab 再点一次可以回到第一屏', () => {
  const domains = read('features/domains/index.js');
  assert.match(domains, /function resetPage\(/, '必须有统一的 resetPage');
  assert.match(domains, /page\.id === state\.active && state\.mounted\.has\(page\.id\)/, '当前子 tab 必须触发 reset');
  assert.match(domains, /reset\(\) \{ return resetPage\(state\.active\); \}/, '领域模块必须暴露 reset');
  const main = read('main.js');
  assert.match(main, /module\?\.reset\?\.\(\)/, '一级 tab 再点一次也必须能 reset');
});

test('库存调整的「取消」保留为独立动作，不再复用返回按钮', () => {
  const adjustment = read('features/inventory/adjustment.js');
  assert.match(adjustment, /data-cancel>取消/);
  assert.match(adjustment, /\[data-cancel\]/);
  assert.equal(adjustment.includes('‹ 返回'), false);
});
