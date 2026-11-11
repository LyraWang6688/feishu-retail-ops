/** 库存调整保存后跳转的「打印状态」区文案（页面不写死句子）。 */
export const LABEL_PRINT_STATUS_TEXTS = Object.freeze({
  title: '刚刚的打印任务',
  loading: '正在读取打印状态…',
  queued: '已提交，等待打印',
  claimed: '打印电脑已取走',
  done: '已打印',
  failed: '打印失败',
  unknown: '状态未知',
  numbers: '货号：{numbers}',
  submittedAt: '提交时间：{time}',
  online: '打印电脑在线',
  offline: '打印电脑未连接（任务已排队）',
  reason: '失败原因：{reason}',
  missing: '没有找到这条打印任务。',
  continueHint: '仍可继续扫码打印下一张。',
});
