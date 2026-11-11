'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('AC-HIDDEN1 工作台不再注册未显示的 douyin / platform 占位模块', () => {
  const main = read('public/workbench/main.js');
  assert.equal(main.includes("['douyin'"), false, 'douyin 隐藏模块必须删除');
  assert.equal(main.includes("['platform'"), false, 'platform 隐藏模块必须删除');
  assert.equal(main.includes('createPlaceholderModule'), false, '不再 import 占位模块工厂');
});

test('AC-HIDDEN2 标签打印页只允许 ?scan=1，旧的无参数空白页 404', () => {
  const app = read('src/app.js');
  assert.match(app, /app\.get\('\/workbench\/label-print\.html'/);
  assert.match(app, /req\.query\.scan/);
  assert.match(app, /status\(404\)/);
  // 扫描页仍存在，二维码/卡片入口仍带 scan=1
  assert.ok(fs.existsSync(path.join(root, 'public/workbench/label-print.html')));
  assert.match(read('public/workbench/config/domains.js'), /label-print\.html\?scan=1/);
});
