'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-AIF1 配品配置是工作台内页，不再跳转其他配品 Base 表', () => {
  const page = read('features/domains/productProfile.js');
  const cfg = read('config/productProfile.js');
  const links = read('config/links.js');
  assert.equal(links.includes('ACCESSORY_TABLE_URL'), false, '不再保留外部表 URL');
  assert.match(page, /data-pp-view="accessory"/);
  assert.match(page, /createAccessoryConfigModule/);
  assert.match(page, /data-pp="accessory"/);
  assert.equal(page.includes('accessoryTableUrl'), false);
  assert.equal(cfg.includes('accessoryTableUrl'), false);
  assert.equal(page.includes('<iframe'), false);
});

test('AC-AIF2 配品配置不再保留 iframe 高度样式', () => {
  const css = read('features/domains/domains.css');
  assert.equal(css.includes('.pp-accessory-frame'), false);
});
