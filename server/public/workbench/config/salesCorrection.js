/** 「销售 → 订单列表 → 确认单」页面文案 / API。 */
export const SALES_CORRECTION_PAGE = '/workbench/sales-confirm.html';

export const SALES_CORRECTION_API = Object.freeze({
  list: '/api/workbench/sales/corrections',
  save: '/api/workbench/sales/corrections',
  sizeGroups: '/api/workbench/sales/size-groups',
});

export const SALES_CORRECTION_PAYMENT_STATUS = Object.freeze({
  paid: '已收款',
  unpaid: '未收款',
});

export const SALES_CORRECTION_TEXTS = Object.freeze({
  pageTitle: '确认单 · 最近 5 天',
  loading: '正在读取最近 5 天的销售单…',
  empty: '最近 5 天没有可确认的销售单',
  failed: '确认单读取失败，请稍后刷新',
  edit: '核对 / 修改',
  readonly: '只读',
  blockedAfterSales: '已发生售后，不能修改',
  blockedStatus: '未写入成功，不能修改',
  forbidden: '只能修改自己录的单',
  modalTitle: '核对并修改这张销售单',
  goodsTitle: '货品信息',
  paymentTitle: '资金信息',
  sizeLabel: '尺码',
  amountLabel: '实收金额',
  methodLabel: '支付方式',
  paymentAmountLabel: '收款金额',
  giftLabel: '赠品',
  accessoryLabel: '配品',
  accessoryAmountLabel: '配品总额',
  totalLabel: '合计',
  paidLabel: '已收',
  pendingLabel: '未收',
  inStock: '现货',
  reserve: '预订',
  special: '特殊码',
  original: '原单',
  save: '确认修改',
  saving: '正在保存…',
  cancel: '取消',
  saved: '修改已保存',
  failedSave: '修改没有保存',
  noChanges: '没有修改内容',
  sizeMissing: '新尺码没有可扣库存，请先核对库存',
  amountRequired: '金额要填 0 或正数',
  confirmTitle: '确认修改',
  confirmHint: '请核对修改前后的内容，确认后会直接改原单。',
  fromLabel: '原',
  toLabel: '新',
});
