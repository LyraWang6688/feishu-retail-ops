'use strict';

/**
 * ⭐⭐ 2026-10-14（她逐字）：「数据从 20261015 开始」＋早前「存量行不用管，就看增量」
 *   ⇒ 判据只有一处（`config/dataSince.js` 的 `isOnOrAfterSince` ✓）；**上海时区** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { DATA_SINCE, isOnOrAfterSince, shanghaiDayKeyOf } = require('../src/config/dataSince');

test('AC-DS1 口径就是 2026-10-15（她逐字 · 一处定义）', () => {
  assert.equal(DATA_SINCE, '2026-10-15');
});

test('AC-DS2 ⭐ 10-14 不挑 / 10-15 挑（边界含当天 ✓）', () => {
  assert.equal(isOnOrAfterSince('2026-10-14'), false, '前一天 ⇒ 存量 ⇒ 不挑 ✗');
  assert.equal(isOnOrAfterSince('2026-10-15'), true, '当天（含）⇒ 挑 ✓');
  assert.equal(isOnOrAfterSince('2026-10-16'), true, '之后 ⇒ 挑 ✓');
  assert.equal(isOnOrAfterSince('2026-11-01'), true);
});

test('AC-DS3 ⭐ 时区按上海（UTC 深夜 = 上海次日 ⇒ 按上海那天算）', () => {
  // 2026-10-14T16:30:00Z = 上海 2026-10-15 00:30 ⇒ **算 10-15 ⇒ 挑** ✓
  assert.equal(shanghaiDayKeyOf('2026-10-14T16:30:00Z'), '2026-10-15');
  assert.equal(isOnOrAfterSince('2026-10-14T16:30:00Z'), true);
  // 2026-10-14T15:30:00Z = 上海 2026-10-14 23:30 ⇒ 存 10-14 ⇒ 不挑 ✓
  assert.equal(isOnOrAfterSince('2026-10-14T15:30:00Z'), false);
  // 毫秒时间戳同样口径 ✓
  assert.equal(isOnOrAfterSince(Date.parse('2026-10-14T16:30:00Z')), true);
  assert.equal(isOnOrAfterSince(Math.floor(Date.parse('2026-10-14T15:30:00Z') / 1000)), false);
});

test('AC-DS4 ⚠️ 认不出 ⇒ false（宁可不动 ✗ 也不误挑 ✓）', () => {
  for (const bad of [null, undefined, '', '   ', 'not-a-date', {}, NaN, Infinity, new Date('invalid')]) {
    assert.equal(isOnOrAfterSince(bad), false, `${String(bad)} 应该判 false`);
  }
});

test('AC-DS5 ⭐ Date 对象也按上海（不按本地时区 ✗）', () => {
  assert.equal(shanghaiDayKeyOf(new Date('2026-10-14T16:30:00Z')), '2026-10-15');
  assert.equal(shanghaiDayKeyOf(new Date('2026-10-14T15:30:00Z')), '2026-10-14');
});
