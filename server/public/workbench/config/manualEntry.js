/**
 * 「输入货号」页的配置（销售 / 售后共用）。
 * 输入货号 → 选择具体货品 → 跳到与扫码完全相同的落点。
 */
export const MANUAL_ENTRY_PAGE = Object.freeze({
  path: '/workbench/manual-entry.html',
  salesTitle: '鞋类·输入货号',
  afterSalesTitle: '售后单·输入货号',
  hint: '输入货号，选择具体货品；效果和扫二维码一致。',
  salesSearchHint: '只显示未下架货品。',
  afterSalesSearchHint: '售后包含已下架货品，会标注「已下架」。',
  noRecord: '没有认出货品记录，请重新输入货号。',
  salesRecordBase: '/r',
  afterSalesPage: '/workbench/after-sales.html',
  delistedLabel: '已下架',
});
