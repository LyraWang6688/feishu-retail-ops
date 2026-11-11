'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('AC-TR1 页面内轻提示支持 sticky：等页面切换或读空闲，不固定 3 秒', () => {
  const src = read('public/workbench/features/shared/toast.js');
  assert.match(src, /options\.sticky === true/);
  assert.match(src, /workbench:view-change/);
  assert.match(src, /workbench:reads-start/);
  assert.match(src, /workbench:reads-idle/);
  assert.match(src, /MAX_STICKY_MS\s*=\s*20000/);
  assert.equal(src.includes("setTimeout(remove, 3000)"), false, '普通提示仍 3 秒，但不再只有一个固定 3 秒分支');
});

test('AC-TR2 读取/搜索类提示使用 sticky；提交回执仍走 ?toast= 的 ready 生命周期', () => {
  const adjustment = read('public/workbench/features/inventory/adjustment.js');
  assert.match(adjustment, /INVENTORY_MANUAL_TEXTS\.batchLoading, \{ sticky: true \}/);
  const product = read('public/workbench/features/domains/productProfile.js');
  assert.match(product, /T\.searchingToast, \{ sticky: true \}/);
  const receipt = read('public/workbench/shared/toast.js');
  assert.match(receipt, /workbench:module-mounted/);
  assert.match(receipt, /workbench:reads-idle/);
});
