/**
 * 「销售交割单」原型页的**销售日分组**（纯函数，无 DOM / 无网络）。
 *
 * 业务负责人 2026-10-29：页面按**销售日**分组（日期只出现在分组头，卡片行内不再重复日期）；
 * 组顺序仍按销售日**远→近（旧→新）**；没有销售日的分组排最后（不猜日期）。
 */

import { dateKeyOf, formatShortDate } from './format.js';

const productOf = (item = {}) => String((item.details || [])[0]?.product ?? '').trim();

export const groupItemsBySoldDate = (items = [], missingLabel = '') => {
  const buckets = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = dateKeyOf(item.soldAt);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => {
      if (left === '') return 1;
      if (right === '') return -1;
      return left.localeCompare(right);
    })
    .map(([key, list]) => ({
      key,
      label: key ? formatShortDate(list[0]?.soldAt) : missingLabel,
      // 同一天内：按货号升序（同一货号挨着），再按内部单号，保证稳定。
      items: [...list].sort((left, right) => productOf(left).localeCompare(productOf(right))
        || String(left.orderNo).localeCompare(String(right.orderNo))),
    }));
};
