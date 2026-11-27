'use strict';

const { readString, readInt } = require('./envValue');

/**
 * 未打下班卡提醒（2026-11-27）：
 *   · 每天 18:00 之后（默认 18 点，可配）检查仍有「进行中」考勤的人；
 *   · 私聊提醒本人一次，当天不重复；
 *   · 只提醒花名册里勾了「是否考勤」且在职的人。
 */
const ATTENDANCE_REMINDER = Object.freeze({
  enabled: readString(process.env, 'ATTENDANCE_CLOCK_OUT_REMIND_ENABLED', 'true') !== 'false',
  hour: readInt(process.env, 'ATTENDANCE_CLOCK_OUT_REMIND_HOUR', 18, { min: 0, max: 23 }),
  intervalMs: 10 * 60 * 1000,
  text: '【考勤提醒】{name}，今天还没打下班卡，记得下班打卡～',
});

module.exports = { ATTENDANCE_REMINDER };
