'use strict';

/** 券行的收款金额可空（后端按「平台结算款」写）；普通收款行仍必填。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentRowsHtml } = require('../src/views/scanPage/paymentBlock');

const write = (voucherMethods) => ({
  texts: { paymentLabel: '收款方式', paymentAmountPlaceholder: '金额', paymentAmountLabel: '收款金额', voucherFaceHint: '面值 {face} · 平台结算 {settlement}' },
  fields: { paymentMethod: 'payment_method', paymentAmount: 'payment_amount' },
  paymentMethods: ['支付宝', '抖音代金券（89.9）'],
  voucherMethods,
  voucherDetails: voucherMethods.map((name) => ({ name, faceValueCents: 10000, settlementCents: 8540 })),
  paymentRows: [
    { method: '支付宝', amount: '158' },
    { method: '抖音代金券（89.9）', amount: '' },
  ],
});

const rowsOf = (html) => html.split('<div class="form-row form-row--pay">').slice(1);
const rowOf = (html, index) => rowsOf(html)[index] || '';

test('AC-VP-AMOUNT-1 资金页金额不在客户端 required（服务端再校验普通行）', () => {
  const html = paymentRowsHtml(write(['抖音代金券（89.9）']));
  const alipay = rowOf(html, 0);
  const voucher = rowOf(html, 1);
  assert.doesNotMatch(alipay, /<input[^>]*\brequired\b/, '普通行不在客户端 required，由服务端拦');
  assert.doesNotMatch(voucher, /<input[^>]*\brequired\b/, '券行金额可以空，不许 required');
});

test('AC-VP-AMOUNT-2 没有券方式清单时也不在客户端 required（服务端仍校验）', () => {
  const html = paymentRowsHtml(write([]));
  assert.doesNotMatch(rowOf(html, 0), /<input[^>]*\brequired\b/);
});

test('AC-VP-AMOUNT-3 未选方式的空行不 required（她随后选券不会被卡），券行显示面值/结算款', () => {
  const w = write(['抖音代金券（89.9）']);
  w.paymentRows = [
    { method: '支付宝', amount: '158' },
    { method: '', amount: '' },
  ];
  const html = paymentRowsHtml(w);
  const blank = rowOf(html, 1);
  assert.doesNotMatch(blank, /<input[^>]*\brequired\b/, '空行选券前也不许 required');
});

test('AC-VP-AMOUNT-4 已选券行不 required，且显示面值提示', () => {
  const html = paymentRowsHtml(write(['抖音代金券（89.9）']));
  const voucher = rowOf(html, 1);
  assert.doesNotMatch(voucher, /<input[^>]*\brequired\b/);
  assert.match(html, /面值 ¥100 · 平台结算 ¥85.4/);
});
