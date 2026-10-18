'use strict';
// ⭐ 2026-10-18 线上事故回归：资金页表单两颗提交按钮都叫 action（name="action"），
//   进度脚本若读 `form.action` 会被同名控件覆盖成 RadioNodeList ⇒ POST /r/[object RadioNodeList]
//   ⇒ 后端 unknown_action（页面「任务创建失败」）。必须读 attribute。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { submitProgressScriptHtml } = require('../src/views/scanPage/submitProgress');

test('提交进度脚本只读 form action 属性，不读会被控件覆盖的 form.action', () => {
  const html = submitProgressScriptHtml();
  assert.match(html, /form\.getAttribute\('action'\)/, '必须用 getAttribute 读 action');
  assert.doesNotMatch(html, /\bform\.action\b/, '禁止 form.action（被 name=action 控件覆盖成 RadioNodeList）');
});
