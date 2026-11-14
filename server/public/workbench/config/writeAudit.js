export const WRITE_AUDIT_PAGE = Object.freeze({
  api: '/api/workbench/write-audit',
});

export const WRITE_AUDIT_TEXTS = Object.freeze({
  title: '数据写入审计',
  back: '‹ 返回',
  recentTitle: '过去 24 小时写入',
  recentLoading: '正在读取过去 24 小时写入…',
  empty: '过去 24 小时没有写入记录。',
  loadFailed: '写入记录读取失败，请稍后重试。',
  total: '{count} 条写入',
  hint: '按写入任务由近及远；同一个写入任务内按写入顺序排列。',
  trace: '提交批次',
  table: '数据表',
  operation: '操作',
  record: '记录',
  fields: '写入字段',
  noFields: '没有字段信息',
  noTrace: '未关联任务',
  taskCount: '{count} 条写入',
});
