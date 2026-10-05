const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseUnitCost,
  isBlankCost,
  costValueOf,
  buildArrivalCostPlan,
} = require('../src/services/arrivalCostPolicy');

// ─── 单据价格 → 正数单件价 ───

test('到货单价解析：数字、带货币符号/单位/千分位的字符串都认', () => {
  assert.equal(parseUnitCost(199), 199);
  assert.equal(parseUnitCost(199.5), 199.5);
  assert.equal(parseUnitCost('199'), 199);
  assert.equal(parseUnitCost(' ￥199.00 '), 199);
  assert.equal(parseUnitCost('¥199元/双'), 199);
  assert.equal(parseUnitCost('1,299'), 1299);
});

test('到货单价解析：转不成正数的一律不认（宁可这次不写成本）', () => {
  assert.equal(parseUnitCost(null), null);
  assert.equal(parseUnitCost(undefined), null);
  assert.equal(parseUnitCost(''), null);
  assert.equal(parseUnitCost('   '), null);
  assert.equal(parseUnitCost('面议'), null);
  assert.equal(parseUnitCost('—'), null);
  assert.equal(parseUnitCost('元/双'), null);
  assert.equal(parseUnitCost(0), null);
  assert.equal(parseUnitCost('0'), null);
  assert.equal(parseUnitCost(-5), null);
  // 区间写法（199-299）不能取一端当单价
  assert.equal(parseUnitCost('199-299'), null);
  assert.equal(parseUnitCost('1.2.3'), null);
  assert.equal(parseUnitCost(true), null);
  assert.equal(parseUnitCost({}), null);
});

// ─── 已有成本的判定 ───

test('已有成本判定：null/空串/空数组算空，数字 0 不算空（她可能就是特意填 0）', () => {
  assert.equal(isBlankCost(null), true);
  assert.equal(isBlankCost(undefined), true);
  assert.equal(isBlankCost(''), true);
  assert.equal(isBlankCost('   '), true);
  assert.equal(isBlankCost([]), true);
  assert.equal(isBlankCost([{ text: '' }]), true);

  assert.equal(isBlankCost(0), false);
  assert.equal(isBlankCost('0'), false);
  assert.equal(isBlankCost(199), false);
  assert.equal(isBlankCost([{ text: '199' }]), false);
});

test('已有成本抽数字：飞书文本单元格形态也能比对', () => {
  assert.equal(costValueOf(199), 199);
  assert.equal(costValueOf('￥199'), 199);
  assert.equal(costValueOf([{ text: '199' }]), 199);
  assert.equal(costValueOf('不是数字'), null);
  assert.equal(costValueOf(null), null);
});

// ─── 按货号汇总 ───

test('价格计划：只有部分行有价格时，只给有价格的货号建计划', () => {
  const plan = buildArrivalCostPlan([
    { item_no: '1366-31', color: '棕色', size: 36, quantity: 1, unit_cost: 199 },
    { item_no: '1366-31', color: '棕色', size: 37, quantity: 2, unit_cost: 199 },
    { item_no: '8088', color: '灰色', size: 38, quantity: 1 }, // 单据上没有价格列
  ]);
  assert.equal(plan.size, 1);
  assert.deepEqual(plan.get('1366-31'), { item_no: '1366-31', cost: 199, conflict: false, prices: [199] });
  assert.equal(plan.has('8088'), false, '没有价格的行不能凭空造一个成本');
});

test('价格计划：同一货号多行价格不一致 → conflict，不给可写值', () => {
  const plan = buildArrivalCostPlan([
    { item_no: '1366-31', unit_cost: '￥199' },
    { item_no: '1366-31', unit_cost: 209 },
  ]);
  const entry = plan.get('1366-31');
  assert.equal(entry.conflict, true);
  assert.equal(entry.cost, null, '价格不一致时不能挑一个写下去');
  assert.deepEqual(entry.prices, [199, 209]);
});

test('价格计划：同货号多行价格相同算一致（重复行是常态）', () => {
  const plan = buildArrivalCostPlan([
    { item_no: '1366-31', unit_cost: '199' },
    { item_no: '1366-31', unit_cost: 199 },
    { item_no: '1366-31', unit_cost: '￥199.00' },
  ]);
  assert.deepEqual(plan.get('1366-31'), { item_no: '1366-31', cost: 199, conflict: false, prices: [199] });
});

test('价格计划：非法价格和缺货号的行直接跳过', () => {
  const plan = buildArrivalCostPlan([
    { item_no: '', unit_cost: 199 },
    { item_no: '1366-31', unit_cost: '面议' },
    { item_no: '1366-31', unit_cost: 0 },
    null,
  ]);
  assert.equal(plan.size, 0);
  assert.deepEqual(buildArrivalCostPlan(null).size, 0);
});
