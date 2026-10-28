/**
 * 「销售交割单」页的**逐条事项构建**（纯函数，无 DOM / 无网络）。
 *
 * 业务负责人 2026-10-29 定稿：
 *   · **一张卡 = 一个销售单号**（同一单号的多条明细放在同一张卡里，按行展示）；
 *   · 货未清：卡内列出全部「未交付」明细，每行一个「交付」按钮；
 *   · 钱未清：卡内列出全部明细，不出现交付按钮，只有付款入口；
 *   · 钱货都未清：卡内列出全部「未交付」明细（每行一个交付按钮）+ 付款入口；
 *   · 钱货都未清只进第三个 tab，不在前两个重复；
 *   · 销售单号只作内部聚合键，**不渲染**。
 */

import { isMoneyNotClear, tabKeyOf } from './filter.js';

const undeliveredDetailsOf = (group, statuses) => (group.details || [])
  // 只认「未交付」；售后状态（已换货/已退货/已赔货）按已结清算，不算货没交清。
  .filter((line) => line.fulfillmentStatus === statuses.undelivered);

/** 一张卡（一个销售单号）。 */
const cardOf = ({ kind, group, details, hasAmounts = false }) => ({
  kind,
  // ⚠️ `orderNo` 只作内部排序 / 测试定位，**不渲染**（业务负责人：不显示销售单号）。
  orderNo: group.orderNo,
  salesEntryRecordId: group.salesEntryRecordId || '',
  soldAt: group.soldAt,
  details,
  payableAmount: group.payableAmount,
  pendingAmount: group.pendingAmount,
  hasAmounts,
});

/**
 * 正常订单分组 → 三个 tab 的卡片（**每个销售单号只出一张卡**，只进一个 tab）。
 * @returns {Record<string, Array>} `{ [tab.key]: card[] }`
 */
export const buildTabItems = (groups = [], statuses = {}, tabs = []) => {
  const out = Object.fromEntries((Array.isArray(tabs) ? tabs : []).map((tab) => [tab.key, []]));
  for (const group of Array.isArray(groups) ? groups : []) {
    const tabKey = tabKeyOf(group, tabs);
    const tab = tabs.find((entry) => entry.key === tabKey);
    if (!tab) continue;
    if (tab.match === 'goodsOnly') {
      out[tab.key].push(cardOf({
        kind: 'goods',
        group,
        details: undeliveredDetailsOf(group, statuses),
        hasAmounts: false,
      }));
      continue;
    }
    out[tab.key].push(cardOf({
      kind: tab.match === 'both' ? 'both' : 'money',
      group,
      details: tab.match === 'both' ? undeliveredDetailsOf(group, statuses) : (group.details || []),
      hasAmounts: true,
    }));
    // 钱没清但收款行状态异常时，tabKeyOf 不会把它归进钱 tab；这里保留显式守卫，
    // 防止以后扩展 unpaidStatuses 时出现"有卡无付款入口"的静默问题。
    if (tab.match !== 'both' && !isMoneyNotClear(group, statuses)) out[tab.key].pop();
  }
  return out;
};
