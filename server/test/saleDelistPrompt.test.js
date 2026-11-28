'use strict';

// 卖完下架确认（2026-11-26 业务负责人定稿）：
//   · 时点 = 货品页点【提交这一单】；判据 = 页面快照 − 本单数量（不查库存表）；
//   · 按 recordId 去重、多款逐个勾选；确认后再进资金页 / 0 元直达。
// 本文件钉住：货品页不再有前端判断、确认层由服务端渲染、资金页只负责带 ids。
const test = require('node:test');
const assert = require('node:assert/strict');
const { saleFormHtml } = require('../src/views/scanPage/paymentBlock');
const { renderSalePaymentStepPage } = require('../src/views/scanPage/index');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { soldOutCandidates, saleItemsOf } = require('../src/services/stockDelistCandidates');

const VIEW = { number: 'XHB1|黑|男', item_no: 'XHB1', color: '黑', rows: [{ size_text: '38', total: 1 }], columns: [], total: 1 };
const writeOf = (extra = {}) => ({ ...SCAN_WRITE, draft: { lines: [] }, postAction: '/r/rec1', saleKey: 'k', ...extra });

test('AC-DP1 货品页：删掉前端下架判断，只带页面库存快照', () => {
  const html = saleFormHtml(VIEW, writeOf());
  assert.equal(html.includes('data-delist-product-id'), false, '\u4e0d\u5141\u8bb8\u56de\u5230\u524d\u7aef\u5224\u65ad');
  assert.equal(html.includes('data-delist-sale-qty'), false);
  assert.match(html, /name="stock_snapshot" value="1"/, '\u9875\u9762\u5feb\u7167\u8981\u968f\u8868\u5355\u5e26\u56de\u53bb');
});

test('AC-DP2 确认层：逐 recordId 一行、默认勾选、回显原提交、两个按钮', () => {
  const html = saleFormHtml(VIEW, writeOf({
    delistConfirm: {
      candidates: [{ productRecordId: 'recA', number: '3002|黄', qty: 1, snapshotCount: 1 }],
      body: { action: 'submit_order', submit_key: 'k', size: '38', amount: '100' },
    },
  }));
  assert.match(html, /data-delist-confirm/, '\u8981\u6709\u786e\u8ba4\u5c42');
  assert.match(html, /name="delist_pick" value="recA" checked/, '\u9ed8\u8ba4\u5168\u9009');
  assert.match(html, /name="delist_picked" value="recA"/, '\u9690\u85cf\u5df2\u9009\u5217\u8868\u8981\u5e26\u4e0a');
  assert.match(html, /data-view="delist-confirm-picked"/, '\u786e\u8ba4\u5c42\u8981\u6709\u540c\u6b65\u5c0f\u811a\u672c');
  assert.match(html, /name="delist_confirmed" value="1"/);
  assert.match(html, /value="confirm"/);
  assert.match(html, /value="skip"/);
  assert.match(html, /name="size" value="38"/, '\u56de\u663e\u539f\u63d0\u4ea4\u7684\u5b57\u6bb5');
  assert.match(html, /name="amount" value="100"/);
});

test('AC-DP3 没有候选 ⇒ 不渲染确认层', () => {
  const html = saleFormHtml(VIEW, writeOf({ delistConfirm: { candidates: [], body: {} } }));
  assert.equal(html.includes('data-delist-confirm'), false);
});

test('AC-DP4 资金页：只把货品页确认过的 ids 原样带下去，不再自己算候选', () => {
  const html = renderSalePaymentStepPage({
    write: {
      texts: {}, fields: {},
      paymentRows: [{ method: '微信', amount: '' }],
      paymentMethods: ['微信'], defaultPaymentMethod: '微信',
      draft: { lines: [{ product_record_id: 'recA', stock_total: 1 }] },
      delistProductIds: ['recA'],
    },
    orderNo: 'XSD-TEST-1', postAction: '/r/TEST', submitKey: 'k', count: 1,
  });
  assert.match(html, /name="delist_product_ids" value="recA"/);
  assert.equal(html.includes('data-delist-product-ids'), false, '\u8d44\u91d1\u9875\u4e0d\u518d\u505a\u7b2c\u4e8c\u5957\u5224\u65ad');
});

test('AC-DP5 saleItemsOf：同 recordId 多行合并、已在草稿不再加本次这一双', () => {
  const items = saleItemsOf({
    lines: [{ product_record_id: 'recA', stock_total: 2 }, { product_record_id: 'recA', stock_total: 2 }],
    current: { productRecordId: 'recA', snapshotCount: 2 },
    alreadyInDraft: true,
  });
  const candidates = soldOutCandidates(items);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].qty, 2);
  const fresh = soldOutCandidates(saleItemsOf({
    lines: [], current: { productRecordId: 'recB', snapshotCount: 1 }, alreadyInDraft: false,
  }));
  assert.deepEqual(fresh.map((c) => c.productRecordId), ['recB']);
});
