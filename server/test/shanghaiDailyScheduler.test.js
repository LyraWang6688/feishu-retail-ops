/**
 * `utils/shanghaiDailyScheduler`（**共用件**）的回归用例。
 *
 * 为什么单独一个文件：这个轮询器原先只有两处覆盖 —— `pendingDealPush.test.js`（**单整点**）
 * 与战报那份用例（**多整点** `hours: [...]`）。战报 2026-10-07 退役时那份文件整体删掉了，
 * 于是**共用件的多整点模式**会跟着失去覆盖。这几条盯的是 `shanghaiDailyScheduler` 本身
 * （"到最早那个整点前不跑、过了就跑" ＋ `hours` 的取值范围校验），**与战报业务语义无关**，
 * 所以从被删文件里原样搬到这里 —— 删功能不该顺手删掉共用件的哨兵。
 *
 * ⚠️ 本文件**只搬不改**：断言的字面与判定强度与搬之前逐字相同，没有新增也没有放宽。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { startShanghaiDailyScheduler, shanghaiHour } = require('../src/utils/shanghaiDailyScheduler');

const DAY = '2026-10-06';
// 北京时间 = UTC+8：北京 09:00 / 12:00 / 22:00
const AT_12 = new Date(`${DAY}T04:00:00.000Z`);
const AT_22 = new Date(`${DAY}T14:00:00.000Z`);
const at = (iso) => Date.parse(iso);

// ─────────────────────────────────────────────────────────────────────────────
// 多整点（`hours: [...]`）：一天多趟的用法
// ─────────────────────────────────────────────────────────────────────────────

test('定时器支持多整点：到最早那个整点前不跑，过了就跑', async () => {
  const calls = [];
  let clock = at(`${DAY}T00:30:00.000Z`); // 北京 08:30
  const stop = startShanghaiDailyScheduler({
    run: async ({ now }) => calls.push(now.toISOString()),
    eventPrefix: 'test.multi_hour',
    hours: [9, 12, 15, 18, 21, 22],
    intervalMs: 3600000,
    now: () => clock,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 0, '北京 8:30 还没到最早那个整点');

  clock = AT_12; // 北京 12:00
  const stop2 = startShanghaiDailyScheduler({
    run: async ({ now }) => calls.push(now.toISOString()),
    eventPrefix: 'test.multi_hour.on_time',
    hours: [9, 12, 15, 18, 21, 22],
    intervalMs: 3600000,
    now: () => clock,
  });
  for (let i = 0; i < 100 && !calls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 1);
  stop();
  stop2();

  assert.equal(shanghaiHour(AT_22), 22);
  assert.throws(() => startShanghaiDailyScheduler({
    run: async () => {}, eventPrefix: 'x', hours: [25],
  }), /0~23/);
});
