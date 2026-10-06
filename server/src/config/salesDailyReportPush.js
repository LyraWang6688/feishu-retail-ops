// 「销售战报 · 定时推送」的配置（配置先行）。
//
// 口径**以 `docs/sales-daily-report-push-2026-10-06.md` 为准**（业务负责人 2026-10-06 逐字确认）：
//   · 时间（北京时间）：9 / 12 / 15 / 18 / 21 点（每 3 小时）＋ **22 点（当日收官）**；
//   · 形式：**消息卡片**；发到**收采购图 / 退货单那个群**（`PURCHASE_CHAT_ID`）的**主聊天**；
//   · 两个数字：销售的单数 = 「销售明细」里「履约状态 = 已履约」的**条数**
//     （她：**一条明细 = 一双鞋 = 一个销售单子**，明细没有"数量"字段）；
//     销售的金额 = 「收款明细」里「已收款」、且**收款时间是今天、截至推送那一刻**的金额合计。
//
// ⚠️ 一切"会改的口径"都在这里：时间点 / 群列表 / 开关 / 两个筛选值。
//   换一个值只改这一个文件（或环境变量），不去翻 salesDailyReportService。
// ⚠️ 取值规则（"空串算不算关"）与 `pendingDealPush` **共用一套**实现：`config/envValue`。
//
// 单测直接传 env 进来（不碰全局 process.env），并发跑用例不会互相污染。

const { readRaw, readString, readFlag, readInt, readOptionalInt, readList } = require('./envValue');
const { resolvePurchaseChatId } = require('./groupPurchase');

const SALES_DAILY_REPORT_PUSH_ENABLED_ENV_KEY = 'SALES_DAILY_REPORT_PUSH_ENABLED';
const SALES_DAILY_REPORT_PUSH_CHAT_IDS_ENV_KEY = 'SALES_DAILY_REPORT_PUSH_CHAT_IDS';
const SALES_DAILY_REPORT_PUSH_HOURS_ENV_KEY = 'SALES_DAILY_REPORT_PUSH_HOURS';
const SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR_ENV_KEY = 'SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR';
const SALES_DAILY_REPORT_PUSH_INTERVAL_MS_ENV_KEY = 'SALES_DAILY_REPORT_PUSH_INTERVAL_MS';
const SALES_DAILY_REPORT_FULFILLED_STATUSES_ENV_KEY = 'SALES_DAILY_REPORT_FULFILLED_STATUSES';
const SALES_DAILY_REPORT_PAYMENT_STATUS_ENV_KEY = 'SALES_DAILY_REPORT_PAYMENT_STATUS';

// 默认时段（北京时间）：每 3 小时一次 —— 她说的 9 / 12 / 15 / 18 / 21。
const DEFAULT_PUSH_HOURS = Object.freeze([9, 12, 15, 18, 21]);
// 当日收官那一条：22 点（她确认过「21 点和 22 点只差一个小时」）。
const DEFAULT_SUMMARY_HOUR = 22;
// 10 分钟一 tick（与「第二次交付」「未付/预付」两条推送同一节奏）。
// 判断"这个时段该不该推"不靠定时精度，靠**按时段认领**（见 salesDailyReportService）。
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
// 「算作已履约」的取值。她逐字说的是「已履约」，但**真表里这一列的选项叫「已交付」**
// （2026-10-06 晚只在测试 Base 上实读核对过：当天 46 条已交付 / 6 条未交付 / 1 条已退货 / 1 条空；
//   仓库里写这一列的代码也一直写「已交付」，见 salesDeliveryService / afterSalesService）。
// ⇒ 默认**两个都算**：任一行只会命中其中一个，不会重复计数；将来她把选项改名 / 两种并存都不出错。
// ⚠️ 改了名只改这一个配置，不用改代码。
// ⭐ 业务负责人 2026-10-06 晚【两次强调】：**「只有已交付的选项」** ——
//    她发来生产表截图确认「履约状态」的选项是 未交付/已交付/已退货/已换货/已赔货，
//    并说「销售单数 = 销售明细里 履约状态 = 已交付 的条数」。
//    ⚠️ 不要再把「已履约」加回来（表里没有这个选项）。
const DEFAULT_FULFILLED_STATUSES = Object.freeze(['已交付']);
// 「已收款」（「待平台结算」不算收到钱）。
const DEFAULT_PAYMENT_STATUS = '已收款';

