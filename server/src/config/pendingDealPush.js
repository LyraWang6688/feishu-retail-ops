// 「维度 1：每天 9 点把最近 7 天未付 / 预付、尚未成交的销售单推到群里」的配置
// （配置先行——群 id / 时间点 / 开关 / 深链策略都是**会改的口径**，改的时候只动这一个文件，
//   不去翻 pendingDealPushService）。
//
// ⚠️ 所有开关一律**显式布尔**：不写 `process.env.X || fallback`。
//   `||` 把空串当"没配"，于是 `PENDING_DEAL_PUSH_ENABLED=`（她想关掉）会静默回退到 default，
//   关不掉——这正是仓库里 `getEnv` 那个形状踩过的坑。本文件的规则：
//     · **变量没设**（undefined / null）→ 用默认值；
//     · **变量设了**（哪怕是空串）→ 就是她的显式取值，空串 = false（关）；
//     · 设成了认不出来的值 → **当场抛错**，不猜（静默按 true/false 处理是最坏的一种）。
//
// 单测直接传 env 进来（不碰全局 process.env），并发跑用例不会互相污染。

const PENDING_DEAL_PUSH_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_ENABLED';
const PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY = 'PENDING_DEAL_PUSH_CHAT_ID';
const PENDING_DEAL_PUSH_HOUR_ENV_KEY = 'PENDING_DEAL_PUSH_HOUR';
const PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY = 'PENDING_DEAL_PUSH_INTERVAL_MS';
const PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED';
const PENDING_DEAL_PUSH_LINK_TEMPLATE_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_TEMPLATE';
const PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_REQUIRED';

// 默认 9 点（北京时间，业务负责人说的）。
const DEFAULT_PUSH_HOUR = 9;
// 默认 10 分钟一 tick：与「第二次交付」提醒同一个节奏。判断"今天该不该跑"不靠定时精度，
// 而靠**按天认领**（见 pendingDealPushService.sendDailyPush），所以 tick 落在哪一刻无所谓。
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

const readRaw = (env, key) => {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null) return null;
  return String(raw).trim();
};

/** 显式字符串：没设 → 默认值；设了（含空串）→ 原样返回。 */
const readString = (env, key, fallback) => {
  const raw = readRaw(env, key);
  return raw === null ? fallback : raw;
};

/**
 * 显式布尔。空串 = false（"设成空 = 关掉"），认不出来的值抛错。
 * 之所以不给空串留"回退默认"的口子，见文件头的说明。
 */
const readFlag = (env, key, fallback) => {
  const raw = readRaw(env, key);
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (value === '' || ['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${key} 必须是显式布尔（true/false/1/0/yes/no/on/off），当前值无法识别`);
};

const readInt = (env, key, fallback, { min, max }) => {
  const raw = readRaw(env, key);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min}~${max} 之间的整数，当前值无法识别`);
  }
  return value;
};

/**
 * 一次把整份配置读出来。**只读一次、集中在启动时**：配置写错要在服务起来的那一刻就吵，
 * 而不是等到第二天 9 点推送时才失败（那时没人看着日志）。
 */
const resolvePendingDealPushConfig = (env = process.env) => ({
  enabled: readFlag(env, PENDING_DEAL_PUSH_ENABLED_ENV_KEY, false),
  // 群 id 没有默认值：没配 → 本次不推、只记一条警告，**绝不回落到发给某个人**。
  chatId: readString(env, PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY, ''),
  hour: readInt(env, PENDING_DEAL_PUSH_HOUR_ENV_KEY, DEFAULT_PUSH_HOUR, { min: 0, max: 23 }),
  intervalMs: readInt(env, PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY, DEFAULT_INTERVAL_MS, { min: 1000, max: 24 * 60 * 60 * 1000 }),
  // 深链**现查**开关：拿不到 `message_app_link` 时要不要每次去问一次飞书。
  // 默认开——那是官方声明过的字段，将来飞书开始返回就自动生效，不用改代码。
  // 实测（2026-10-06）当前**不返回**，见 services/larkMessageLinkResolver 的注释。
  linkLookupEnabled: readFlag(env, PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY, true),
  // 深链模板（运营自己填的、可选的兜底）。默认空 = 不拼任何 URL。
  // 占位符：{message_id} / {thread_id} / {chat_id}。见 larkMessageLinkResolver。
  linkTemplate: readString(env, PENDING_DEAL_PUSH_LINK_TEMPLATE_ENV_KEY, ''),
  // 拿不到深链时要不要**干脆不推**。默认 false = 照推单号 + 金额（深链是增强，不是前提）。
  linkRequired: readFlag(env, PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY, false),
});

module.exports = {
  PENDING_DEAL_PUSH_ENABLED_ENV_KEY,
  PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY,
  PENDING_DEAL_PUSH_HOUR_ENV_KEY,
  PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_TEMPLATE_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY,
  DEFAULT_PUSH_HOUR,
  DEFAULT_INTERVAL_MS,
  resolvePendingDealPushConfig,
  // 导出给单测直接盯住"显式布尔"这条规矩（它坏掉的方式是静默的）。
  readFlag,
};
