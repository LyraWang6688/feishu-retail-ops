const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REPORT_READ_MAX_RETRIES,
  DEFAULT_REPORT_READ_RETRY_DELAY_MS,
  REPORT_READ_MAX_RETRIES_ENV_KEY,
  REPORT_READ_RETRY_DELAY_ENV_KEY,
  resolveReportReadRetry,
} = require('../src/config/reportReadRetry');

// 业务负责人 2026-10-06 的口径：「到齐 ＋ 重试 3 次」「重试了 3 次之后还是读不到，
// 就算处理完了」。两个值都要能自己调（配置先行），所以这里钉住默认值、环境变量名、
// 以及"写错就回落默认值（不是变成 0）"。

test('默认：最多重试 3 次、间隔 1000 毫秒（1 秒 → 2 秒，共约 3 秒）', () => {
  assert.equal(DEFAULT_REPORT_READ_MAX_RETRIES, 3);
  assert.equal(DEFAULT_REPORT_READ_RETRY_DELAY_MS, 1_000);
  assert.deepEqual(resolveReportReadRetry({}, {}), { maxRetries: 3, retryDelayMs: 1_000 });
});

test('环境变量名固定，可显式覆盖；构造入参优先于环境变量', () => {
  assert.equal(REPORT_READ_MAX_RETRIES_ENV_KEY, 'REPORT_READ_MAX_RETRIES');
  assert.equal(REPORT_READ_RETRY_DELAY_ENV_KEY, 'REPORT_READ_RETRY_DELAY_MS');
  assert.deepEqual(resolveReportReadRetry({}, {
    [REPORT_READ_MAX_RETRIES_ENV_KEY]: '5',
    [REPORT_READ_RETRY_DELAY_ENV_KEY]: '250',
  }), { maxRetries: 5, retryDelayMs: 250 });
  assert.deepEqual(resolveReportReadRetry(
    { batchReadMaxRetries: 1, batchReadRetryDelay: 0 },
    { [REPORT_READ_MAX_RETRIES_ENV_KEY]: '5', [REPORT_READ_RETRY_DELAY_ENV_KEY]: '250' },
  ), { maxRetries: 1, retryDelayMs: 0 });
});

test('写错/清空 → 回落默认值（不是变成 0，也不是负数）', () => {
  const bad = ['abc', '', '   ', '-1', '0', '1.5'];
  for (const value of bad) {
    assert.deepEqual(
      resolveReportReadRetry({}, { [REPORT_READ_MAX_RETRIES_ENV_KEY]: value }),
      { maxRetries: 3, retryDelayMs: 1_000 },
      `次数 ${JSON.stringify(value)} 应回落默认值`,
    );
  }
  // 间隔允许 0（测试/沙箱"不等待"是合法的），其余写错的值回落默认。
  const badDelays = ['abc', '', '   ', '-1', '1.5'];
  for (const value of badDelays) {
    assert.deepEqual(
      resolveReportReadRetry({}, { [REPORT_READ_RETRY_DELAY_ENV_KEY]: value }),
      { maxRetries: 3, retryDelayMs: 1_000 },
      `间隔 ${JSON.stringify(value)} 应回落默认值`,
    );
  }
  assert.equal(resolveReportReadRetry({}, { [REPORT_READ_RETRY_DELAY_ENV_KEY]: '0' }).retryDelayMs, 0);
});
