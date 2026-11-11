'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-AIF1 配品配置用 iframe 嵌入「其他配品」Base 表，并有外链兜底', () => {
  const page = read('features/domains/productProfile.js');
  const cfg = read('config/productProfile.js');
  const links = read('config/links.js');
  assert.match(links, /ACCESSORY_TABLE_URL/);
  assert.match(links, /table=tblxEeiXYAeUF4gH/);
  assert.match(page, /data-pp-view="accessory"/);
  assert.match(page, /<iframe[^>]+data-pp-accessory/);
  assert.match(page, /frame\.setAttribute\('src', T\.accessoryTableUrl\)/);
  assert.match(page, /data-pp-accessory-link/);
  assert.match(page, /accessoryOpenExternal/);
  assert.match(cfg, /accessoryTableUrl: ACCESSORY_TABLE_URL/);
});

test('AC-AIF2 嵌入 iframe 有高度样式，移动端也可见', () => {
  const css = read('features/domains/domains.css');
  assert.match(css, /\.pp-accessory-frame\{[^}]*height:70vh/);
  assert.match(css, /max-width:760px/);
});
