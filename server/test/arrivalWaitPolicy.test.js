const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ARRIVAL_NOTICE_INTERVAL_MS,
  DEFAULT_ARRIVAL_ABANDON_WAIT_MS,
  DEFAULT_ARRIVAL_FAIL_AFTER_MS,
  DEFAULT_ARRIVAL_NOTICE_MAX_COUNT,
  resolveArrivalWaitConfig,
  formatDuration,
  arrivalRescuedNotice,
} = require('../src/services/arrivalWaitPolicy');

test('到货等待阈值：不配任何东西时用产品负责人定的默认值（1 / 2 / 3 分钟）', () => {
  const config = resolveArrivalWaitConfig({}, {});
  assert.deepEqual(config, {
    noticeIntervalMs: 60_000,
    abandonWaitMs: 120_000,
    failAfterMs: 180_000,
    noticeMaxCount: 5,
  });
  // 显式钉住常量本身：改默认值必须是有意的（她按一次 82 秒的真实识别定的）。
  assert.equal(DEFAULT_ARRIVAL_NOTICE_INTERVAL_MS, 60_000);
  assert.equal(DEFAULT_ARRIVAL_ABANDON_WAIT_MS, 120_000);
  assert.equal(DEFAULT_ARRIVAL_FAIL_AFTER_MS, 180_000);
  assert.equal(DEFAULT_ARRIVAL_NOTICE_MAX_COUNT, 5);
});

test('到货等待阈值可配：环境变量就是 .env.example 里那四个名字', () => {
  const config = resolveArrivalWaitConfig({}, {
    ARRIVAL_NOTICE_INTERVAL_MS: '45000',
    ARRIVAL_ABANDON_WAIT_MS: '90000',
    ARRIVAL_FAIL_AFTER_MS: '240000',
    ARRIVAL_NOTICE_MAX_COUNT: '8',
  });
  assert.deepEqual(config, {
    noticeIntervalMs: 45_000,
    abandonWaitMs: 90_000,
    failAfterMs: 240_000,
    noticeMaxCount: 8,
  });
});

test('到货等待阈值优先级：显式入参 > 环境变量 > 默认值', () => {
  const env = { ARRIVAL_NOTICE_INTERVAL_MS: '45000', ARRIVAL_FAIL_AFTER_MS: '240000' };
  const config = resolveArrivalWaitConfig({ arrivalNoticeIntervalMs: 10, arrivalAbandonWaitMs: 20 }, env);
  assert.equal(config.noticeIntervalMs, 10, '入参优先于环境变量');
  assert.equal(config.abandonWaitMs, 20, '环境变量没配就用入参');
  assert.equal(config.failAfterMs, 240_000, '没给入参就用环境变量');
});

test('到货等待阈值：0 / 负数 / 非数字一律当没写（0 会让定时器变成死循环刷屏）', () => {
  const config = resolveArrivalWaitConfig(
    { arrivalNoticeIntervalMs: 0, arrivalAbandonWaitMs: -1, arrivalFailAfterMs: 'abc', arrivalNoticeMaxCount: '' },
    { ARRIVAL_NOTICE_INTERVAL_MS: '0', ARRIVAL_ABANDON_WAIT_MS: 'abc' },
  );
  assert.deepEqual(config, {
    noticeIntervalMs: 60_000,
    abandonWaitMs: 120_000,
    failAfterMs: 180_000,
    noticeMaxCount: 5,
  });
});

test('迟到结果救回的说明：带上真实耗时，且要她直接确认入库', () => {
  assert.equal(formatDuration(45_000), '45 秒');
  assert.equal(formatDuration(200_000), '3 分 20 秒');
  assert.equal(formatDuration(0), '0 秒');
  assert.equal(
    arrivalRescuedNotice(200_000),
    '刚才那条到货单后来识别出来了（用了 3 分 20 秒），已经按识别结果处理好，你可以直接确认入库～',
  );
});
