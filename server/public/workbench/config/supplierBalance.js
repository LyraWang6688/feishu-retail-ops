/** 「供应 → 供应分析」页面文案 / API。 */
export const SUPPLIER_BALANCE_API = '/api/workbench/purchase/supplier-balances';

export const SUPPLIER_BALANCE_TEXTS = Object.freeze({
  tabsLabel: '供应分析视图',
  tabs: Object.freeze([
    { id: 'transactions', label: '交易流水' },
    { id: 'overview', label: '供应总览' },
  ]),
  overviewBuilding: '供应总览正在建设中。',
  searchPlaceholder: '搜索供应商',
  loading: '正在读取供应商余额…',
  failed: '供应分析读取失败，请稍后重试',
  empty: '当前没有需要展示的供应商。',
  noTransactions: '最近 30 天没有交易。',
  transactionsTitle: '最近 30 天交易',
  count: '共 {count} 个供应商',
});
