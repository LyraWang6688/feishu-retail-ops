'use strict';

/** 2026-11-15 业务负责人：登录行删除，姓名拼进容器标题「邯美工作台 · 王颖」。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public/workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-TITLE1 登录后把姓名写进 document.title', () => {
  const auth = read('core/auth.js');
  assert.match(auth, /document\.title = `邯美工作台 · \$\{name\}`/, '标题必须是「邯美工作台 · 姓名」');
  assert.match(auth, /body\.user\?\.name \|\| '飞书用户'/, '取 /me 返回的姓名');
});

test('AC-TITLE2 首页与 label-print 都不再保留登录行 / 退出登录', () => {
  for (const page of ['index.html', 'label-print.html']) {
    const html = read(page);
    assert.equal(html.includes('id="auth-status"'), false, `${page} 不许再有登录状态行`);
    assert.equal(html.includes('id="logout"'), false, `${page} 不许再有退出登录按钮`);
    assert.equal(html.includes('class="auth"'), false, `${page} 不许再有 .auth 容器`);
  }
  const base = read('styles/base.css');
  assert.equal(/\.auth\b/.test(base), false, '登录行样式一并删除');
});
