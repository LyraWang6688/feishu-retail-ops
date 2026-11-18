/**
 * 库存 → 库存流水（只读）的页面配置。
 *
 * 字段顺序 / 文案 / 接口都只在这里；config/domains.js 只引用 label，
 * 不在两处各写一份「库存流水」。
 */
export const INVENTORY_LEDGER_PAGE = Object.freeze({
  id: 'inventory-ledger',
  label: '库存流水',
  api: '/api/workbench/inventory/ledger',
  columns: Object.freeze([
    { key: 'time', label: '创建时间', cls: 'time' },
    { key: 'behavior', label: '库存行为' },
    { key: 'number', label: '编号' },
    { key: 'size', label: '尺码' },
    { key: 'quantity_change', label: '数量', cls: 'qty' },
  ]),
  texts: Object.freeze({
    startLabel: '开始日期',
    endLabel: '结束日期',
    query: '查询',
    today: '今天',
    loading: '正在读取库存流水…',
    empty: '这个时间范围内没有库存流水。',
    failed: '库存流水读取失败，请稍后刷新。',
    total: '共 {total} 条',
    recent: '显示最近 {shown} 条',
    invalidRange: '开始日期不能晚于结束日期。',
  }),
});
