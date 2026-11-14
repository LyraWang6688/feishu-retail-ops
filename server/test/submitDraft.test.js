'use strict';

/**
 * #48：扫码销售提交上下文的**服务层单测**（2026-11-14 从 handler 搬出）。
 *   AC-SD-1 每件实收回落链：body → 会话草稿行 → 一单一笔的 fields.amount
 *   AC-SD-2 submitPending 原样存（尺码/金额/赠品/收款行/付款情况/实付），不再存第二份逐件实收
 *   AC-SD-3 prepareSubmitDraft：先写会话状态标记（paymentStep=pending / status=draft），再返回上下文
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveLineAmounts, buildSubmitPending, prepareSubmitDraft,
} = require('../src/services/scanWrite/submitDraft');

const fields = {
  lineAmount: 'line_amount', amount: 'amount', size: 'size', gift: 'gift',
  paymentStatus: 'payment_status', paidAmount: 'paid_amount',
};
const asList = (value) => (Array.isArray(value) ? value : (value === undefined ? [] : [value]));
const parsePaymentRows = (body, f) => asList(body[f.amount]).map((amount) => ({ amount }));

test('AC-SD-1 回落链：body → 草稿行 → 单行', () => {
  const bodyValues = resolveLineAmounts({ body: { line_amount: ['150', '130'] }, fields, asList, draftLines: [] });
  assert.deepEqual(bodyValues.lineAmounts, ['150', '130']);
  const draft = resolveLineAmounts({ body: {}, fields, asList, draftLines: [{ amount: '240' }] });
  assert.deepEqual(draft.lineAmounts, ['240']);
  const single = resolveLineAmounts({ body: { amount: '99' }, fields, asList, draftLines: [] });
  assert.deepEqual(single.lineAmounts, ['99']);
  const empty = resolveLineAmounts({ body: {}, fields, asList, draftLines: [] });
  assert.deepEqual(empty.lineAmounts, []);
});

test('AC-SD-2 submitPending 原样存、不存第二份逐件实收', () => {
  const pending = buildSubmitPending({
    body: { size: '40', amount: '99', gift: '袜子', payment_status: '全付', paid_amount: '99' },
    fields,
    parsePaymentRows,
  });
  assert.deepEqual(pending, {
    size: '40', amount: '99', gift: '袜子', payments: [{ amount: '99' }], paymentStatus: '全付', paidAmount: '99',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(pending, 'lineAmounts'), false);
});

test('AC-SD-3 先写状态标记再返回上下文', async () => {
  const saved = [];
  const writeService = {
    sessions: { get: async () => ({ sale: { lines: [{ amount: '240' }], paymentStep: 'pending' } }) },
    saveDraftLines: async (openId, payload) => { saved.push({ openId, payload }); },
  };
  const writeConfig = { session: { statuses: { draft: 'draft' } } };
  const out = await prepareSubmitDraft({
    writeService, openId: 'ou_1', body: { amount: '240' }, fields,
    asList, parsePaymentRows, writeConfig,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].payload.paymentStep, 'pending');
  assert.equal(saved[0].payload.status, 'draft');
  assert.equal(saved[0].payload.lines.length, 1);
  assert.deepEqual(out.lineAmounts, ['240']);
  assert.deepEqual(out.payments, [{ amount: '240' }]);
  assert.equal(out.submitSession.sale.paymentStep, 'pending');
});
