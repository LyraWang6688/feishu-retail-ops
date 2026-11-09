/**
 * 「货品 → 数据配置」页（业务负责人 2026-11-10）：
 *   一张按钮卡 = **存量写入**：把「货品信息」里"有样例图但没勾已同步云盘"的记录
 *   逐条传到云盘并勾上（新增那条链路是事件驱动；这里只补历史）。
 *
 * 文案 / 接口路径全在这里（页面渲染与点击处理都不写死字符串）。
 */

export const DATA_CONFIG_API = Object.freeze({
  // 同一个路径：POST = 启动一轮存量同步；GET = 查进度（页面轮询）
  sampleImageSync: '/api/workbench/data-config/sample-image-sync',
  voucherCatalogSync: '/api/workbench/douyin/voucher-catalog-sync',
});

export const DATA_CONFIG_TEXTS = Object.freeze({
  cardIcon: '🖼️',
  cardTitle: '同步存量样例图',
  tileHint: '把「有样例图、但还没勾已同步云盘」的货品补传到云盘',
  // 状态行（模板；占位符缺值用空串顶，不留 {xxx}）
  runningNote: '正在同步…（已处理 {done}/{total} 条，成功 {synced} 条）',
  doneNote: '同步完成：成功 {synced} 条，跳过 {skipped} 条，失败 {failed} 条。',
  errorNote: '同步中断：{error}（失败 {failed} 条，可再点一次继续补）',
  startFailedNote: '没能开始同步，请稍后重试',
  // 轻量 toast（点完/跑完各一句；3 秒消失，不挡页面）
  startToast: '已开始同步存量样例图…',
  finishedToast: '存量样例图同步结束：成功 {synced} 条，跳过 {skipped} 条，失败 {failed} 条',
  pollFailedNote: '查不到同步进度，请刷新页面重试',
  voucherRunningNote: '正在同步团购券数据…',
  voucherDoneNote: '已同步 {catalogProducts} 张券，写回 {written} 条',
  voucherFailedNote: '同步团购券失败，请稍后重试',
  voucherStartToast: '已开始同步团购券数据…',
});
