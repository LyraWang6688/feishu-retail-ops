'use strict';

/**
 * 券目录只读同步（比对，不写表）。
 *
 * AC-VC1 ⭐ 按「券ID === product_id」匹配；名称/售价/面值有差异 ⇒ changed + diffs；
 * AC-VC2 ⭐ 完全一致 ⇒ changed=false；
 * AC-VC3 ⭐ 券表有、抖音没有 ⇒ unmatchedVouchers（不猜、不写）；
 * AC-VC4 ⭐ 抖音有、券表没有 ⇒ unmatchedProducts；
 * AC-VC5 ⭐ 没配 accountId ⇒ ok:false（不请求）；
 * AC-VC6 ⭐ 费率取自**单品详情**（列表里是 0，不准）；
 * AC-VC7 ⭐ 金额换算：'89.9' ↔ 8990 分。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createVoucherCatalogSync, toCents } = require('../src/services/douyin/voucherCatalogSync');

const FIELDS = Object.freeze({
  name: '券名称', purchasePrice: '售价', faceValue: '面值', externalId: '券ID',
});

const ok = (data) => ({ ok: true, data });

const row = (id, { voucherId, name, price, face }) => ({
  record_id: id,
  fields: { [FIELDS.externalId]: voucherId, [FIELDS.name]: name, [FIELDS.purchasePrice]: price, [FIELDS.faceValue]: face },
});

const build = ({ rows = [], products = [], skus = {}, details = {}, config = { accountId: 'acc_1' } } = {}) => {
  const gateway = { table: () => ({ fields: FIELDS }), listAll: async () => rows };
  const laike = {
    fetchProductList: async () => ok({ products }),
    fetchSkus: async ({ productId }) => ok({ skus: skus[productId] || [] }),
    fetchProduct: async ({ productIds }) => ok({ product_onlines: [details[productIds[0]] || {}] }),
  };
  return createVoucherCatalogSync({ gateway, laike, config, logger: { logInfo: () => {}, logWarn: () => {} } });
};

const productOf = (id, name, status = 1) => ({ product: { product_id: id, product_name: name }, online_status: status });

test('AC-VC1 ⭐ 匹配并按名称/售价/面值报差异', async () => {
  const service = build({
    rows: [row('rec_1', { voucherId: '1874371212430344', name: '旧券名', price: '88.80', face: '90' })],
    products: [productOf('1874371212430344', '100元代金券')],
    skus: { 1874371212430344: [{ actual_amount: 8990, origin_amount: 10000 }] },
    details: { 1874371212430344: { commission_info: { platform_take_rate: 500 } } },
  });
  const out = await service.run();
  assert.equal(out.ok, true);
  assert.equal(out.voucherRows, 1);
  assert.equal(out.catalogProducts, 1);
  assert.equal(out.matched, 1, JSON.stringify(out.rows));
  const item = out.rows[0];
  assert.equal(item.changed, true);
  assert.equal(item.diffs.name.to, '100元代金券');
  assert.equal(item.diffs.priceCents.from, 8880);
  assert.equal(item.diffs.priceCents.to, 8990);
  assert.equal(item.diffs.faceCents.from, 9000);
  assert.equal(item.diffs.faceCents.to, 10000);
  assert.equal(item.commissionRate, 500);
});

test('AC-VC2 ⭐ 完全一致 ⇒ changed=false', async () => {
  const service = build({
    rows: [row('rec_1', { voucherId: 'p1', name: '100元代金券', price: '89.9', face: '100' })],
    products: [productOf('p1', '100元代金券')],
    skus: { p1: [{ actual_amount: 8990, origin_amount: 10000 }] },
    details: { p1: { commission_info: { platform_take_rate: 500 } } },
  });
  const out = await service.run();
  assert.equal(out.matched, 0);
  assert.equal(out.unchanged, 1);
});

test('AC-VC3 ⭐ 券表有、抖音没有 ⇒ unmatchedVouchers', async () => {
  const service = build({ rows: [row('rec_1', { voucherId: 'missing', name: 'X', price: '1', face: '1' })], products: [] });
  const out = await service.run();
  assert.equal(out.unmatchedVouchers.length, 1);
  assert.equal(out.unmatchedVouchers[0].voucherId, 'missing');
});

test('AC-VC4 ⭐ 抖音有、券表没有 ⇒ unmatchedProducts', async () => {
  const service = build({
    rows: [],
    products: [productOf('p_only_douyin', '新券')],
    skus: { p_only_douyin: [{ actual_amount: 100, origin_amount: 200 }] },
  });
  const out = await service.run();
  assert.equal(out.unmatchedProducts.length, 1);
  assert.equal(out.unmatchedProducts[0].productId, 'p_only_douyin');
});

test('AC-VC5 ⭐ 没配 accountId ⇒ 不请求', async () => {
  let called = 0;
  const service = createVoucherCatalogSync({
    gateway: { table: () => ({ fields: FIELDS }), listAll: async () => [] },
    laike: { fetchProductList: async () => { called += 1; return ok({ products: [] }); } },
    config: { accountId: '', texts: {} },
    logger: { logInfo: () => {}, logWarn: () => {} },
  });
  const out = await service.run();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'account_missing');
  assert.equal(called, 0);
});

test('AC-VC6 ⭐ 费率取自单品详情（500 = 5%）', async () => {
  const service = build({
    rows: [],
    products: [productOf('p1', '券')],
    skus: { p1: [{ actual_amount: 8990, origin_amount: 10000 }] },
    details: { p1: { commission_info: { platform_take_rate: 500, commission_detail_list: [{ app_name: '抖省省', commission_rate: 500 }] } } },
  });
  const out = await service.run();
  assert.equal(out.unmatchedProducts[0].commissionRate, 500);
  assert.equal(out.unmatchedProducts[0].commissionDetail.length, 1);
});

test('AC-VC7 ⭐ 金额换算', () => {
  assert.equal(toCents('89.9'), 8990);
  assert.equal(toCents('89.90'), 8990);
  assert.equal(toCents('100'), 10000);
  assert.equal(toCents(''), null);
});

test('AC-VC8 ⭐ 上架/下架日期只报差异（readOnly），名称空也算差异', async () => {
  const F = { ...FIELDS, listedAt: '上架日期', delistedAt: '下架日期' };
  const gateway = {
    table: () => ({ fields: F }),
    listAll: async () => [{
      record_id: 'rec_1',
      fields: { '券ID': 'p1', '券名称': '', '售价': '49.9', '面值': '100', '上架日期': Date.UTC(2026, 7, 23, 4), '下架日期': null },
    }],
  };
  const laike = {
    fetchProductList: async () => ok({ products: [{ product: { product_id: 'p1', product_name: '100元代金券', sold_start_time: Date.UTC(2026, 7, 24) / 1000, sold_end_time: Date.UTC(2026, 9, 26) / 1000 }, online_status: 1 }] }),
    fetchSkus: async () => ok({ skus: [{ actual_amount: 4990, origin_amount: 10000 }] }),
    fetchProduct: async () => ok({ product_onlines: [{ commission_info: { platform_take_rate: 500 } }] }),
  };
  const out = await createVoucherCatalogSync({ gateway, laike, config: { accountId: 'a', texts: {} }, logger: { logInfo: () => {}, logWarn: () => {} } }).run();
  const item = out.rows[0];
  assert.equal(item.changed, true);
  assert.equal(item.diffs.name.to, '100元代金券');
  assert.deepEqual(item.diffs.listedDay, { from: '2026-08-23', to: '2026-08-24', readOnly: true });
  assert.deepEqual(item.diffs.delistedDay, { from: '', to: '2026-10-26', readOnly: true });
});
