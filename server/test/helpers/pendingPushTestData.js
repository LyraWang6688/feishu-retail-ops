// 「9 点待处理单推送」用例的一个小替身：**把"一大票单据"变成"一行"**。
//
// 为什么要有它（2026-10-08 第一步之后）：
//   候选口径改成"【预定】按**销售单号**一行 / 【现货未收】按**销售单号**一行"之后，
//   `PendingDealPushService` 的入口不再是"销售单数组"，而是**行**（`candidateRows`）。
//   这个 helper 只做一件机械的事：把老用例里那种"单据对象"翻译成**行**，让那些文件里
//   几百个 `newService({ orders })` 调用点**一个字都不用改**。
//
// ⚠️ 它**不实现业务口径**（那在 `config/pendingPushCandidates` + `PendingPushCandidateService`，
//    也由 `pendingPushCandidateCaliber.test.js` 直接盯着那一处）：
//   这里只是"一张单 = 1 行，带上它自己的 items / pendingAmount"的搬运工，
//   分区仍是 `PendingDealPushService.buildSections` 的 `criterion` 分组在做。
//
// 约定：单据对象上那两个字段就是行上的两个字段（`items` / `pendingAmount`），
// 所以断言里写的字**完全不用动**。

/**
 * 单据数组 → 行数组（一单一行）。
 * @param {Array<object>} orders `{ salesEntryRecordId, fulfillmentStatus, pendingAmount, items }`
 */
const saleRowsFromOrders = (orders = []) => (orders || []).map((order, index) => ({
  rowId: order.rowId || order.salesEntryRecordId || `row_${index}`,
  salesEntryRecordId: order.salesEntryRecordId || '',
  // 分区判据：与配置里的两个判据同名（`undelivered` / `delivered_unpaid`）。
  criterion: order.fulfillmentStatus === '已交付' ? 'delivered_unpaid' : 'undelivered',
  facts: order.items || [],
  pendingAmount: order.pendingAmount,
  url: order.url || '',
}));

/**
 * `PendingDealPushService` 的候选替身（**只**实现那一个入口）。
 * 返回值形状与该 service 真实入口一致：`{ sections, rows, purchase }`。
 */
const fakeCandidates = ({ orders = [], purchase = [] } = {}) => ({
  listCandidates: async () => ({
    sales: saleRowsFromOrders(orders),
    cash: [],
    purchase,
  }),
  formatReportedAt: () => '',
});

module.exports = { saleRowsFromOrders, fakeCandidates };
