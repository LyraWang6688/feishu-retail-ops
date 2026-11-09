/**
 * 「库存 → 手工调整」的三级子 tab 配置。
 *
 * 业务负责人 2026-11-09：三级 tab 也要配置驱动，不要散落在页面字符串里。
 * 加减 / 改名 / 排序 / 默认选中只改这一处；各面板的实现仍按 id 对应（adjust-state / adjust-count / adjust-season）。
 */
export const INVENTORY_ADJUSTMENT_TABS = [
  { id: 'adjust-state', label: '状态调整' },
  { id: 'adjust-count', label: '盘点调整', default: true },
  { id: 'adjust-season', label: '换季调整' },
];
