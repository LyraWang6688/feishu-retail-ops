'use strict';

/**
 * ⭐⭐ 2026-10-14（业务负责人逐字）：「**数据从 20261015 开始**」
 *   ＋ 她更早的同源口径：「**存量行不用管，就看增量**」
 *
 * =「自动挑出来提醒 / 列出来」这一类**只看这一天（含）之后** ✓；之前的存量**一律不管** ✗。
 *
 * 🔴 **故意不受它约束**（她**当下正在做的那一单**当然要处理 ✓ 不许拦她 ✗）：
 *   · 扫码页的提交 / 交付（她扫的那一单）· 工作台的**单笔**操作（补记收款 / 交付并扣库存）
 *   · 群聊里她**点名**的那一单 · 「未完成，可点重试」里她**点重试那一刻**
 *
 * ⚠️ 判据**只有这一处实现** ✗（不许各处自己比字符串 ✗）；时区**按上海** ✓
 *    （项目里"哪一天"一律按上海算 —— 与 `utils/shanghaiDay` 同源口径）。
 */
const DATA_SINCE = '2026-10-15';

// 上海日口径的唯一实现：`utils/shanghaiDay`（2026-11-14 收口；这里只 re-export）。
const { shanghaiDayKeyOf } = require('../utils/shanghaiDay');

/**
 * ⭐ **唯一判据**：这一天（上海）在 `DATA_SINCE`（含）之后吗？
 *   · 认不出的输入 ⇒ `false`（**宁可不动** ✗ 也不误挑 ✓）—— 调用方按"存量"处理 ✓
 *   · 字符串按 `YYYY-MM-DD` 直接比（同格式字典序 = 时间序 ✓）
 */
const isOnOrAfterSince = (value) => {
  const key = shanghaiDayKeyOf(value);
  if (!key) return false;
  return key >= DATA_SINCE;
};

module.exports = { DATA_SINCE, shanghaiDayKeyOf, isOnOrAfterSince };
