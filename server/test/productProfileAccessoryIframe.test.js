'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-AIF1 配品配置直接跳转「其他配品」Base 表，不再 iframe', () => {
  const page = read('features/domains/productProfile.js');
  const cfg = read('config/productProfile.js');
  const links = read('config/links.js');
  assert.match(links, /ACCESSORY_TABLE_URL/);
  assert.match(links, /table=tblxEeiXYAeUF4gH&view=vewsk5LJgq/);
  assert.match(page, /data-pp-accessory|T\.accessoryTableUrl/);
  assert.match(page, /class="entry-card" href="\$\{esc\(T\.accessoryTableUrl\)\}"/);
  assert.equal(page.includes('<iframe'), false, '配品配置不再使用 iframe');
  assert.equal(page.includes('data-pp-view="accessory"'), false, '不再有内嵌配品配置视图');
  assert.match(cfg, /accessoryTableUrl: ACCESSORY_TABLE_URL/);
});

test('AC-AIF2 不再保留 iframe 高度样式', () => {
  const css = read('features/domains/domains.css');
  assert.equal(css.includes('.pp-accessory-frame'), false);
});
