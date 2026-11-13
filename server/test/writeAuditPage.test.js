'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-WP1 配置审计页有数据写入审计入口，页面可查询按单时间线', () => {
  const domains = read('config/domains.js');
  const action = read('features/domains/dataConfigAction.js');
  assert.ok(domains.includes("title: '数据写入审计', action: 'write-audit'"));
  assert.ok(action.includes('data-domain-action="write-audit"'));
  const page = read('write-audit.html');
  assert.ok(page.includes('id="wa-order"'));
  assert.ok(page.includes('<title>邯美工作台</title>'), '标题统一为邯美工作台');
  assert.ok(page.includes('features/write-audit/index.js'));
  const script = read('features/write-audit/index.js');
  assert.ok(script.includes('WRITE_AUDIT_PAGE.api'));
  assert.ok(script.includes('T.trace'), '按提交批次分组');
});


test('AC-WP2 清空本单有独立业务事件', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/scanWrite/session.js'), 'utf8');
  assert.match(source, /config\.events\.draftCleared/);
});
