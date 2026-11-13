'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-WP1 销售交割单卡有写入时序入口，页面可查询按单时间线', () => {
  const render = read('features/sales-delivery/render.js');
  assert.ok(render.includes('/workbench/write-audit.html?order_no='));
  const page = read('write-audit.html');
  assert.ok(page.includes('id="wa-order"'));
  assert.ok(page.includes('features/write-audit/index.js'));
  const script = read('features/write-audit/index.js');
  assert.ok(script.includes('WRITE_AUDIT_PAGE.api'));
  assert.ok(script.includes('T.trace'), '按提交批次分组');
});
