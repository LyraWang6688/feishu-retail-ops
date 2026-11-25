'use strict';

// 人员列（飞书 field type 11）取值：订单卡第二行「录单人 / 售后人」共用这一份。
// 依据：2026-11-25 在生产 Base 只读实测 —— GET list 与 POST batch_get 返回**同一个形状**
//   `[{ id, name, en_name, email }]`；old batch 形状偶尔再包一层 `{ type: 11, value: [...] }`。
const test = require('node:test');
const assert = require('node:assert/strict');
const { personText } = require('../src/services/v1BitableGateway');

test('AC-PT1 人员列：多人用「、」连，同名去重', () => {
  assert.equal(personText([{ id: 'ou_a', name: '赵瑞玲' }]), '赵瑞玲');
  assert.equal(personText([{ name: '王颖' }, { name: '邯美皮鞋2号' }]), '王颖、邯美皮鞋2号');
  assert.equal(personText([{ name: '王颖' }, { name: '王颖' }]), '王颖', '同一个人不重复展示');
});

test('AC-PT2 批量读的包一层形状 { type: 11, value: [...] } 也能解', () => {
  assert.equal(personText([{ type: 11, value: [{ name: '王颖' }, { name: '赵瑞玲' }] }]), '王颖、赵瑞玲');
});

test('AC-PT3 空 / 认不出 ⇒ 空串，绝不拿 ou_xxx 顶替', () => {
  assert.equal(personText(null), '');
  assert.equal(personText([]), '');
  assert.equal(personText(undefined), '');
  assert.equal(personText([{ id: 'ou_a' }]), '', '只有 id 没有名字 ⇒ 不显示');
  assert.equal(personText([{ name: '  ' }]), '', '空白名字不占位');
});
