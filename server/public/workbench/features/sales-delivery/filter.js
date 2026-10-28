/**
 * 「销售交割单」预览页的**筛选 / 并集纯函数**（无 DOM / 无网络）。
 *
 * 口径（2026-10-28 业务负责人确认）：
 *   · **货没交清** = 明细履约状态 ==「未交付」；已换货/已退货/已赔货按售后已结清（业务负责人 2026-10-29）；
 *   · **钱没清** = 收款状态 ∈ `unpaidStatuses`（本轮只有「未收款」；**不**含「待平台结算」）；
 *   · 同一**销售单号**取并集（货没清 / 钱没清 / 两者都有）；已两清（两者都不成立）不展示。
 */

export const isGoodsNotClear = (order = {}, statuses = {}) => (Array.isArray(order.details) ? order.details : [])
  // 业务负责人 2026-10-29：货没交清 = **只认「未交付」**；已换货/已退货/已赔货算售后已结清。
  .some((line) => line.fulfillmentStatus === statuses.undelivered);

export const isMoneyNotClear = (order = {}, statuses = {}) => {
  const unpaid = Array.isArray(statuses.unpaidStatuses) ? statuses.unpaidStatuses : [];
  return (Array.isArray(order.payments) ? order.payments : [])
    .some((payment) => unpaid.includes(payment.status));
};

const emptyGroup = (orderNo) => ({
  orderNo,
  recordIds: [],
  details: [],
  payments: [],
  payableAmount: null,
  pendingAmount: 0,
  pendingDeliveryQuantity: 0,
  soldAt: null,
  soldAtSource: 'missing',
});

/** 正常订单（已归一化）→ 交割单分组（只剩货没清 / 钱没清 / 两者都有）。 */
export const buildDeliveryGroups = (orders = [], statuses = {}) => {
  const byOrderNo = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || !order.orderNo) continue;
    const group = byOrderNo.get(order.orderNo) || emptyGroup(order.orderNo);
    group.recordIds.push(order.recordId);
    group.details.push(...order.details);
    group.payments.push(...order.payments);
    if (order.payableAmount != null) group.payableAmount = (group.payableAmount ?? 0) + order.payableAmount;
    group.pendingAmount += order.pendingAmount;
    group.pendingDeliveryQuantity += order.pendingDeliveryQuantity;
    if (order.soldAt != null && (group.soldAt == null || order.soldAt < group.soldAt)) {
      group.soldAt = order.soldAt;
      group.soldAtSource = order.soldAtSource;
    }
    byOrderNo.set(order.orderNo, group);
  }

  return [...byOrderNo.values()]
    .map((group) => {
      const goodsNotClear = isGoodsNotClear(group, statuses);
      const moneyNotClear = isMoneyNotClear(group, statuses);
      return { ...group, goodsNotClear, moneyNotClear };
    })
    .filter((group) => group.goodsNotClear || group.moneyNotClear);
};


/** 一个分组的归类判据（key 来自 config 的 `tabs[*].match`；不写死 tab key）。 */
const MATCHERS = {
  goodsOnly: (group) => group.goodsNotClear && !group.moneyNotClear,
  moneyOnly: (group) => !group.goodsNotClear && group.moneyNotClear,
  both: (group) => group.goodsNotClear && group.moneyNotClear,
};

/** 这个分组属于哪个 tab（认不出 ⇒ `null`，不硬塞进任何 tab）。 */
export const tabKeyOf = (group = {}, tabs = []) => {
  const hit = (Array.isArray(tabs) ? tabs : []).find((tab) => MATCHERS[tab.match]?.(group));
  return hit ? hit.key : null;
};

/** 按配置的 tab 顺序分组（**每个分组只进一个 tab**：货/钱都未清只进 both，不重复）。 */
export const groupByTab = (groups = [], tabs = []) => (Array.isArray(tabs) ? tabs : []).map((tab) => ({
  tab,
  groups: (Array.isArray(groups) ? groups : []).filter((group) => tabKeyOf(group, tabs) === tab.key),
}));


/** 按「货号」筛选事项（`product` 为空 = 全部；匹配任一明细的货号）。 */
export const filterItemsByProduct = (items = [], product = '') => {
  const wanted = String(product ?? '').trim();
  if (!wanted) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : [])
    .filter((item) => (item.details || []).some((line) => String(line.product ?? '').trim() === wanted));
};
