// 「维度 1：每天 9 点把最近 7 天未付 / 预付、尚未成交的销售单推到群里」的配置
// （配置先行——群 id / 时间点 / 开关 / 深链策略都是**会改的口径**，改的时候只动这一个文件，
//   不去翻 pendingDealPushService）。
//
// ⚠️ 取值规则（"空串算不算关"那一套）在 `config/envValue`，本文件与销售战报共用同一套，
//   规则只有一处实现，不会两处慢慢走歪。
//
// 单测直接传 env 进来（不碰全局 process.env），并发跑用例不会互相污染。

const { readString, readFlag, readInt } = require('./envValue');

const PENDING_DEAL_PUSH_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_ENABLED';
const PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY = 'PENDING_DEAL_PUSH_CHAT_ID';
const PENDING_DEAL_PUSH_HOUR_ENV_KEY = 'PENDING_DEAL_PUSH_HOUR';
const PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY = 'PENDING_DEAL_PUSH_INTERVAL_MS';
const PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED';
const PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY = 'PENDING_DEAL_PUSH_LINK_REQUIRED';
// 发完之后**把那条消息置顶（飞书 Pin）**。业务负责人 2026-10-07 单独提的那个动作。
const PENDING_DEAL_PUSH_PIN_ENABLED_ENV_KEY = 'PENDING_DEAL_PUSH_PIN_ENABLED';

// 默认 9 点（北京时间，业务负责人说的）。
const DEFAULT_PUSH_HOUR = 9;
// 默认 10 分钟一 tick：与「第二次交付」提醒同一个节奏。判断"今天该不该跑"不靠定时精度，
// 而靠**按天认领**（见 pendingDealPushService.sendDailyPush），所以 tick 落在哪一刻无所谓。
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

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
  // 深链**现查**开关：拿不到本地存的 `message_app_link` 时，要不要每次去问一次飞书。
  // 默认开——那是官方声明过的字段，将来飞书开始返回就自动生效，不用改代码。
  // 实测（2026-10-06）当前**不返回**，见 services/larkMessageLinkResolver 的注释。
  linkLookupEnabled: readFlag(env, PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY, true),
  // 拿不到深链时要不要**干脆不推**。默认 false = 照推单号 + 金额（深链是增强，不是前提）。
  linkRequired: readFlag(env, PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY, false),
  // 发出后要不要**把那条消息置顶**（飞书 im/v1/pins）。**默认 false**，理由：
  //   · 置顶是**群里每个人都看得见**的副作用，而且飞书那边有额外门槛——
  //     应用要有 `im:message.pins:write_only`（或 `im:message`）权限、机器人必须在群里、
  //     群若设成"仅群主/群管理员可 Pin"就直接失败（错误码 230046）；
  //   · 本仓既有纪律：对外可见的动作一律**显式开关、默认关**（本推送的总开关自己也默认 false）；
  //   · 打开时**必须显式写 true**，不会因为"只想试推送"就顺手把消息钉在群顶上。
  // ⚠️ 置顶失败绝不影响推送本身（只记 warn，见 services/larkMessagePinService）。
  pinEnabled: readFlag(env, PENDING_DEAL_PUSH_PIN_ENABLED_ENV_KEY, false),
});

module.exports = {
  PENDING_DEAL_PUSH_ENABLED_ENV_KEY,
  PENDING_DEAL_PUSH_CHAT_ID_ENV_KEY,
  PENDING_DEAL_PUSH_HOUR_ENV_KEY,
  PENDING_DEAL_PUSH_INTERVAL_MS_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_LOOKUP_ENABLED_ENV_KEY,
  PENDING_DEAL_PUSH_LINK_REQUIRED_ENV_KEY,
  PENDING_DEAL_PUSH_PIN_ENABLED_ENV_KEY,
  DEFAULT_PUSH_HOUR,
  DEFAULT_INTERVAL_MS,
  resolvePendingDealPushConfig,
  // 显式布尔那条规矩的实现在 config/envValue；这里转发一下，单测仍然可以盯住它。
  readFlag,
};
