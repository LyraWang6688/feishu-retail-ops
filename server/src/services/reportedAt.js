// 「报货日」（= 飞书**自动**字段，schema 语义键 `purchaseOrderBatch.createdAt`
// → 「报货批次.报货日」）在 9 点推送那行文字里的样子。
//
// 为什么单独一个文件：这个格式要**两处用**（取数那边的 `PendingPushCandidateService`
// 与渲染那边的 `PendingDealPushService`），两处各写一遍迟早走歪。
//
// 口径：**上海自然日** `YYYY-MM-DD`（门店按上海时间营业；服务器是 UTC，
// 用本地时区会把凌晨的批次算成前一天）。日期算术复用 `saleLookupService` 的
// `asDate` / `shanghaiDayKey` —— 全仓只有那一处实现，这里不重写。
//
// ⚠️ 读不出来（空 / 认不出的形状）返回**空串**，不是 `—`：交给渲染层决定给不给占位
//    （业务负责人点名过"缺字段照推、绝不静默丢单"）。

const { asDate, shanghaiDayKey } = require('./saleLookupService');

const formatReportedAtText = (value) => {
  const date = asDate(value);
  return date ? shanghaiDayKey(date) : '';
};

module.exports = { formatReportedAtText };
