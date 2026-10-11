/**
 * 「标签二维码 · 兜底巡检」每日调度的验收标准（2026-10-12）。
 *
 * 为什么有这条线：巡检函数（`tagQrCodeService.sweepStaleTagQrCodes`）2026-10-09 就写好了、
 * 也有单测，但**全仓没有任何调用方** ⇒ 从来没在线上跑过 —— 事件路径判漏的那批旧码
 * （她 5 条记录附件名里还带 `QPL` 旧前缀）因此一直没人修。
 *
 *   AC-QR-SWEEP-1 ⭐⭐ **同一个上海日只跑一次**（调度器过了整点每个 tick 都会调 run）；
 *   AC-QR-SWEEP-2 ⭐⭐ 按**上海日**去重，不是 UTC 日（否则她下午会被当成"新的一天"）；
 *   AC-QR-SWEEP-3 ⭐ dryRun / limit 透传；**失败要抛**且当天允许重试（一次抖动不白等 24 小时）；
 *   AC-QR-SWEEP-4 ⭐ 配置先行：开关是显式布尔（空串=关）、时点可配、越界当场抛。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTagQrSweepRunner, shanghaiDay } = require('../src/utils/tagQrSweepScheduler');
const { resolveTagQrSweepSchedule, SWEEP_SCHEDULE_DEFAULTS } = require('../src/config/tagQrCode');

const fakeService = () => {
  const calls = [];
  return {
    calls,
    async sweepStaleTagQrCodes(options) {
      calls.push(options);
      return { enabled: true, scanned: 3, rewritten: 1, dry_run: Boolean(options?.dryRun) };
    },
  };
};

const at = (iso) => new Date(iso);

test('AC-QR-SWEEP-1 ⭐⭐ 同一个上海日只跑一次（第二次直接 skipped，不碰 service）', async () => {
  const service = fakeService();
  const runner = createTagQrSweepRunner({ service });
  const first = await runner.run({ now: at('2026-10-11T20:00:00Z') }); // 上海 10-12 04:00
  const second = await runner.run({ now: at('2026-10-11T22:30:00Z') }); // 上海 10-12 06:30
  assert.equal(first.skipped, false);
  assert.equal(first.rewritten, 1);
  assert.equal(second.skipped, true, '同一天第二次必须跳过（调度器每 10 分钟就会调一次 run）');
  assert.equal(second.reason, 'already_ran_today');
  assert.equal(service.calls.length, 1, 'service 只能被调一次 —— 不然一天扫几十遍全表');
});

test('AC-QR-SWEEP-2 ⭐⭐ 按**上海日**去重（不是 UTC 日）：UTC 换天了但上海还是同一天 ⇒ 不重复跑', async () => {
  const service = fakeService();
  const runner = createTagQrSweepRunner({ service });
  // 上海 2026-10-12 04:00（UTC 还是 10-11）与 上海 2026-10-12 09:00（UTC 已到 10-12）
  await runner.run({ now: at('2026-10-11T20:00:00Z') });
  const sameDay = await runner.run({ now: at('2026-10-12T01:00:00Z') });
  assert.equal(sameDay.skipped, true, 'UTC 换天不代表上海换天');
  assert.equal(shanghaiDay(at('2026-10-11T20:00:00Z')), '2026-10-12');
  assert.equal(shanghaiDay(at('2026-10-12T01:00:00Z')), '2026-10-12');
  assert.equal(shanghaiDay(at('2026-10-12T17:00:00Z')), '2026-10-13');
  // 真的到了上海的下一天 ⇒ 要跑
  const nextDay = await runner.run({ now: at('2026-10-12T20:00:00Z') });
  assert.equal(nextDay.skipped, false);
  assert.equal(nextDay.day, '2026-10-13');
  assert.equal(service.calls.length, 2);
});

test('AC-QR-SWEEP-3 ⭐ dryRun / limit 透传；失败**抛出去**且当天允许重试', async () => {
  const service = fakeService();
  const runner = createTagQrSweepRunner({ service, dryRun: true, limit: 50 });
  await runner.run({ now: at('2026-10-11T20:00:00Z') });
  assert.deepEqual(service.calls[0], { dryRun: true, limit: 50 }, '干跑与上限要原样透传给巡检');
  assert.equal((await runner.run({ now: at('2026-10-11T21:00:00Z') })).skipped, true);

  // 失败：必须抛（调度器据此记 tick_failed），且**当天还能再来一次**
  let fail = true;
  const flaky = {
    calls: 0,
    async sweepStaleTagQrCodes() {
      this.calls += 1;
      if (fail) throw new Error('飞书上传失败');
      return { scanned: 1, rewritten: 0 };
    },
  };
  const runner2 = createTagQrSweepRunner({ service: flaky });
  await assert.rejects(() => runner2.run({ now: at('2026-10-11T20:00:00Z') }), /飞书上传失败/);
  fail = false;
  const retry = await runner2.run({ now: at('2026-10-11T20:30:00Z') });
  assert.equal(retry.skipped, false, '失败了要允许当天重试（一次网络抖动不该白等 24 小时）');
  assert.equal(flaky.calls, 2);
});

test('AC-QR-SWEEP-4 ⭐ 配置先行：开关是显式布尔（空串=关）、时点可配、越界当场抛', () => {
  const d = resolveTagQrSweepSchedule({});
  assert.equal(d.enabled, true, '默认开（"自愈兜底"这件事不该默认关着）');
  assert.deepEqual(d.hours, [4], '默认凌晨 4 点（店里没人）');
  assert.equal(resolveTagQrSweepSchedule({ TAG_QR_SWEEP_ENABLED: '' }).enabled, false, '空串 = 关掉');
  assert.equal(resolveTagQrSweepSchedule({ TAG_QR_SWEEP_ENABLED: 'false' }).enabled, false);
  assert.deepEqual(resolveTagQrSweepSchedule({ TAG_QR_SWEEP_HOURS: '3,5' }).hours, [3, 5]);
  assert.deepEqual(resolveTagQrSweepSchedule({ TAG_QR_SWEEP_HOURS: '99' }).hours, SWEEP_SCHEDULE_DEFAULTS.hours,
    '认不出的时点回退到默认（不静默跑成别的时间）');
  assert.equal(resolveTagQrSweepSchedule({ TAG_QR_SWEEP_DRY_RUN: 'true' }).dryRun, true);
  assert.throws(() => resolveTagQrSweepSchedule({ TAG_QR_SWEEP_INTERVAL_MS: '10' }),
    '调度间隔小于 1 秒 ⇒ 当场抛（不许静默把一个秒级轮询跑起来）');
});

test('AC-QR-SWEEP-5 ⭐ 缺 service（没接线）⇒ 构造时就抛，不许"安静地什么都没做"', () => {
  assert.throws(() => createTagQrSweepRunner({}), /缺少 service/);
  assert.throws(() => createTagQrSweepRunner({ service: {} }), /sweepStaleTagQrCodes/);
});
