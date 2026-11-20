/** 「供应 → 往来款」页面文案 / API。 */
export const SUPPLIER_BALANCE_API = '/api/workbench/purchase/supplier-balances';

export const SUPPLIER_BALANCE_TEXTS = Object.freeze({
  searchPlaceholder: '搜索供应商',
  loading: '正在读取供应商余额…',
  failed: '往来款读取失败，请稍后重试',
  empty: '当前没有需要展示的供应商。',
  noTransactions: '最近 30 天没有交易。',
  transactionsTitle: '最近 30 天交易',
  count: '共 {count} 个供应商',
});
