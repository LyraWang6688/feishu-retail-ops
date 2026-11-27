'use strict';
// 入库继承当季：判据只有一份（seasonForNewRows）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { seasonForNewRows, productSeasonField } = require('../src/services/inventory/seasonInheritance');
const { INVENTORY_SEASON } = require('../src/config/inventorySeason');

const gatewayOf = (products, { fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    async getBatch(tableKey, ids, options = {}) {
      calls.push({ tableKey, ids, options });
      if (fail) throw new Error('feishu down');
      return (products || []).filter((row) => ids.includes(row.record_id));
    },
  };
};
const product = (id, label) => ({ record_id: id, fields: { 当季: label } });

test('AC-SI0 schema 只读字段名来自 schema（不写死）', () => {
  assert.equal(productSeasonField(), '当季');
});

test('AC-SI1 货品当季=是 ⇒ true（不论有没有库存）', async () => {
  const gateway = gatewayOf([product('p1', '是')]);
  const map = await seasonForNewRows({ gateway, products: [{ productRecordId: 'p1', hasLiveRows: true }] });
  assert.equal(map.get('p1'), true);
  const empty = await seasonForNewRows({ gateway, products: [{ productRecordId: 'p1', hasLiveRows: false }] });
  assert.equal(empty.get('p1'), true);
});

test('AC-SI2 当季=否 + 还有库存 ⇒ 不写（undefined）', async () => {
  const gateway = gatewayOf([product('p1', '否')]);
  const map = await seasonForNewRows({ gateway, products: [{ productRecordId: 'p1', hasLiveRows: true }] });
  assert.equal(map.get('p1'), undefined);
});

test('AC-SI3 当季=否 + 实时库存 0 行 ⇒ true（首次入库/售罄回补）', async () => {
  const gateway = gatewayOf([product('p1', '否')]);
  const map = await seasonForNewRows({ gateway, products: [{ productRecordId: 'p1', hasLiveRows: false }] });
  assert.equal(map.get('p1'), true);
});

test('AC-SI4 一批多货品：一次 getBatch、各自判断', async () => {
  const gateway = gatewayOf([product('p1', '是'), product('p2', '否')]);
  const map = await seasonForNewRows({
    gateway,
    products: [{ productRecordId: 'p1', hasLiveRows: true }, { productRecordId: 'p2', hasLiveRows: true }],
  });
  assert.equal(map.get('p1'), true);
  assert.equal(map.get('p2'), undefined);
  assert.equal(gateway.calls.length, 1, '一批只读一次货品');
  assert.deepEqual(gateway.calls[0].ids.sort(), ['p1', 'p2']);
  assert.equal(gateway.calls[0].options.retry, INVENTORY_SEASON.readRetry, '复用关键读重试配置');
});

test('AC-SI5 读失败（重试耗尽）⇒ 全部不写，不抛错', async () => {
  const gateway = gatewayOf([], { fail: true });
  const map = await seasonForNewRows({ gateway, products: [{ productRecordId: 'p1', hasLiveRows: false }] });
  assert.equal(map.get('p1'), undefined);
});

test('AC-SI6 货品记录不存在 ⇒ 不写，不抛错', async () => {
  const gateway = gatewayOf([]);
  const map = await seasonForNewRows({ gateway, products: [{ productRecordId: 'missing', hasLiveRows: false }] });
  assert.equal(map.get('missing'), undefined);
});
