export const WRITE_AUDIT_PAGE = Object.freeze({
  api: '/api/workbench/write-audit',
  orderQueryKey: 'order_no',
});

export const WRITE_AUDIT_TEXTS = Object.freeze({
  title: '写入时序',
  back: '‹ 返回',
  orderLabel: '销售单号',
  query: '查询',
  loading: '正在读取写入记录…',
  empty: '没有找到这一单的写入记录。',
  loadFailed: '写入记录读取失败，请稍后重试。',
  total: '{count} 条写入',
  trace: '提交批次',
  table: '数据表',
  operation: '操作',
  record: '记录',
  fields: '写入字段',
  noFields: '没有字段信息',
});
