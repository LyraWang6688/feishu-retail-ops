'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('配置页错误使用统一顶部 toast：danger 样式 + alert 语义', () => {
  const toast = read('features/shared/toast.js');
  const base = read('styles/base.css');
  assert.ok(toast.includes("export const showErrorToast"), '统一错误 toast 入口');
  assert.ok(toast.includes("options.tone === 'danger'"), '错误 tone');
  assert.ok(toast.includes("toast.classList.toggle('toast-danger', danger)"), '错误样式切换');
  assert.ok(toast.includes("danger ? 'alert' : 'status'"), '错误使用 alert');
  assert.ok(base.includes('.workbench-toast.toast-danger'), '错误 toast 样式');
  assert.ok(base.includes('background: var(--danger-soft)'), '错误 toast 背景');
});

test('产品特点配置错误不再显示内联红字', () => {
  const page = read('features/domains/productFeatureConfig.js');
  assert.ok(page.includes('showErrorToast'), '错误走统一 toast');
  assert.equal(page.includes('data-feature-error'), false, '不再渲染字段内联错误');
  assert.equal(page.includes('pf-error'), false, '不再使用 pf-error');
});

test('配品配置错误不再显示表单底部内联红字', () => {
  const page = read('features/domains/accessoryConfig.js');
  assert.ok(page.includes('showErrorToast'), '错误走统一 toast');
  assert.equal(page.includes('data-ac-error'), false, '不再渲染表单内联错误');
  assert.equal(page.includes('ac-error'), false, '不再使用 ac-error');
});
