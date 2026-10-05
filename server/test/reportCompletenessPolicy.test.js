const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateReportCompleteness } = require('../src/services/reportCompletenessPolicy');

// 「到齐」判据：Σ(每条明细解析出的双数) >= 「合计数量」。
// 这一组用例锁的是产品负责人拍板的口径，重点是「按双数之和、不是按明细条数」。

test('双数之和达到合计数量 → 到齐', () => {
  const outcome = evaluateReportCompleteness({ declaredTotal: 5, details: [{ quantity: 3 }, { quantity: 2 }] });
  assert.equal(outcome.complete, true);
  assert.equal(outcome.receivedQuantity, 5);
  assert.equal(outcome.declaredTotal, 5);
  assert.equal(outcome.missingQuantity, 0);
  assert.equal(outcome.recordCount, 2);
  assert.equal(outcome.inconsistent, false);
  assert.equal(outcome.reason, null);
});

test('一条明细含多双：3+2=5 判到齐，而明细只有 2 条（不能按条数判）', () => {
  const outcome = evaluateReportCompleteness({ declaredTotal: 5, details: [{ quantity: 3 }, { quantity: 2 }] });
  assert.equal(outcome.recordCount, 2, '明细条数只有 2');
  assert.equal(outcome.receivedQuantity, 5, '按双数之和应是 5');
  assert.equal(outcome.complete, true, '5 双 == 合计数量 5，应到齐');
});

test('双数之和不足合计数量 → 没到齐，并给出还差多少', () => {
  const outcome = evaluateReportCompleteness({ declaredTotal: 5, details: [{ quantity: 3 }] });
  assert.equal(outcome.complete, false);
  assert.equal(outcome.receivedQuantity, 3);
  assert.equal(outcome.missingQuantity, 2);
  assert.equal(outcome.reason, null, 'reason 只表达"算不出来"，没到齐不算');
});

test('多报（收到的比申报的多）也算到齐，不能用 == 卡死', () => {
  const outcome = evaluateReportCompleteness({ declaredTotal: 3, details: [{ quantity: 5 }] });
  assert.equal(outcome.complete, true);
  assert.equal(outcome.receivedQuantity, 5);
  assert.equal(outcome.missingQuantity, 0);
});

test('details 支持裸数字，并忽略非法数量（不抛错）', () => {
  const outcome = evaluateReportCompleteness({ declaredTotal: 4, details: [1, '2', { quantity: 1 }, null, undefined, { quantity: -3 }, { quantity: 'x' }] });
  assert.equal(outcome.receivedQuantity, 4);
  assert.equal(outcome.recordCount, 7, 'recordCount 是传入明细条数，非法条目也算条数');
  assert.equal(outcome.complete, true);
});

test('非数组 details 视为空：received 0、不崩', () => {
  for (const details of [undefined, null, 'oops', 42, {}]) {
    const outcome = evaluateReportCompleteness({ declaredTotal: 5, details });
    assert.equal(outcome.receivedQuantity, 0);
    assert.equal(outcome.recordCount, 0);
    assert.equal(outcome.complete, false);
  }
});

test('合计数量缺失/非法 → complete:false + reason:no_declared_total（不抛错）', () => {
  for (const declaredTotal of [undefined, null, 0, -1, '', '   ', 'abc', NaN, Infinity, true, {}, []]) {
    const outcome = evaluateReportCompleteness({ declaredTotal, details: [{ quantity: 5 }] });
    assert.equal(outcome.declaredTotal, null, `declaredTotal=${String(declaredTotal)} 应被视为缺失`);
    assert.equal(outcome.complete, false, `declaredTotal=${String(declaredTotal)} 不能判到齐`);
    assert.equal(outcome.reason, 'no_declared_total');
    assert.equal(outcome.missingQuantity, 0);
    assert.equal(outcome.receivedQuantity, 5, '数据缺失也要照常把收到的双数算出来');
  }
});

test('完全不传参数也不崩', () => {
  const outcome = evaluateReportCompleteness();
  assert.equal(outcome.complete, false);
  assert.equal(outcome.reason, 'no_declared_total');
  assert.equal(outcome.receivedQuantity, 0);
  assert.equal(outcome.recordCount, 0);
});

test('同批「合计数量」不一致 → 取第一条合法值并标记 inconsistent', () => {
  const outcome = evaluateReportCompleteness({ declaredTotal: [5, 5, 4], details: [{ quantity: 5 }] });
  assert.equal(outcome.inconsistent, true);
  assert.deepEqual(outcome.declaredTotals, [5, 4]);
  assert.equal(outcome.declaredTotal, 5, '取第一条有合法值的记录');
  assert.equal(outcome.complete, true, '不一致只标记，仍按取到的值继续算');
});

test('部分记录没填合计数量：只用有合法值的那些判，且不算不一致', () => {
  const outcome = evaluateReportCompleteness({ declaredTotal: [null, 5, undefined], details: [{ quantity: 2 }] });
  assert.equal(outcome.declaredTotal, 5);
  assert.equal(outcome.inconsistent, false);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.missingQuantity, 3);
});

test('纯函数：同样输入得到同样结果，且不改动入参', () => {
  const details = [{ quantity: 3 }, { quantity: 2 }];
  const snapshot = JSON.parse(JSON.stringify(details));
  const first = evaluateReportCompleteness({ declaredTotal: 5, details });
  const second = evaluateReportCompleteness({ declaredTotal: 5, details });
  assert.deepEqual(first, second);
  assert.deepEqual(details, snapshot, '不得改动传入的 details');
});
