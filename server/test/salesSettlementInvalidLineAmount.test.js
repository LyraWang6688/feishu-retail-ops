'use strict';

/**
 * 回归：行金额非法时，结算层必须返回 `line_amount_invalid` + 人话。
 *
 * 线上事故（XSD-20261118-0001，2026-11-18 09:50）：`salesSettlement.js` 的非法金额分支
 * 引用了未声明的 `message` ⇒ 后台抛 ReferenceError `message is not defined`，
 * 真实的「金额无效」人话被吞掉，销售 job 直接失败。
 * ⚠️ 2026-11-18 业务负责人：**0 是合法金额**（赠送 / 自家穿），非法只指非数字 / 负数。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSaleSettlement } = require('../src/services/scanWrite/salesSettlement');
const { createScanWriteHelpers } = require('../src/services/scanWrite/helpers');

const makeHelpers = () => createScanWriteHelpers({
  schema: {},
  config: {
    texts: {},
    events: { failed: 'scan.write.failed.test' },
    sale: { amountDecimals: 2, unsafeErrorMarkers: [] },
  },
  logError: () => undefined,
});

const settlementConfig = () => ({
  texts: {},
  events: { failed: 'scan.write.failed.test' },
  sale: {
    amountDecimals: 2,
    paymentStatus: {
      values: ['全付', '部分付', '未付'],
      default: '未付',
      mode: { full: '全付', partial: '部分付', unpaid: '未付' },
    },
  },
});

test('AC-SS-AMOUNT1 非数字行金额 ⇒ line_amount_invalid，不抛 message is not defined', async () => {
  const failures = [];
  const amountInvalidBody = '实收金额要填数字（可以填 0）';
  const result = await resolveSaleSettlement({
    lines: [{ amount: 'abc' }],
    lineAmounts: ['abc'],
    paymentRows: [],
    paymentStatus: '',
    paidAmount: '',
    openId: 'ou_test',
    sessionId: 'session_test',
    key: 'submit_key',
    requestId: 'req_test',
    config: {},
    texts: { amountInvalidBody },
    sessions: { saveSaleProgress: async () => undefined },
    fundsDeferred: false,
    goodsOnly: false,
    fail: (input) => {
      failures.push(input);
      return {
        ok: false,
        code: input.code,
        message: input.message,
        failure_reason: String(input.error?.message || ''),
      };
    },
    userMessageFor: (error) => error?.scanUserMessage || String(error?.message || error || ''),
    positiveAmount: () => ({ ok: false }),
    moneyText: (value) => String(value),
    amountMismatchMessage: () => '',
    amountList: (value) => (Array.isArray(value) ? value.map((item) => String(item)) : []),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'line_amount_invalid');
  assert.equal(result.message, amountInvalidBody);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error.scanUserMessage, amountInvalidBody);
});

test('AC-SS-AMOUNT2 每件实收允许 0（赠送 / 自家穿），仍按 0 元落行', async () => {
  const helpers = makeHelpers();
  assert.deepEqual(helpers.positiveAmount('0', { allowZero: true }), { ok: true, value: 0 });
  assert.deepEqual(helpers.positiveAmount('399.5', { allowZero: true }), { ok: true, value: 399.5 });
  // 收款行 / 实付金额仍要求 > 0（不传 allowZero）
  assert.equal(helpers.positiveAmount('0').ok, false);

  const result = await resolveSaleSettlement({
    lines: [{ amount: 0 }],
    lineAmounts: ['0'],
    paymentRows: [],
    paymentStatus: '未付',
    paidAmount: '',
    openId: 'ou_test',
    sessionId: 'session_test',
    key: 'submit_key',
    requestId: 'req_test',
    config: settlementConfig(),
    texts: {},
    sessions: { saveSaleProgress: async () => undefined },
    fundsDeferred: false,
    goodsOnly: false,
    fail: helpers.fail,
    userMessageFor: helpers.userMessageFor,
    positiveAmount: helpers.positiveAmount,
    toCents: helpers.toCents,
    moneyText: helpers.moneyText,
    amountMismatchMessage: helpers.amountMismatchMessage,
    amountList: helpers.amountList,
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolvedLines[0].amount, 0);
  assert.equal(result.resolvedLines[0].explicit_amount, true, '0 是显式填的，不是"没填"');
  assert.equal(result.owedCents, 0, '0 元单不产生未收款');
});

test('AC-SS-AMOUNT3 付款状态非法时给人话，不抛 current is not defined', async () => {
  const helpers = makeHelpers();
  const result = await resolveSaleSettlement({
    lines: [{ amount: 100 }],
    lineAmounts: ['100'],
    paymentRows: [],
    paymentStatus: '乱填的档位',
    paidAmount: '',
    openId: 'ou_test',
    sessionId: 'session_test',
    key: 'submit_key',
    requestId: 'req_test',
    config: settlementConfig(),
    texts: { paymentStatusInvalidBody: '付款情况不对' },
    sessions: { saveSaleProgress: async () => undefined },
    fundsDeferred: false,
    goodsOnly: false,
    fail: helpers.fail,
    userMessageFor: helpers.userMessageFor,
    positiveAmount: helpers.positiveAmount,
    toCents: helpers.toCents,
    moneyText: helpers.moneyText,
    amountMismatchMessage: helpers.amountMismatchMessage,
    amountList: helpers.amountList,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'payment_status_invalid');
  assert.equal(result.message, '付款情况不对');
});
