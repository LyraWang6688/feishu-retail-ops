/**
 * ⭐⭐ 2026-10-12：**销售日期窗口的直测**（新文件 `utils/salesDateWindows.js`）。
 *
 * 为什么有这份：这三个工具原先住在 `services/saleLookupService.js`（群查单链路）里，
 * 但**消费者是别的链路**（二次交付 · 待处理单推送 · 报表 · 凭证结算）✓ ⇒ 群查单退场时
 * 把它们**逐字搬到中性文件**（覆盖不能丢 ✗）。
 *
 * ⚠️ 老 `saleLookupService.test.js` 里**没有**对这几个工具的直测 —— 只有一条**间接**的
 *   「候选查询窗口：4 天前的命中，6 天前的不命中（默认 5 天）」⇒ 那份随旧链路删了，
 *   **口径在这里补成直测**（同样的 4 天/6 天边界 ✓）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SHANGHAI_OFFSET_MS, DAY_MS, asDate, shanghaiDayKey, shanghaiDayStart, lookupWindowStart, isWithinLookupWindow,
} = require('../src/utils/salesDateWindows');

test('AS1 asDate：数字（秒 / 毫秒）· ISO 串 · 空 / 坏值 ⇒ null（一字不改的老口径）', () => {
  const ms = Date.UTC(2026, 9, 12, 0, 0, 0);
  assert.equal(asDate(ms).getTime(), ms, '毫秒时间戳');
  assert.equal(asDate(Math.floor(ms / 1000)).getTime(), ms, '秒时间戳（<1e12 ⇒ ×1000）');
  assert.equal(asDate('2026-10-12T00:00:00.000Z').getTime(), ms, 'ISO 串');
  for (const bad of [null, undefined, '', '   ', 'not-a-date']) {
    assert.equal(asDate(bad), null, `${JSON.stringify(bad)} ⇒ null`);
  }
});

test('AS2 shanghaiDayKey：UTC 深夜算**上海次日**（门店按上海自然日营业）', () => {
  // UTC 2026-10-11 17:00 = 上海 2026-10-12 01:00
  assert.equal(shanghaiDayKey(new Date(Date.UTC(2026, 9, 11, 17, 0, 0))), '2026-10-12');
  assert.equal(SHANGHAI_OFFSET_MS, 8 * 60 * 60 * 1000);
  assert.equal(DAY_MS, 24 * 60 * 60 * 1000);
});

test('AS3 窗口：4 天前的命中、6 天前的不命中（默认 5 天 —— 与老用例同一条口径 ✓）', () => {
  const now = new Date(Date.UTC(2026, 9, 12, 4, 0, 0)); // 上海 2026-10-12 12:00
  const start = lookupWindowStart({ now, days: 5 });
  assert.equal(start, shanghaiDayStart(now) - 4 * DAY_MS, '窗口 = 今天 + 往前 4 个自然日');
  assert.equal(isWithinLookupWindow(asDate('2026-10-08T02:00:00.000Z'), { now, days: 5 }), true, '4 天前（上海 10-08）命中');
  assert.equal(isWithinLookupWindow(asDate('2026-10-06T02:00:00.000Z'), { now, days: 5 }), false, '6 天前（上海 10-06）不命中');
  assert.equal(isWithinLookupWindow(null, { now, days: 5 }), false, '空日期 ⇒ 不命中（不抛 ✓）');
});
