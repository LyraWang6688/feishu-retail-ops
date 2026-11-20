'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeArrivalDifference, formatArrivalDifference } = require('../src/services/purchaseArrival/differenceAnalysis');

test('差异分析：应到 / 实到 / 多到与前端 totalsOf 同一口径', () => {
  const rows = [
    { quantity: 10, actual: 8 },
    { quantity: 5, actual: 7 },
    { quantity: 0, actual: 2, custom: true },
  ];
  assert.deepEqual(summarizeArrivalDifference(rows), { expected: 15, actual: 13, extra: 4 });
  assert.equal(
    formatArrivalDifference({ expected: 15, actual: 13, extra: 4 }, '应到 {expected} 双 / 实到 {actual} 双 / 多到 {extra} 双'),
    '应到 15 双 / 实到 13 双 / 多到 4 双',
  );
});

test('差异分析：全部按申请数到货 ⇒ 多到 0', () => {
  const totals = summarizeArrivalDifference([{ quantity: 22, actual: 22 }]);
  assert.deepEqual(totals, { expected: 22, actual: 22, extra: 0 });
  assert.equal(
    formatArrivalDifference(totals, '应到 {expected} 双 / 实到 {actual} 双 / 多到 {extra} 双'),
    '应到 22 双 / 实到 22 双 / 多到 0 双',
  );
});
