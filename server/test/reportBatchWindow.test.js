const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REPORT_BATCH_WINDOW_MS,
  REPORT_BATCH_WINDOW_ENV_KEY,
  resolveReportBatchWindowMs,
} = require('../src/config/reportBatchWindow');

// 归批窗口是「一次表单提交 = 一批」的兜底：窗口太长业务负责人会嫌等，
// 太短则拆包时会把一批拆成两次处理（写出两套采购申请）。所以默认值和
// 环境变量名都要钉死在这里，改的时候必须是有意识的。

test('默认是 4 秒（3~5 秒区间）：不是以前那个被否掉的 30 秒', () => {
  assert.equal(DEFAULT_REPORT_BATCH_WINDOW_MS, 4000);
  assert.equal(resolveReportBatchWindowMs({}, {}), 4000);
  assert.ok(DEFAULT_REPORT_BATCH_WINDOW_MS >= 3000 && DEFAULT_REPORT_BATCH_WINDOW_MS <= 5000);
});

test('环境变量名是 REPORT_BATCH_WINDOW_MS，且能被显式配置覆盖', () => {
  assert.equal(REPORT_BATCH_WINDOW_ENV_KEY, 'REPORT_BATCH_WINDOW_MS');
  assert.equal(resolveReportBatchWindowMs({}, { REPORT_BATCH_WINDOW_MS: '3000' }), 3000);
  assert.equal(resolveReportBatchWindowMs({}, { REPORT_BATCH_WINDOW_MS: '0' }), 0, '0 = 不等待，允许');
});

test('构造入参优先于环境变量（测试用它压到毫秒级）', () => {
  assert.equal(resolveReportBatchWindowMs({ reportBatchWindowMs: 20 }, { REPORT_BATCH_WINDOW_MS: '3000' }), 20);
  assert.equal(resolveReportBatchWindowMs({ reportBatchWindowMs: 0 }, {}), 0);
});

test('负数/非数字当「没写」回落到默认值：写错不会变成"永远不等"或"永远不处理"', () => {
  const bad = ['-1', 'abc', '', ' ', null, undefined, NaN, Infinity];
  bad.forEach((value) => {
    assert.equal(resolveReportBatchWindowMs({}, { REPORT_BATCH_WINDOW_MS: value }), DEFAULT_REPORT_BATCH_WINDOW_MS,
      `${JSON.stringify(value)} 应回落到默认值`);
    assert.equal(resolveReportBatchWindowMs({ reportBatchWindowMs: value }, {}), DEFAULT_REPORT_BATCH_WINDOW_MS);
  });
});
