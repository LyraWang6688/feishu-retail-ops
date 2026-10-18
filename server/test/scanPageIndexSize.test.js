'use strict';

/**
 * ⭐ 深拆验收哨兵（P0–P3c）：扫码主路由必须是「分派 + 装配」，不再回涨成大闭包。
 * 依据：docs/scan-page-core-extraction-plan-2026-10-18.md（目标 ≤ ~1800 行）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const INDEX = path.join(SERVER, 'src', 'routes', 'scanPage', 'index.js');
const HANDLERS = ['purchase.js', 'payment.js', 'salesSubmit.js', 'smallActions.js'];

test('主路由 ≤ 1800 行（拆完不许回涨）', () => {
  const lines = fs.readFileSync(INDEX, 'utf8').split('\n').length;
  assert.ok(lines <= 1800, `routes/scanPage/index.js 已回涨到 ${lines} 行（目标 ≤ 1800）`);
});

test('三个主干分支 + 小动作都已搬进 handlers/（塞回即红）', () => {
  const index = fs.readFileSync(INDEX, 'utf8');
  for (const f of HANDLERS) {
    assert.ok(fs.existsSync(path.join(SERVER, 'src', 'routes', 'scanPage', 'handlers', f)), `handlers/${f} 必须在`);
    assert.match(index, new RegExp(`require\\('\\./handlers/${f.replace('.js', '')}'\\)`));
  }
  // 主干分支体不许再留在 index（关键语句）
  // ⚠️ `parseReplenishEntries(...)` 在「加货」分支里仍有合法调用 ⇒ 只钉提交分支特有的语句。
  for (const marker of ['scan_sale_paid', 'submitSale({', 'addSaleLine({']) {
    assert.equal(index.includes(marker), false, `分支体关键语句「${marker}」不该再留在 index`);
  }
});

test('helpers 已搬进 responses.js / flowHelpers.js（显式注入）', () => {
  const index = fs.readFileSync(INDEX, 'utf8');
  assert.match(index, /require\('\.\/responses'\)\.createResponses\(/);
  assert.match(index, /require\('\.\/flowHelpers'\)\.createFlowHelpers\(/);
  const resp = fs.readFileSync(path.join(SERVER, 'src', 'routes', 'scanPage', 'responses.js'), 'utf8');
  for (const m of ['sendHuman', 'notFoundPage', 'respondFailure', 'purchaseAmountMissingPage']) {
    assert.ok(resp.includes(m), `responses.js 必须包含 ${m}`);
  }
  const flow = fs.readFileSync(path.join(SERVER, 'src', 'routes', 'scanPage', 'flowHelpers.js'), 'utf8');
  for (const m of ['submitMultiItemOrder', 'buildWriteContext', 'buildPrintContext', 'sendSuccess']) {
    assert.ok(flow.includes(m), `flowHelpers.js 必须包含 ${m}`);
  }
});
