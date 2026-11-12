'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');


test('AC-PP9 货品上新结果卡片可打开货品记录；货品完善支持按货号搜索', () => {
  const page = read('features/domains/productProfile.js');
  assert.match(page, /data-pp-record-url="\$\{esc\(item\.recordUrl/);
  assert.match(page, /window\.open\(row\.dataset\.ppRecordUrl/);
  assert.match(page, /data-pp-complete-search/);
  assert.match(page, /PRODUCT_PROFILE_API\.incomplete\}\$\{q \? `\?q=\$\{encodeURIComponent\(q\)\}`/);
});
