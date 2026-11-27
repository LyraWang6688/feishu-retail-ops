'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('配品配置：等后台写入完成后统一回工作台并带 toast', () => {
  const page = read('features/domains/accessoryConfig.js');
  const config = read('config/accessoryConfig.js');
  assert.ok(page.includes('waitForAsyncJob'), '先等异步任务完成');
  assert.ok(page.includes('window.location.assign'), '完成后跳回工作台');
  assert.ok(page.includes('ACCESSORY_CONFIG_REDIRECT'), '落点/参数来自配置');
  assert.match(config, /path: '\/workbench\//);
  assert.match(config, /toastParam: 'toast'/);
});
