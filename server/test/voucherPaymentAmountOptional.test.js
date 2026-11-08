'use strict';

/** 券行的收款金额可空（后端按「平台结算款」写）；普通收款行仍必填。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentRowsHtml } = require('../src/views/scanPage/paymentBlock');

const write = (voucherMethods) => ({
  texts: { paymentLabel: '收款方式', paymentAmountPlaceholder: '金额', paymentAmountLabel: '收款金额' },
  fields: { paymentMethod: 'payment_method', paymentAmount: 'payment_amount' },
  paymentMethods: ['支付宝', '抖音代金券（89.9）'],
  voucherMethods,
  paymentRows: [
    { method: '支付宝', amount: '158' },
    { method: '抖音代金券（89.9）', amount: '' },
  ],
});

const rowsOf = (html) => html.split('<div class="form-row form-row--pay">').slice(1);
const rowOf = (html, index) => rowsOf(html)[index] || '';

test('AC-VP-AMOUNT-1 券行金额不 required，普通收款行仍 required', () => {
  const html = paymentRowsHtml(write(['抖音代金券（89.9）']));
  const alipay = rowOf(html, 0);
  const voucher = rowOf(html, 1);
  assert.match(alipay, /<input[^>]*\brequired\b/, '支付宝行必须 required');
  assert.doesNotMatch(voucher, /<input[^>]*\brequired\b/, '券行金额可以空，不许 required');
});

test('AC-VP-AMOUNT-2 没有券方式清单时，所有行仍 required（不误豁免）', () => {
  const html = paymentRowsHtml(write([]));
  assert.match(rowOf(html, 1), /<input[^>]*\brequired\b/);
});
