'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inboundStatesFor,
  explicitInboundStates,
  outboundStateRank,
} = require('../src/config/inventoryStatePolicy');

test('AC-SP1 入库状态计划：同编号任何库存都没有 ⇒ 第一双样品，其余门盒', () => {
  assert.deepEqual(inboundStatesFor({ existingTotal: 0, quantity: 3 }), ['样品', '门盒', '门盒']);
  assert.deepEqual(inboundStatesFor({ existingTotal: 0, quantity: 1 }), ['样品']);
});

test('AC-SP2 入库状态计划：同编号已有任意库存（含空状态）⇒ 全部门盒', () => {
  assert.deepEqual(inboundStatesFor({ existingTotal: 1, quantity: 3 }), ['门盒', '门盒', '门盒']);
  assert.deepEqual(inboundStatesFor({ existingTotal: 99, quantity: 1 }), ['门盒']);
});

test('AC-SP3 人工调整显式状态：整批按用户选择，不套自动规则', () => {
  assert.deepEqual(explicitInboundStates('样品', 2), ['样品', '样品']);
  assert.deepEqual(explicitInboundStates('门盒', 3), ['门盒', '门盒', '门盒']);
  assert.throws(() => explicitInboundStates('仓库', 1), /库存所属状态无效/);
});

test('AC-SP4 出库优先级：只有「样品」排最后；空状态与门盒同级', () => {
  assert.equal(outboundStateRank('门盒'), 0);
  assert.equal(outboundStateRank(''), 0);
  assert.equal(outboundStateRank(null), 0);
  assert.equal(outboundStateRank('样品'), 1);
});

test('AC-SP5 采购入库判定：同编号只有门盒/空状态也算已有库存 ⇒ 新入库门盒', async () => {
  process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
  process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';
  const arrival = require('../src/services/purchase/arrival');
  const table = { fields: { product: '编号', state: '所属状态' } };
  const gateway = {
    table: () => table,
    listAll: async () => [
      { record_id: 'a', fields: { 编号: [{ record_ids: ['p1'] }], 所属状态: '门盒' } },
      { record_id: 'b', fields: { 编号: [{ record_ids: ['p1'] }], 所属状态: '' } },
    ],
  };
  const state = await arrival.resolvePurchaseInboundState.call({ gateway }, 'p1');
  assert.equal(state, '门盒');
  gateway.listAll = async () => [];
  assert.equal(await arrival.resolvePurchaseInboundState.call({ gateway }, 'p1'), '样品');
  gateway.listAll = async () => [
    { record_id: 'c', fields: { 编号: [{ record_ids: ['p2'] }], 所属状态: '门盒' } },
  ];
  assert.equal(await arrival.resolvePurchaseInboundState.call({ gateway }, 'p1'), '样品');
});
