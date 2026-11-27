'use strict';

const { readFlag, readInt } = require('./envValue');

/**
 * 9 点考勤弹窗（2026-11-27）：
 *   · 被考勤对象 = 花名册「在职 + 是否考勤」→ 打开工作台先问自己今天是否上班；
 *   · 考勤人 = 角色「考勤人」→ 打开工作台列出还没打卡的被考勤人，可代打卡；
 *   · 只记录上班，不记录「今天不上班」（只在本机记住当天不再弹）。
 */
const ATTENDANCE_PROMPT = Object.freeze({
  enabled: readFlag(process.env, 'ATTENDANCE_PROMPT_ENABLED', true),
  hour: readInt(process.env, 'ATTENDANCE_PROMPT_HOUR', 9, { min: 0, max: 23 }),
});

module.exports = { ATTENDANCE_PROMPT };
