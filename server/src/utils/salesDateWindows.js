/**
 * ⭐⭐ 2026-10-12：**销售日期窗口的共用工具**（从 `services/saleLookupService.js` **逐字搬来**）。
 *
 * 为什么搬：群查单那条链路正在退场 ⇒ 不能让"别的链路"（二次交付 · 待处理单推送 · 报表 ·
 * 凭证结算）继续依赖一个**以查单命名**的文件 ✗（下一个人会以为查单还在 ✓）。
 * 🔴 **纯搬移**：实现一字不改 ✓；消费者**只改 import 路径**、逻辑与断言一个字不动 ✓。
 */
const { textValue } = require('../services/v1BitableGateway');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

// ⚠️ 这个常量原来是 `config/saleLookup.js` 里的（那份配置要随查单**整份退场** ✓）
//    ⇒ 逐字搬一份过来（值完全相同 ✓），免得工具跟着一起死 ✗。
const DAY_MS = 24 * 60 * 60 * 1000;

const asDate = (value) => {
  if (value == null || value === '') return null;
  const raw = typeof value === 'number' ? value : textValue(value).trim();
  if (raw === '') return null;
  const timestamp = typeof raw === 'number' || /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = timestamp === null ? new Date(raw) : new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

// 东八区日键：门店按上海时间营业，"最近几天"必须按上海的自然日算，
// 不能按服务器时区（线上是 UTC，会把凌晨的单算到前一天）。
const shanghaiDayKey = (date) =>
  new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);

const shanghaiDayStart = (date) => Date.parse(`${shanghaiDayKey(date)}T00:00:00+08:00`);

/**
 * 查询窗口 = 今天 + 往前 (days - 1) 个上海自然日。
 *
 * 为什么用自然日而不是「now - days×24h」：产品负责人说的是「最近 5 天内」，
 * 门店理解的是"今天和前几天"。写成滚动 24 小时的话，同一个上午查两次的窗口不一样，
 * 她没法预期"几天前那笔还在不在"。
 */
const lookupWindowStart = ({ now, days }) => shanghaiDayStart(now) - (days - 1) * DAY_MS;

const isWithinLookupWindow = (date, { now, days }) =>
  Boolean(date) && date.getTime() >= lookupWindowStart({ now, days });

module.exports = {
  SHANGHAI_OFFSET_MS,
  DAY_MS,
  asDate,
  shanghaiDayKey,
  shanghaiDayStart,
  lookupWindowStart,
  isWithinLookupWindow,
};
