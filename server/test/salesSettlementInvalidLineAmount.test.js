'use strict';

/**
 * 回归：行金额非法时，结算层必须返回 `line_amount_invalid` + 人话。
 *
 * 线上事故（XSD-20261118-0001，2026-11-18 09:50）：`salesSettlement.js` 的非法金额分支
 * 引用了未声明的 `message` ⇒ 后台抛 ReferenceError `message is not defined`，
 * 真实的「金额无效」人话被吞掉，销售 job 直接失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSaleSettlement } = require('../src/services/scanWrite/salesSettlement');

test('AC-SS-AMOUNT1 非法行金额 ⇒ line_amount_invalid，不抛 message is not defined', async () => {
  const failures = [];
  const amountInvalidBody = '每一双的实收金额必须大于 0';
  const result = await resolveSaleSettlement({
    lines: [{ amount: 0 }],
    lineAmounts: ['0'],
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
