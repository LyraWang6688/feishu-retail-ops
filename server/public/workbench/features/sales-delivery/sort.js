/**
 * 「销售交割单」预览页的**排序纯函数**（无 DOM / 无网络）。
 * 默认销售日「旧→新」；没有销售日的排最后（不猜日期），同日期按销售单号稳定排序。
 */

export const sortDeliveryGroups = (groups = [], direction = 'asc') => {
  const desc = direction === 'desc';
  return [...(Array.isArray(groups) ? groups : [])].sort((left, right) => {
    if (left.soldAt == null && right.soldAt == null) return String(left.orderNo).localeCompare(String(right.orderNo));
    if (left.soldAt == null) return 1;
    if (right.soldAt == null) return -1;
    if (left.soldAt === right.soldAt) return String(left.orderNo).localeCompare(String(right.orderNo));
    return desc ? right.soldAt - left.soldAt : left.soldAt - right.soldAt;
  });
};
