'use strict';

/**
 * 异步销售（生产默认链路）必须先解析抖音团购券，再冻结 payload。
 *
 * 事故形状（2026-11-09 订单 XSD-20261109-0005）：
 *   - 券目录：面值 100 / 平台结算款 85.4
 *   - 收款明细却写了 100（面值）而不是 85.4（平台结算款）
 *   - 真因：`payment.js` 的 `if (salesAsync)` 在 `voucherPayments.resolveRows()` **之前** return
 *     ⇒ 券行被当成普通收款原样入队。
 *
 * 这是源码哨兵：不跑路由，只钉住“解析在入队前 + 异步 payload 用解析后的两份值”。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'handlers', 'payment.js'), 'utf8');

test('AC-AVP-1 券解析必须在异步分支之前', () => {
  const resolveAt = source.indexOf('await voucherPayments.resolveRows(pendingPayments)');
  const asyncAt = source.indexOf('\n          if (salesAsync) {');
  assert.ok(resolveAt > 0, '必须调用券解析');
  assert.ok(asyncAt > 0, '必须存在异步分支');
  assert.ok(resolveAt < asyncAt, '券解析必须在 if (salesAsync) 之前（否则异步链路绕过券）');
});

test('AC-AVP-2 异步 payload 使用券解析后的收款金额与行金额', () => {
  const asyncBlock = source.slice(source.indexOf('\n          if (salesAsync) {'));
  assert.match(asyncBlock, /actualAmount:\s*effectiveLineAmounts\[index\]/,
    '异步行金额必须用 adjustLineAmounts 后的 effectiveLineAmounts');
  assert.match(asyncBlock, /lines:\s*payloadLines,\s*payments:\s*paidPayments/,
    '异步收款必须用券解析后的 paidPayments（平台结算款）');
  assert.doesNotMatch(asyncBlock, /lines:\s*payloadLines,\s*payments:\s*pendingPayments/,
    '异步收款不许再用券解析前的 pendingPayments');
});
