/** 「销售 → 每日现金」页面配置。 */
export const SALES_DAILY_CASH_API = '/api/workbench/sales/daily-cash';

export const SALES_DAILY_CASH_TEXTS = Object.freeze({
  title: '每日现金',
  openingTitle: '期初现金',
  openingHint: '每天营业前填写今天的期初现金。',
  withdrawalTitle: '关店拿走现金',
  withdrawalHint: '关店时填写今天从现金里拿走的金额。',
  realtimeTitle: '实时现金余额',
  saveOpening: '保存期初现金',
  saveWithdrawal: '保存拿走金额',
  saved: '已保存',
  loading: '正在读取今天的现金记录…',
  failed: '每日现金读取失败，请稍后刷新。',
  saveFailed: '保存失败，请稍后重试。',
  notStarted: '今天还没有填写期初现金。',
  openingRequired: '请先填写并保存期初现金。',
  openingInvalid: '期初现金必须是大于等于 0 的数字。',
  withdrawalInvalid: '拿走金额必须是大于等于 0 的数字。',
  openingLabel: '期初现金（元）',
  withdrawalLabel: '拿走金额（元）',
});
