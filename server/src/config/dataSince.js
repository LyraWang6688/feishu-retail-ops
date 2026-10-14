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

const pad = (n) => String(n).padStart(2, '0');

/** 把各种输入统一成**上海的** `YYYY-MM-DD`；认不出 ⇒ `''`（**不猜** ✗）。 */
const shanghaiDayKeyOf = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const raw = value.trim();
    // ⭐ 纯日期（只有 YYYY-MM-DD，**不带时间**）⇒ 直接就是上海那一天 ✓
    const plain = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (plain) return `${plain[1]}-${plain[2]}-${plain[3]}`;
    // ⭐ 带时间/时区的字符串（`2026-10-14T16:30:00Z`）⇒ **按时间戳解析**再折算上海 ✗ 不许只看日期前缀 ✗
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      const t = new Date(parsed + 8 * 3600 * 1000);
      return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    }
    const asNum = Number(raw);
    if (!Number.isFinite(asNum)) return '';
    value = asNum;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    // 上海 = UTC+8（项目所在地不涉及夏令时 ✓）
    const t = new Date(value.getTime() + 8 * 3600 * 1000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  // 10 位 = 秒；13 位 = 毫秒（两种都吃 ✓）
  const ms = num < 1e12 ? num * 1000 : num;
  const t = new Date(ms + 8 * 3600 * 1000);
  if (Number.isNaN(t.getTime())) return '';
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};

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
