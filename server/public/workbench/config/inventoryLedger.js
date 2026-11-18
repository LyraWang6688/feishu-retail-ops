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
    { key: 'behavior', label: '库存行为' },
    { key: 'number', label: '编号' },
    { key: 'size', label: '尺码' },
    { key: 'quantity_change', label: '变动数量' },
  ]),
  texts: Object.freeze({
    loading: '正在读取库存流水…',
    empty: '暂时没有库存流水。',
    failed: '库存流水读取失败，请稍后刷新。',
    total: '共 {total} 条',
    recent: '显示最近 {shown} 条',
  }),
});
