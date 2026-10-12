/**
 * 「**待办汇总发采购群**」的可配参数（业务负责人 2026-10-11 20:30 逐条确认）。
 *
 * 她的口径（逐字要点）：
 *   · **一天 5 次**：`09:00 → 12:00 → 15:00 → 18:00 → 21:00`（**时点做配置，不写死**）；
 *   · **完全单独一条消息**（**不并进**现有 9 点推送那条）；
 *   · **发之前配的那个群** = `PURCHASE_CHAT_ID`（`config/groupPurchase.js` 的 `resolvePurchaseChatId()`）；
 *   · 文案：`待办还有 N 条：待补充 X 条 · 待补样品 Y 条 · 待交割 Z 条 → 去工作台处理`。
 *
 * ⚠️ 与 `config/pendingDealPush.js`（9 点那条）**刻意分开两份配置**：
 *    两条推送的**收件群不同**（那条是 `PENDING_DEAL_PUSH_CHAT_ID`，这条是采购群）、
 *    时间表也不同 ⇒ 合成一份只会在改一边时把另一边带跑。
 */
const path = require('node:path');
const { readString, readFlag, readInt } = require('./envValue');

const ENABLED_ENV_KEY = 'SAMPLE_PENDING_NOTICE_ENABLED';
const HOURS_ENV_KEY = 'SAMPLE_PENDING_NOTICE_HOURS';
const INTERVAL_ENV_KEY = 'SAMPLE_PENDING_NOTICE_INTERVAL_MS';
const STORE_DIR_ENV_KEY = 'SAMPLE_PENDING_NOTICE_STORE_DIR';
const SEND_WHEN_EMPTY_ENV_KEY = 'SAMPLE_PENDING_NOTICE_SEND_WHEN_EMPTY';
const TEXT_ENV_KEY = 'SAMPLE_PENDING_NOTICE_TEXT';

/** 她定的五个时点（上海时间整点）。 */
const DEFAULT_HOURS = Object.freeze([9, 12, 15, 18, 21]);

/**
 * 文案（占位符 `{total}` / `{supplement}` / `{sample}` / `{pending}`）—— 她给的那句，
 * ⚠️ 只在「待补样品」前面加了**两个字「其中」**（2026-10-12 现场事故后）：
 *    `{total}` = `{supplement}` + `{pending}`（**待补样品是待补充的子集、不重复加**；
 *    已两清不是待办）⇒ 加「其中」才能让"10 条待补充里有 8 条是待补样品"这个关系一眼看懂，
 *    否则她又会去把三个数加起来（现场那条 `total=76` 与 `10+8+5=23` 就是这么暴露的）。
 *    （口径与算法见 `services/workbenchOrderSections.js` 的 `workbenchCountsOf`。）
 */
const DEFAULT_TEXT = '待办还有 {total} 条：待补充 {supplement} 条 · 其中待补样品 {sample} 条 · 待交割 {pending} 条 → 去工作台处理';

/** `9,12,15,18,21` → `[9,12,15,18,21]`；非法值**当场抛**（绝不安静地一天不推）。 */
const parseHours = (raw) => {
  if (raw === undefined || raw === null) return [...DEFAULT_HOURS];
  const list = String(raw).split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (!list.length) return [...DEFAULT_HOURS];
  const hours = list.map((item) => Number(item));
  if (hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
    throw new Error(`${HOURS_ENV_KEY} 必须是用逗号分隔的 0~23 整点（例：9,12,15,18,21），当前是「${raw}」`);
  }
  return [...new Set(hours)].sort((left, right) => left - right);
};

const resolveSamplePendingNoticeConfig = (env = process.env) => {
  const hours = parseHours(readString(env, HOURS_ENV_KEY, undefined));
  return Object.freeze({
    // 显式布尔（见 `config/envValue.readFlag`：没设 = 默认；设成空串 = 关掉）
    enabled: readFlag(env, ENABLED_ENV_KEY, true),
    hours,
    // 调度器每个 tick 的间隔（默认 10 分钟，与 9 点那条同一条纪律）
    intervalMs: readInt(env, INTERVAL_ENV_KEY, 10 * 60 * 1000, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    // 「这个时点发过没有」的落盘目录（重启/多 tick 不重复发）
    storeDir: readString(
      env, STORE_DIR_ENV_KEY, path.join(__dirname, '../../data/sample_pending_notice'),
    ),
    // 共 0 条时发不发：默认**不发**（每 3 小时一条"0 条"是噪音）
    sendWhenEmpty: readFlag(env, SEND_WHEN_EMPTY_ENV_KEY, false),
    text: readString(env, TEXT_ENV_KEY, DEFAULT_TEXT),
  });
};

module.exports = {
  ENABLED_ENV_KEY,
  HOURS_ENV_KEY,
  INTERVAL_ENV_KEY,
  STORE_DIR_ENV_KEY,
  SEND_WHEN_EMPTY_ENV_KEY,
  TEXT_ENV_KEY,
  DEFAULT_HOURS,
  DEFAULT_TEXT,
  parseHours,
  resolveSamplePendingNoticeConfig,
};
