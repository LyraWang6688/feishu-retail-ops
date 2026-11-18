'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inboundStatesFor,
  explicitInboundStates,
  outboundStateRank,
} = require('../src/config/inventoryStatePolicy');

test('AC-SP1 非采购增加（如销售退货回库）仍用通用兜底：没有库存 ⇒ 第一双样品', () => {
  assert.deepEqual(inboundStatesFor({ existingTotal: 0, quantity: 3 }), ['样品', '门盒', '门盒']);
  assert.deepEqual(inboundStatesFor({ existingTotal: 1, quantity: 2 }), ['门盒', '门盒']);
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


