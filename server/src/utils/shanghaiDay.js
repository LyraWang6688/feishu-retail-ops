'use strict';

/**
 * 上海自然日（UTC+8，项目所在地不涉及夏令时）的**唯一实现**（2026-11-14 收口 #61）。
 *
 * 收口前有 6 份"上海日" helper（`+8h` 后再 `toISOString().slice(0,10)`，其中一份还误用进程本地时区）。
 * 这里统一提供：`shanghaiDayOf(ms)` / `shanghaiDayKeyOf(任意输入)` / `addDays(dayKey,n)` /
 * `shanghaiDayStart(dayKey)` / `shanghaiDateTimeText(ms)`。
 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (value) => String(value).padStart(2, '0');

/** 毫秒 → 上海 `YYYY-MM-DD`（非法 / 非正数 ⇒ `''`）。 */
const shanghaiDayOf = (epochMs) => {
  const value = Number(epochMs);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
};

/** Date → 上海 `YYYY-MM-DD`（非法 Date ⇒ `''`）。 */
const shanghaiDayKeyOfDate = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return shanghaiDayOf(date.getTime());
};

/**
 * 各种输入 → 上海 `YYYY-MM-DD`；认不出 ⇒ `''`（**不猜**）。
 * 支持：纯日期字符串（原样）、带时间/时区字符串、epoch 数字/数字串、Date。
 */
const secondsToMs = (number) => (number < 1e12 ? number * 1000 : number);

const shanghaiDayKeyOf = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const raw = value.trim();
    const plain = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (plain) return `${plain[1]}-${plain[2]}-${plain[3]}`;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return shanghaiDayOf(parsed);
    const asNumber = Number(raw);
    return Number.isFinite(asNumber) ? shanghaiDayOf(secondsToMs(asNumber)) : '';
  }
  if (value instanceof Date) return shanghaiDayKeyOfDate(value);
  const number = Number(value);
  return Number.isFinite(number) ? shanghaiDayOf(secondsToMs(number)) : '';
};

/** `YYYY-MM-DD` + N 天（纯日期运算，不经过本地时区）。 */
const addDays = (dayKey, days) => {
  const base = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return '';
  base.setUTCDate(base.getUTCDate() + Number(days));
  return base.toISOString().slice(0, 10);
};

/** 上海某一天的 00:00 对应的 epoch 毫秒。 */
const shanghaiDayStart = (dayKey) => Date.parse(`${dayKey}T00:00:00+08:00`);

/** 毫秒 → 上海时间文案 `YYYY-MM-DD HH:mm`（给她看的；空值 ⇒ ''）。 */
const shanghaiDateTimeText = (timestamp) => {
  if (!timestamp) return '';
  const shifted = new Date(Number(timestamp) + SHANGHAI_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return '';
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
};

module.exports = {
  SHANGHAI_OFFSET_MS, shanghaiDayOf, shanghaiDayKeyOf, shanghaiDayKeyOfDate,
  addDays, shanghaiDayStart, shanghaiDateTimeText,
};
