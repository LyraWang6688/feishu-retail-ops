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
  // 单双调整 / 批量当季调整的页内文案（2026-11-14 #1206：页面里不再写中文字面量）
  rowsRequired: '请至少保留一行数量大于 0 的库存',
  submittedStock: '已提交，后台写入库存',
  seasonApplied: '已提交，后台设为当季',
  seasonCleared: '已提交，后台入库',
  categoryRequired: '请先选择品类',
  inventoryJobFailed: '库存调整失败',
  scanNoProduct: '没有认出货品编号，请重新扫码。',
  scanNoSdk: '当前设备调不起飞书扫一扫，请在飞书里打开工作台。',
  scanFailed: '扫码没有成功，请再试一次。',
  printQueuedToast: '已加入打印队列，库存调整完成后自动打印',
});
