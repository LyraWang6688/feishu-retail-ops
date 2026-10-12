/**
 * 「标签二维码 · 兜底巡检」每日调度的验收标准（2026-10-12）。
 *
 * 为什么有这条线：巡检函数（`tagQrCodeService.sweepStaleTagQrCodes`）2026-10-09 就写好了、
 * 也有单测，但**全仓没有任何调用方** ⇒ 从来没在线上跑过 —— 事件路径判漏的那批旧码
 * （她 5 条记录附件名里还带 `QPL` 旧前缀）因此一直没人修。
 *
 *   AC-QR-SWEEP-1 ⭐⭐ 按**最短间隔**去重（默认 1 小时一次；调度器每 10 分钟就会调 run）；
 *   AC-QR-SWEEP-2 ⭐⭐ 默认**每小时**（2026-10-12 从"每天一次"改的）；想退回每天一次把间隔设 24h；
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

test('AC-QR-SWEEP-1 ⭐⭐ 按**最短间隔**去重（默认 1 小时一次）：不足间隔直接 skipped，不碰 service', async () => {
  const service = fakeService();
  const runner = createTagQrSweepRunner({ service, minIntervalMs: 60 * 60 * 1000 });
  const first = await runner.run({ now: at('2026-10-11T20:00:00Z') }); // 上海 10-12 04:00
  assert.equal(first.skipped, false);
  assert.equal(first.rewritten, 1);
  // 过了 10 分钟（调度器每 10 分钟就会调一次 run）⇒ 必须跳过
  const tooSoon = await runner.run({ now: at('2026-10-11T20:10:00Z') });
  assert.equal(tooSoon.skipped, true, '不足最短间隔必须跳过（否则一天扫几十遍全表）');
  assert.equal(tooSoon.reason, 'too_soon');
  assert.ok(tooSoon.next_in_ms > 0 && tooSoon.next_in_ms <= 60 * 60 * 1000);
  // 过了 70 分钟 ⇒ 要跑（每小时自愈）
  const hourly = await runner.run({ now: at('2026-10-11T21:10:00Z') });
  assert.equal(hourly.skipped, false);
  assert.equal(service.calls.length, 2);
});

test('AC-QR-SWEEP-2 ⭐⭐ 默认就是**每小时**（不是每天一次 —— 真机那次漏判最坏要等第二天 ✗）', () => {
  const d = resolveTagQrSweepSchedule({});
  assert.equal(d.minIntervalMs, 60 * 60 * 1000, '默认两次巡检最短间隔 = 1 小时');
  assert.deepEqual(d.hours, [0], 'hours 只表示"从 0 点起允许跑"（全天）');
  // 想退回"每天一次"：把最短间隔设成 24h（配置项在，值由人给）
  assert.equal(resolveTagQrSweepSchedule({ TAG_QR_SWEEP_MIN_INTERVAL_MS: String(24 * 60 * 60 * 1000) })
    .minIntervalMs, 24 * 60 * 60 * 1000);
  assert.throws(() => resolveTagQrSweepSchedule({ TAG_QR_SWEEP_MIN_INTERVAL_MS: '1000' }),
    '最短间隔小于 1 分钟 ⇒ 当场抛（不许把它配成高频轮询）');
});

test('AC-QR-SWEEP-3 ⭐ dryRun / limit 透传；失败**抛出去**且当天允许重试', async () => {
  const service = fakeService();
  const runner = createTagQrSweepRunner({ service, dryRun: true, limit: 50, minIntervalMs: 24 * 60 * 60 * 1000 });
  await runner.run({ now: at('2026-10-11T20:00:00Z') });
  assert.deepEqual(service.calls[0], { dryRun: true, limit: 50 }, '干跑与上限要原样透传给巡检');
  assert.equal((await runner.run({ now: at('2026-10-11T21:00:00Z') })).skipped, true, '不足间隔 ⇒ 跳过');

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
  assert.equal(retry.skipped, false, '失败了要允许立刻重试（节流被清掉，不白等一小时）');
  assert.equal(flaky.calls, 2);
});

test('AC-QR-SWEEP-4 ⭐ 配置先行：开关是显式布尔（空串=关）、时点可配、越界当场抛', () => {
  const d = resolveTagQrSweepSchedule({});
  assert.equal(d.enabled, true, '默认开（"自愈兜底"这件事不该默认关着）');
  assert.deepEqual(d.hours, [0], '默认从 0 点起都可以跑（真正的频率看 minIntervalMs = 每小时）');
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
