'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../public/workbench');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('工作台一级「资金」tab 与「资金总览」子页已删除', () => {
  const tabs = read('config/tabs.js');
  const domains = read('config/domains.js');
  const main = read('main.js');
  assert.equal(/module: 'funds'/.test(tabs), false, '一级 tab 不再包含资金');
  assert.equal(/id: 'funds'/.test(domains), false, '领域配置不再包含 funds');
  assert.equal(/funds-overview|资金总览/.test(domains), false, '资金总览子页已删除');
  assert.equal(/\['funds'/.test(main), false, 'main.js 不再注册 funds 模块');
});
