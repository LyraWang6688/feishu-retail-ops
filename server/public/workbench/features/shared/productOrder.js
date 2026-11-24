/**
 * 货品展示排序（采购报货区 / 验收明细共用）。
 *
 * 规则（2026-11-24 业务负责人）：按编号的组成依次比较：
 *   itemNo（货号） → color（颜色） → category（男女） → productRecordId
 *
 * 全部按多维表格的「文本 A → Z」排序，不做自然数字排序（numeric:false）。
 * 空值排最后；number 只用来拆出类别，不作为货号兜底。
 */
const COLLATOR = new Intl.Collator('zh-CN', {
  numeric: false,
  sensitivity: 'base',
});

const textOf = (value) => String(value == null ? '' : value).trim();
const emptyLast = (left, right) => {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return COLLATOR.compare(left, right);
};
const categoryOf = (row = {}) => {
  const explicit = textOf(row.category ?? row.product_category);
  if (explicit) return explicit;
  const parts = textOf(row.number).split('|');
  return textOf(parts[2]);
};
const idOf = (row = {}) => textOf(row.productRecordId || row.productId || row.product_record_id || row.product_id);

export const compareProductOrder = (left = {}, right = {}) => (
  emptyLast(textOf(left.itemNo ?? left.item_no), textOf(right.itemNo ?? right.item_no))
  || emptyLast(textOf(left.color), textOf(right.color))
  || emptyLast(categoryOf(left), categoryOf(right))
  || emptyLast(idOf(left), idOf(right))
);

export const sortProductRows = (rows = []) => [...rows].sort(compareProductOrder);
