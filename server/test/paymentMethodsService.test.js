'use strict';

/**
 * ⭐⭐ 2026-10-14：付款方式**读「收款方式管理」表**（她：「付款方式用交易方式管理，可选择」）
 *
 *   AC-PM1 ⭐ 选项**来自那张表**（表里加一条 ⇒ 这里自动多一个 ✓ 能真红 ✓）
 *   AC-PM2 ⭐ 读不到 ⇒ `ok:false` + 原因（**不静默兜底** ✗）
 *   AC-PM3 ⭐ **去重、去空、按表里的顺序** ✓
 *   AC-PM4 ⭐ TTL 内**只读一次上游**（第二次是缓存 ✓）；`ttlMs<=0` = 关缓存 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPaymentMethodsService } = require('../src/services/paymentMethodsService');

const gatewayOf = (values, calls = { n: 0 }) => ({
  listAll: async () => { calls.n += 1; return values.map((v, i) => ({ record_id: `pm${i}`, fields: { 收款方式: v } })); },
});

test('AC-PM1/AC-PM3 ⭐ 选项来自表 · 去重去空 · 顺序照表', async () => {
  const service = createPaymentMethodsService(gatewayOf(['支付宝', '微信', '', '微信', '抖音代金券（89.9）', '工商银行']));
  const out = await service.list();
  assert.equal(out.ok, true);
  assert.deepEqual(out.items, ['支付宝', '微信', '抖音代金券（89.9）', '工商银行'], '去重去空、顺序照表');
});

test('AC-PM2 ⭐ 读不到 ⇒ ok:false + 原因（绝不静默兜底）', async () => {
  const service = createPaymentMethodsService({ listAll: async () => { throw new Error('boom'); } });
  const out = await service.list();
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'payment_methods_unreadable');
  assert.deepEqual(out.items, [], '不给兜底列表（不然她会以为读到了）');
});

test('AC-PM4 ⭐ TTL 内只读一次上游；可关缓存', async () => {
  const calls = { n: 0 };
  let clock = 1000;
  const service = createPaymentMethodsService(gatewayOf(['微信'], calls), { ttlMs: 5000, now: () => clock });
  await service.list();
  await service.list();
  assert.equal(calls.n, 1, '第二次命中缓存 ⇒ 上游只读一次');
  clock += 5001;
  await service.list();
  assert.equal(calls.n, 2, '过期后重读');

  const calls2 = { n: 0 };
  const off = createPaymentMethodsService(gatewayOf(['微信'], calls2), { ttlMs: 0 });
  await off.list();
  await off.list();
  assert.equal(calls2.n, 2, 'ttlMs=0 ⇒ 关缓存，每次都读');
});
