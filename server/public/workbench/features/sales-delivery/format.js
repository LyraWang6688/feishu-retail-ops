/**
 * 「销售交割单」预览页的**格式化纯函数**（无 DOM / 无网络 / 无 import）。
 * 只回答"这个值怎么显示"；分组与并集判据在 `filter.js`，排序在 `sort.js`。
 */

/** 飞书单元格 → 文本（关联是数组、公式常是 [{text}]；对象取 text/value/name）。 */
export const textOf = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('');
  if (typeof value === 'object') return textOf(value.text ?? value.value ?? value.name ?? '');
  return '';
};

/** 任意日期值 → 毫秒时间戳（数字毫秒 / 秒 / 数字字符串 / 文本 / Date）；认不出 ⇒ null（不猜）。 */
export const timestampOf = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const raw = typeof value === 'number' ? value : textOf(value).trim();
  if (raw === '') return null;
  if (typeof raw === 'number' || /^\d{10,13}$/.test(String(raw))) {
    const number = Number(raw);
    return Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : null;
  }
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
};

/** 金额（null / 非数字 ⇒ 0.00；页面只读，不做业务计算）。 */
export const formatMoney = (value) => {
  const number = Number(value);
  return `¥${(Number.isFinite(number) ? number : 0).toFixed(2)}`;
};

/** 卡片上用的紧凑金额（整元不带 .00；表单里仍用 formatMoney 的完整两位）。 */
export const formatMoneyCompact = (value) => {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : 0;
  return Number.isInteger(safe) ? `¥${safe}` : `¥${safe.toFixed(2)}`;
};

export const formatQuantity = (value) => {
  const number = Number(value);
  return String(Number.isFinite(number) ? number : 0);
};

/** 展示用销售日（本地时区，日期 + 时分；认不出 ⇒ 空串，由页面显示「销售日未填」）。 */
export const formatSoldAt = (timestamp) => {
  if (timestamp == null) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 一行明细的展示文本：货号（或配品）· 颜色 · 尺码（拿不到就留空，不编）。 */
export const detailTextOf = (line = {}) => {
  const parts = [
    textOf(line.product).trim() || textOf(line.accessory).trim(),
    textOf(line.color).trim(),
    textOf(line.size).trim() ? `${textOf(line.size).trim()} 码` : '',
  ].filter(Boolean);
  return parts.join(' · ');
};

/** 销售日分组 key（本地时区 `YYYY-MM-DD`；认不出 ⇒ 空串 = 未填组）。 */
export const dateKeyOf = (timestamp) => {
  if (timestamp == null) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 卡片行右侧的短日期（销售日；例 `10-18`）。认不出 ⇒ 空串（页面显示「销售日未填」）。 */
export const formatShortDate = (timestamp) => {
  if (timestamp == null) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 抽屉 / 表单里的数字展示（金额 / 数量都走这一个口）。 */
export const displayOf = (value, fallback) => (value == null || value === '' ? fallback : String(value));
