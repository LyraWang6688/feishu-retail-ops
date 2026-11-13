/** 「库存 → 手工调整」入口卡配置（2026-11-11）。 */
export const INVENTORY_MANUAL_CARDS = Object.freeze([
  { id: 'single', icon: '↗', label: '单双调整' },
  { id: 'batch', icon: '☰', label: '批量调整' },
]);

export const INVENTORY_MANUAL_TEXTS = Object.freeze({
  batchLoading: '正在读取品类和库存…',
  statusFilterLabel: '问题类型',
  statusFilterAll: '全部问题',
  statusIssueExtra: '样品多 {count} 双',
  statusIssueExtraGroup: '样品多',
  statusIssueEmpty: '状态为空',
  statusIssueMissing: '缺样品',
  statusGroupCount: '{count} 个货号',
  singleScan: '扫描二维码',
  singleInput: '输入货号',
  singlePickTitle: '选择编号',
  singleSearchPlaceholder: '输入货号，选择要调整的编号',
  singleSearchLoading: '正在查询货号…',
  singleSearchEmpty: '没有匹配的货号。',
  singleSearchFailed: '查询失败，请稍后重试',
  productSearchApi: '/api/workbench/products/search',
  submittedToast: '数据提交成功，后台自动写入',
  printWaiting: '正在等待库存调整完成，然后提交打印…',
  printJobMissing: '打印任务没有创建成功，请重试。',
  inventoryJobTimeout: '库存调整还没有完成，请稍后在工作台重试打印。',
});
