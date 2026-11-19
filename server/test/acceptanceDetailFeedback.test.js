'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const detail = fs.readFileSync(path.join(ROOT, 'features/acceptance-detail/index.js'), 'utf8');
const config = fs.readFileSync(path.join(ROOT, 'config/orders.js'), 'utf8');

test('AC-ACC-FEEDBACK1 提交期间立即禁用并显示上传/提交中', () => {
  assert.ok(detail.includes('if (busy) button.disabled = true;'), '按钮由统一 busy 控制');
  assert.ok(detail.includes('setSubmitBusy(true, ARRIVAL_FULL_TEXTS.uploading)'), '上传阶段有提示');
  assert.ok(detail.includes('ARRIVAL_FULL_TEXTS.submitting'), '提交阶段有提示');
  assert.ok(config.includes("uploading: '正在上传验收单…'"), '上传文案走配置');
  assert.ok(detail.includes('state.submitting'), '防止重复提交');
});

test('AC-ACC-FEEDBACK2 金额旧提示会清除，错误用 toast 可见', () => {
  assert.ok(detail.includes('clearAmountHint()'), '提交时清旧金额提示');
  assert.ok(detail.includes("hint.textContent = ''; hint.hidden = true;"), '输入/提交时隐藏红字');
  assert.ok(detail.includes("import { showToast } from '../shared/toast.js'"), '复用统一 toast');
  assert.ok(detail.includes('finish(message, { toast: true })'), '400 等错误用 toast');
});

test('AC-ACC-FEEDBACK3 明细保留 hasStock / hasSample / needsSampleChoice', () => {
  assert.ok(detail.includes('hasStock: input.has_stock === true'));
  assert.ok(detail.includes('hasSample: input.has_sample === true'));
  assert.ok(detail.includes('needsSampleChoice: input.needs_sample_choice === true'));
});
