'use strict';

/**
 * ⭐⭐ 2026-10-14：付款方式**读「交易方式管理」表**（她：「付款方式用支付方式管理，可选择」）
 *
 *   AC-PM1 ⭐ 选项**来自那张表**（表里加一条 ⇒ 这里自动多一个 ✓ 能真红 ✓）
 *   AC-PM2 ⭐ 读不到 ⇒ `ok:false` + 原因（**不静默兜底** ✗）
 *   AC-PM3 ⭐ **去重、去空、按销售额降序（同额按表顺序）** ✓
 *   AC-PM4 ⭐ TTL 内**只读一次上游**（第二次是缓存 ✓）；TTL 由统一注册表给 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPaymentMethodsService } = require('../src/services/paymentMethodsService');
const { invalidateConfigTable } = require('../src/services/configTableCache');
const { CONFIG_TABLES } = require('../src/config/configTables');

const gatewayOf = (values, calls = { n: 0 }) => ({
  listAll: async () => { calls.n += 1; return values.map((v, i) => ({ record_id: `pm${i}`, fields: { 交易方式: v } })); },
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

test('AC-PM4 ⭐ TTL 内只读一次上游；TTL 由统一注册表给', async () => {
  const calls = { n: 0 };
  let clock = 1000;
  const service = createPaymentMethodsService(gatewayOf(['微信'], calls), { now: () => clock });
  await service.list();
  await service.list();
  assert.equal(calls.n, 1, '第二次命中缓存 ⇒ 上游只读一次');
  clock += CONFIG_TABLES.paymentMethod.ttlMs + 1;
  await service.list();
  assert.equal(calls.n, 2, '过期后重读');
});

test('AC-PM5 ⭐ 按「销售额」降序；空/非数字按 0，同额按表记录顺序', async () => {
  const rows = [
    { record_id: 'a', fields: { 交易方式: '支付宝', 销售额: 300 } },
    { record_id: 'b', fields: { 交易方式: '微信扫码', 销售额: 8217 } },
    { record_id: 'c', fields: { 交易方式: '现金', 销售额: '1,126' } },
    { record_id: 'd', fields: { 交易方式: '无销售额' } },
    { record_id: 'e', fields: { 交易方式: '非数字', 销售额: 'x' } },
    { record_id: 'f', fields: { 交易方式: '抖音代金券（89.9）', 销售额: 341.6 } },
  ];
  const service = createPaymentMethodsService({ listAll: async () => rows });
  const out = await service.list();
  assert.deepEqual(out.items, ['微信扫码', '现金', '抖音代金券（89.9）', '支付宝', '无销售额', '非数字'],
    '严格按销售额降序，0/空值按表记录顺序');
});

test('AC-PM6 ⭐ 配置表事件失效：invalidate 后下一次读立即拿新值（不再被外层 cache 挡住）', async () => {
  const values = ['微信'];
  const calls = { n: 0 };
  const gateway = {
    listAll: async () => { calls.n += 1; return values.map((value, index) => ({ record_id: `pm${index}`, fields: { 交易方式: value } })); },
  };
  const service = createPaymentMethodsService(gateway);
  const first = await service.list();
  assert.deepEqual(first.items, ['微信']);
  values[0] = '现金';
  await service.list();
  assert.deepEqual((await service.list()).items, ['微信'], 'TTL 内仍是旧快照');
  invalidateConfigTable('paymentMethod');
  assert.deepEqual((await service.list()).items, ['现金'], '事件失效后立即重读');
  assert.equal(calls.n, 2, '只多读一次');
});

test('AC-PM7 ⭐ 「是否启用」列存在时：未勾选的方式不出现在候选', async () => {
  const rows = [
    { record_id: 'a', fields: { 交易方式: '支付宝', 是否启用: true } },
    { record_id: 'b', fields: { 交易方式: '微信', 是否启用: false } },
    { record_id: 'c', fields: { 交易方式: '现金', 是否启用: true } },
  ];
  const service = createPaymentMethodsService({ listAll: async () => rows });
  const out = await service.list();
  assert.deepEqual(out.items, ['支付宝', '现金'], '未勾选「是否启用」的方式被过滤');
});

test('AC-PM8 ⭐ 「是否启用」列不存在时保持旧行为（全部可用）', async () => {
  const rows = [
    { record_id: 'a', fields: { 交易方式: '支付宝' } },
    { record_id: 'b', fields: { 交易方式: '微信' } },
  ];
  const service = createPaymentMethodsService({ listAll: async () => rows });
  const out = await service.list();
  assert.deepEqual(out.items, ['支付宝', '微信'], '旧表没有该列 ⇒ 不误过滤');
});
// payment method schema sync 2026-11-10
