/**
 * ⭐⭐ 2026-10-12「提速第二刀」①：飞书 GET `filter` 的**公式拼装**从 `scanPageService` 里抽出来，
 * 成为**唯一一处实现**（`field_name` 一律由调用方按 schema 的物理列名传进来，
 * 这里不写死任何一个业务字段名）。
 *
 * ⚠️ **纯搬移**：本文件的代码与 `scanPageService` 里那份**逐字相同**，行为零变化；
 *   `scanPageService` 改为 `require` 本模块（抽出来是"别的调用方也能用同一个拼装"的前置）。
 *
 * 🔴 真表实测（2026-10-12，服务器只读）：**关联列（type 18）拼不出可用的 filter** ——
 *   `CurrentValue.[销售单号]="rec…"` / `.contains("rec…")` ⇒ `InvalidFilter (1254018)`；
 *   `filter.conditions` 里用关联列 ⇒ **返回整表（等于没过滤）**。
 *   ⇒ 想"按关联列精确读"目前不成立；按**已知 record id** 读要靠别的路（见报告）。
 *
 * 飞书 GET `filter` 的**公式**拼装（官方《记录筛选的开发指南》：
 * `CurrentValue.[字段名]="值"`、`CurrentValue.[字段名].contains("值")`、`OR(...)`）。
 * `field_name` 一律由调用方按 schema 的物理列名传进来 —— 这里不写死任何一个业务字段名。
 *
 * 🔴 **值是要嵌进公式里的**，所以必须过安全字符检查：
 *    带双引号 / 反斜杠 / 方括号 / 换行的值**一律不拼**（返回 `null` ⇒ 调用方回退整表读）。
 *    宁可慢一次，也绝不让一个"颜色名里带引号"的编号把公式拼坏 ——
 *    拼坏了飞书要么报错、要么按错的条件返回（**错的数据比慢更坏**）。
 */
const FILTER_TEXT_UNSAFE = /["\\[\]\r\n\t]/;
// 官方：`filter` 参数长度不超过 2000 个字符。
const MAX_FILTER_CHARS = 2000;
// 「尺码管理」整表在它自己那份缓存里的键（只有这一张表，键就是常量）。

const filterTextLiteral = (value) => {
  const text = String(value ?? '');
  if (!text || FILTER_TEXT_UNSAFE.test(text)) return null;
  return `"${text}"`;
};

/** `CurrentValue.[字段]="值"`（值不安全 / 字段没配 → `null`）。 */
const equalsFormula = (field, value) => {
  const literal = filterTextLiteral(value);
  return field && literal ? `CurrentValue.[${field}]=${literal}` : null;
};

/** `CurrentValue.[字段].contains("值")`（同上）。 */
const containsFormula = (field, value) => {
  const literal = filterTextLiteral(value);
  return field && literal ? `CurrentValue.[${field}].contains(${literal})` : null;
};

/** `OR(条件1,条件2)`；只有一个条件时就去掉 OR（少一层解析）；拼出来太长也不拼。 */
const orFormula = (parts) => {
  const conditions = (parts || []).filter(Boolean);
  if (!conditions.length) return null;
  if (conditions.length === 1) return conditions[0];
  const formula = `OR(${conditions.join(',')})`;
  return formula.length <= MAX_FILTER_CHARS ? formula : null;
};
module.exports = {
  FILTER_TEXT_UNSAFE,
  MAX_FILTER_CHARS,
  filterTextLiteral,
  equalsFormula,
  containsFormula,
  orFormula,
};
