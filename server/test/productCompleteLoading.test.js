'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('AC-PC-LOAD 货品完善先显示加载态，空数据有明确提示', () => {
  const page = read('public/workbench/features/domains/productProfile.js');
  const cfg = read('public/workbench/config/productProfile.js');
  assert.match(page, /completeLoading/);
  assert.match(page, /completeEmpty/);
  assert.match(page, /data-pp-complete-tabs/);
  assert.match(cfg, /completeLoading: '正在读取缺失信息…'/);
  assert.match(cfg, /completeEmpty: '当前没有待完善的货品。'/);
});
