'use strict';

/**
 * 金额 → 分（**唯一解析口径**，2026-11-14 收口 #61）。
 *
 * 收口前有 7 份 `toCents`、4 种语义（`Number(v||0)` / 裸 `Number` / 非法→null / 清非数字→0）。
 * 现在只保留两个显式函数，语义写在名字里：
 *   · `toCents(value)`        —— 不可解析 ⇒ **null**（调用方自己决定要不要兜 0）
 *   · `toCentsOrZero(value)`  —— 不可解析 ⇒ **0**（仅用于"0 是合理默认"的展示/合计）
 *
 * 解析规则（两边一致）：数字 / 数字字符串（允许货币符号、千分位、空格）；四舍五入到分。
 */
const toCents = (value, { fallback = null, clean = true } = {}) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : fallback;
  }
  if (value === null || value === undefined) return fallback;
  let text = typeof value === 'string' ? value : String(value);
  if (clean) text = text.replace(/[^\d.-]/g, '');
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  const number = Number(trimmed);
  return Number.isFinite(number) ? Math.round(number * 100) : fallback;
};

const toCentsOrZero = (value, options = {}) => toCents(value, { ...options, fallback: 0 });

module.exports = { toCents, toCentsOrZero };
