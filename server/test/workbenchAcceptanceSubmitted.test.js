'use strict';

/**
 * 2026-11-18：验收提交成功后的「已提交」态。
 * 不引入 DOM 库：用最小 fake 对象钉住行为（按钮置灰 / 输入锁住 / 重提被拦）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { markArrivalSubmitted } = require('../public/workbench/features/orders/acceptanceDoc.js');
const { createSubmitGuard } = require('../public/workbench/core/ui.js');

const fakeButton = () => ({
  disabled: false,
  textContent: '确认到货并入库',
  after(note) { this.note = note; },
});

test('AC-SUBMITTED1 成功后卡片进入已提交态：按钮置灰、输入锁住、卡片挂标记', () => {
  const button = fakeButton();
  const input = { disabled: false };
  const card = { attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } };
  const form = {
    dataset: {},
    closest: () => card,
    querySelectorAll: () => [button, input],
    querySelector: () => null,
  };
  const oldDocument = global.document;
  global.document = { createElement: () => ({ dataset: {}, className: '', textContent: '', hidden: true }) };
  try {
    markArrivalSubmitted({
      button,
      form,
      texts: { arrivalSubmitted: '已提交，后台处理中…', arrivalSubmittedNote: '已提交，后台正在入库，请勿重复提交。' },
    });
  } finally {
    global.document = oldDocument;
  }
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '已提交，后台处理中…');
  assert.equal(input.disabled, true);
  assert.equal(form.dataset.arrivalSubmitted, '1');
  assert.equal(card.attrs['data-arrival-submitted'], '1');
  assert.equal(button.note?.textContent, '已提交，后台正在入库，请勿重复提交。');
  assert.equal(button.note?.hidden, false);
});

test('AC-SUBMITTED2 keepDisabled：成功保留按钮，失败恢复按钮', async () => {
  const guard = createSubmitGuard();
  const ok = fakeButton();
  await guard.run(ok, async () => {
    ok.textContent = '已提交，后台处理中…';
    return true;
  }, '正在验收入库…', { keepDisabled: (accepted) => accepted === true });
  assert.equal(ok.disabled, true);
  assert.equal(ok.textContent, '已提交，后台处理中…');

  const bad = fakeButton();
  await assert.rejects(
    guard.run(bad, async () => { throw new Error('boom'); }, '正在验收入库…', { keepDisabled: () => true }),
    /boom/,
  );
  assert.equal(bad.disabled, false);
  assert.equal(bad.textContent, '确认到货并入库');
});

const fs = require('node:fs');
const path = require('node:path');

test('AC-SUBMITTED3 接线：成功标记在跳转前，且 runWriteAction 保留已提交态', () => {
  const root = path.join(__dirname, '..', 'public', 'workbench');
  const src = fs.readFileSync(path.join(root, 'features', 'orders', 'index.js'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'config', 'orders.js'), 'utf8');
  const markAt = src.indexOf('markArrivalSubmitted({ button, form, texts: ARRIVAL_FULL_TEXTS })');
  const assignAt = src.indexOf('window.location.assign(result.redirect_url)', markAt);
  assert.ok(markAt > 0 && assignAt > markAt, '先标记已提交，再跳转');
  assert.match(src, /keepDisabled: \(accepted\) => accepted === true/, '成功时要求保留按钮态');
  assert.match(config, /arrivalSubmitted: '已提交，后台处理中…'/, '按钮文案走配置');
  assert.match(config, /arrivalSubmittedNote: '已提交，后台正在入库，请勿重复提交。'/, '提示文案走配置');
});