/** 时段列表：逗号/空白分隔的 0–23 整数，去重且**升序**（推的顺序要可预期）。 */
const readHours = (env, key, fallback) => {
  const raw = readList(env, key);
  if (raw === null) return [...fallback];
  // ⚠️ 显式设成空 = "一个常规时段都不要"（那就只剩收官那一条），不回退默认值。
  if (!raw.length) return [];
  return [...new Set(raw.map((item) => {
    const value = Number(item);
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      throw new Error(`${key} 里必须是 0~23 的整点，当前值无法识别：${item}`);
    }
    return value;
  }))].sort((left, right) => left - right);
};

/**
 * 一次把整份配置读出来（**启动时读一次**：写错要在服务起来的那一刻就吵，
 * 而不是等到第二天 9 点推送时才失败——那时没人看日志）。
 */
const resolveSalesDailyReportPushConfig = (env = process.env) => {
  const hours = readHours(env, SALES_DAILY_REPORT_PUSH_HOURS_ENV_KEY, DEFAULT_PUSH_HOURS);
  // 收官整点：**没设** → 默认 22 点；**设了** → 用它（空串 = 不要收官那一条）。
  const summaryHour = readRaw(env, SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR_ENV_KEY) === null
    ? DEFAULT_SUMMARY_HOUR
    : readOptionalInt(env, SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR_ENV_KEY, { min: 0, max: 23 });
  if (summaryHour !== null && hours.includes(summaryHour)) {
    throw new Error(
      `${SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR_ENV_KEY}=${summaryHour} 同时出现在 `
      + `${SALES_DAILY_REPORT_PUSH_HOURS_ENV_KEY} 里：收官那一条要么单独一个整点、要么留空不要，别两边都放`,
    );
  }

  // 群列表（做成列表：将来加运营群只改配置）。
  // ⚠️ 语义：**这一行没设** → 回落到 `PURCHASE_CHAT_ID`（她说的那个收采购图/退货单的群）；
  //    **设成空** → 显式的"一个群都不发"（不回退）——与 envValue 的总体规矩一致。
  const configuredChatIds = readList(env, SALES_DAILY_REPORT_PUSH_CHAT_IDS_ENV_KEY);
  const purchaseChatId = String(resolvePurchaseChatId(env) || '').trim();
  const chatIds = configuredChatIds === null
    ? (purchaseChatId ? [purchaseChatId] : [])
    : configuredChatIds;
  const chatFallback = configuredChatIds === null && Boolean(purchaseChatId);

  const fulfilledStatuses = readList(env, SALES_DAILY_REPORT_FULFILLED_STATUSES_ENV_KEY);
  const paymentStatus = readString(env, SALES_DAILY_REPORT_PAYMENT_STATUS_ENV_KEY, DEFAULT_PAYMENT_STATUS);

  return {
    enabled: readFlag(env, SALES_DAILY_REPORT_PUSH_ENABLED_ENV_KEY, false),
    chatIds,
    // 有没有"按 PURCHASE_CHAT_ID 回落"——只用来在启动日志里说清楚群是从哪来的。
    chatFallback,
    hours,
    summaryHour,
    // 定时器要盯的全部整点（常规 + 收官），升序去重。
    slots: [...new Set([...hours, ...(summaryHour === null ? [] : [summaryHour])])]
      .sort((left, right) => left - right),
    intervalMs: readInt(env, SALES_DAILY_REPORT_PUSH_INTERVAL_MS_ENV_KEY, DEFAULT_INTERVAL_MS, {
      min: 1000, max: 24 * 60 * 60 * 1000,
    }),
    fulfilledStatuses: fulfilledStatuses === null ? [...DEFAULT_FULFILLED_STATUSES] : fulfilledStatuses,
    paymentStatus: paymentStatus.trim() || DEFAULT_PAYMENT_STATUS,
  };
};

module.exports = {
  SALES_DAILY_REPORT_PUSH_ENABLED_ENV_KEY,
  SALES_DAILY_REPORT_PUSH_CHAT_IDS_ENV_KEY,
  SALES_DAILY_REPORT_PUSH_HOURS_ENV_KEY,
  SALES_DAILY_REPORT_PUSH_SUMMARY_HOUR_ENV_KEY,
  SALES_DAILY_REPORT_PUSH_INTERVAL_MS_ENV_KEY,
  SALES_DAILY_REPORT_FULFILLED_STATUSES_ENV_KEY,
  SALES_DAILY_REPORT_PAYMENT_STATUS_ENV_KEY,
  DEFAULT_PUSH_HOURS,
  DEFAULT_SUMMARY_HOUR,
  DEFAULT_INTERVAL_MS,
  DEFAULT_FULFILLED_STATUSES,
  DEFAULT_PAYMENT_STATUS,
  resolveSalesDailyReportPushConfig,
};
