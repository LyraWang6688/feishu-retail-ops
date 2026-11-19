'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dateRangeFormula } = require('../src/services/bitableFilterFormula');

test('AC-DF1 当天：>=TODAY() 且 <TODAY()+1', () => {
  assert.equal(
    dateRangeFormula('创建时间', '2026-11-19', '2026-11-19', '2026-11-19'),
    'AND(CurrentValue.[创建时间]>=TODAY(),CurrentValue.[创建时间]<TODAY()+1)',
  );
});

test('AC-DF2 历史区间：结束日次日作为上界，包含结束日', () => {
  assert.equal(
    dateRangeFormula('销售日', '2026-11-17', '2026-11-18', '2026-11-19'),
    'AND(CurrentValue.[销售日]>=TODAY()-2,CurrentValue.[销售日]<TODAY())',
  );
});

test('AC-DF3 非法日期 / 未来日期 / 反序 ⇒ null（回退整表）', () => {
  assert.equal(dateRangeFormula('创建时间', '2026-11-20', '2026-11-20', '2026-11-19'), null);
  assert.equal(dateRangeFormula('创建时间', '2026-11-19', '2026-11-18', '2026-11-19'), null);
  assert.equal(dateRangeFormula('创建时间', 'bad', '2026-11-19', '2026-11-19'), null);
});
