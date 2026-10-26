'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'views', 'scanPage', 'submitProgress.js');

test('提交进度脚本不再用原生表单兜底（一次点击只允许一个请求）', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.equal(src.includes('HTMLFormElement.prototype.submit'), false,
    '🔴 删掉原生兜底；慢请求时它会造成第二次 POST');
  assert.match(src, /SUBMIT_FAILURE_TEXT/, '失败时显示配置文案');
});

test('失败文案来自配置，不在脚本里写死中文', () => {
  const scanPage = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'scanPage.js'), 'utf8');
  assert.match(scanPage, /submitFailureText:/);
  const src = fs.readFileSync(SRC, 'utf8');
  assert.equal(src.includes('提交失败'), false);
});
