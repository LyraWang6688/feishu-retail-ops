// 「机器人还收不收得到消息」的配置与判定口径（配置先行）。
//
// 为什么单独一个文件、而不是把阈值/开关散在读的地方：
//   · 阈值、开关、告警发到哪，业务负责人**随时会改**（今天就在飞书开放平台把回调地址填错过）；
//     改的时候只动这一个文件 + .env，不去翻路由和脚本；
//   · 判定函数是**纯函数**：路由（GET /api/lark/events/health）和自检脚本
//     （scripts/check-lark-events.mjs）**共用同一把尺子** —— 否则"接口说正常、脚本说超时"
//     这种自相矛盾会让人不敢相信任何一边。
//
// ⚠️ 开关一律**显式布尔**：只有 `true` / `1` / `yes` / `on`（忽略大小写与首尾空白）才算开，
//    其余（含未配置、空串、写错的值）一律算关。刻意不用 `process.env.X || fallback`：
//    `||` 把空串当没配，于是"清空环境变量"关不掉告警，属于静默失效。

// 多久没收到事件就认为异常（分钟）。
const STALE_MINUTES_ENV_KEY = 'LARK_EVENT_STALE_MINUTES';
const DEFAULT_STALE_MINUTES = 180;

// 告警总开关。**默认关闭**：脚本可能在开发机上被手动跑，而开发机本来就没有事件，
// 默认开启会往生产群/负责人私聊发假告警。要挂定时，显式设成 true。
const ALERT_ENABLED_ENV_KEY = 'LARK_EVENT_ALERT_ENABLED';

// 告警发到哪：purchase_group（默认，用 PURCHASE_CHAT_ID）或 owner（用 LARK_EVENT_ALERT_OPEN_ID）。
const ALERT_TARGET_ENV_KEY = 'LARK_EVENT_ALERT_TARGET';
const ALERT_TARGET_PURCHASE_GROUP = 'purchase_group';
const ALERT_TARGET_OWNER = 'owner';

// 发给业务负责人私聊时要用的 open_id（形如 ou_xxx）。**没有默认值**：没配就不发私聊，只报错。
const ALERT_OPEN_ID_ENV_KEY = 'LARK_EVENT_ALERT_OPEN_ID';

// 群里告警要不要 @所有人（显式布尔，默认关）。
const ALERT_MENTION_ALL_ENV_KEY = 'LARK_EVENT_ALERT_MENTION_ALL';

// 告警文案里要写的**正确**回调地址（填错就是今天那次的根因）。
const CALLBACK_URL_ENV_KEY = 'LARK_EVENT_CALLBACK_URL';
const DEFAULT_CALLBACK_URL = 'https://api.bamamei.online/api/lark/events';

// 心跳文件位置。**没有默认值**（空串=用基础设施里的默认路径 server/data/lark_event_heartbeat.json）。
const HEARTBEAT_FILE_ENV_KEY = 'LARK_EVENT_HEARTBEAT_FILE';

// 取一个"写了才算配置"的环境变量：去首尾空白，空串等于没配。
const readExplicit = (env, key) => {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
};

// 显式布尔：只有明确写成 true/1/yes/on 才算开。其余（含空串、写错的值）一律算关。
const readExplicitBoolean = (env, key) => {
  const value = readExplicit(env, key).toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
};

// 正整数阈值：配了合法值就用，否则回落默认值（阈值配错不应该让自检失效）。
const readPositiveInt = (env, key, fallback) => {
  const raw = readExplicit(env, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

/** 超过多少分钟没收到事件算异常。默认 180。 */
const resolveStaleMinutes = (env = process.env) =>
  readPositiveInt(env, STALE_MINUTES_ENV_KEY, DEFAULT_STALE_MINUTES);

/** 告警总开关（显式布尔，默认关）。 */
const isAlertEnabled = (env = process.env) => readExplicitBoolean(env, ALERT_ENABLED_ENV_KEY);

/** 告警发到哪。只有显式 owner 才走私聊，其余一律采购群。 */
const resolveAlertTarget = (env = process.env) => {
  const value = readExplicit(env, ALERT_TARGET_ENV_KEY).toLowerCase();
  return value === ALERT_TARGET_OWNER ? ALERT_TARGET_OWNER : ALERT_TARGET_PURCHASE_GROUP;
};

/** 私聊告警的接收人 open_id。未配置返回空串（调用方据此报错，绝不猜一个收件人）。 */
const resolveAlertOpenId = (env = process.env) => readExplicit(env, ALERT_OPEN_ID_ENV_KEY);

/** 群里告警是否 @所有人（显式布尔，默认关）。 */
const isMentionAllEnabled = (env = process.env) => readExplicitBoolean(env, ALERT_MENTION_ALL_ENV_KEY);

/** 告警文案里的回调地址。默认就是我们**正确**的那个地址。 */
const resolveCallbackUrl = (env = process.env) =>
  readExplicit(env, CALLBACK_URL_ENV_KEY) || DEFAULT_CALLBACK_URL;

/** 心跳文件覆盖路径。空串=用默认路径（由 infrastructure/larkEventHeartbeat 决定）。 */
const resolveHeartbeatFilePath = (env = process.env) => readExplicit(env, HEARTBEAT_FILE_ENV_KEY);

const MS_PER_MINUTE = 60 * 1000;

const minutesSince = (isoString, nowMs) => {
  const at = Date.parse(isoString || '');
  if (!Number.isFinite(at)) return null;
  // 时钟回拨/未来时间：不做负数，按 0 处理（"刚刚"）。
  return Math.max(0, Math.floor((nowMs - at) / MS_PER_MINUTE));
};

/**
 * 纯函数：心跳快照 → 是否正常。
 *
 * 判据只用 `lastEventAt`（**任何**到达的事件，含 challenge）：
 *   · 回调地址填错 / 事件订阅被关 → **一条请求都到不了**，lastEventAt 会一直不变 → stale；
 *   · challenge 也算，是因为"飞书能验证我"就说明**链路是通的**。
 * `lastBusinessEventAt`（真正带业务内容的事件）**只作为排查线索一起返回**：
 * 业务事件天然稀疏（夜里、周末没有单子），拿它当 stale 判据会天天误报。
 *
 * 没有数据（文件不存在 / 从没收到过任何事件）→ status 'ok' + hasData false：
 * 「没有数据」和「确实很久没收到」是两件事，不能混；调用方据 hasData 区分。
 */
const evaluateLarkEventHeartbeat = (heartbeat = {}, options = {}) => {
  const staleMinutes =
    Number.isFinite(options.staleMinutes) && options.staleMinutes > 0
      ? Math.floor(options.staleMinutes)
      : DEFAULT_STALE_MINUTES;
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const minutesSinceLastEvent = minutesSince(heartbeat.lastEventAt, nowMs);
  const minutesSinceLastBusinessEvent = minutesSince(heartbeat.lastBusinessEventAt, nowMs);
  const hasData = minutesSinceLastEvent !== null;
  const status = hasData && minutesSinceLastEvent > staleMinutes ? 'stale' : 'ok';
  return {
    hasData,
    status,
    staleMinutes,
    minutesSinceLastEvent,
    minutesSinceLastBusinessEvent,
    lastEventAt: heartbeat.lastEventAt || null,
    lastBusinessEventAt: heartbeat.lastBusinessEventAt || null,
  };
};

// 汇报/告警里的时间一律用**上海时间（+8）**：服务器日志是 UTC，直接念数字业务负责人对不上。
const shanghaiTimeLabel = (isoString) => {
  const at = Date.parse(isoString || '');
  if (!Number.isFinite(at)) return '（无记录）';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}（上海时间）`;
};

/**
 * 纯函数：拼告警文案。文案里写清「最近 N 分钟没有事件」+「正确的回调地址」，
 * 因为根因几乎总是飞书开放平台上那个【事件回调】请求地址被填错了。
 */
const buildLarkEventStaleAlertText = ({ minutesSinceLastEvent, lastEventAt, callbackUrl } = {}) => {
  const minutes = Number.isFinite(minutesSinceLastEvent) ? minutesSinceLastEvent : '?';
  const url = callbackUrl || DEFAULT_CALLBACK_URL;
  return [
    `⚠️ 机器人可能收不到消息了（最近 ${minutes} 分钟没有收到任何飞书事件）`,
    `最后一次收到事件：${shanghaiTimeLabel(lastEventAt)}`,
    '请检查飞书开放平台的【事件回调】请求地址是否为：',
    url,
    '（填错会导致机器人收不到群消息和卡片点击。）',
  ].join('\n');
};

module.exports = {
  STALE_MINUTES_ENV_KEY,
  ALERT_ENABLED_ENV_KEY,
  ALERT_TARGET_ENV_KEY,
  ALERT_OPEN_ID_ENV_KEY,
  ALERT_MENTION_ALL_ENV_KEY,
  CALLBACK_URL_ENV_KEY,
  HEARTBEAT_FILE_ENV_KEY,
  DEFAULT_STALE_MINUTES,
  DEFAULT_CALLBACK_URL,
  ALERT_TARGET_PURCHASE_GROUP,
  ALERT_TARGET_OWNER,
  resolveStaleMinutes,
  isAlertEnabled,
  resolveAlertTarget,
  resolveAlertOpenId,
  isMentionAllEnabled,
  resolveCallbackUrl,
  resolveHeartbeatFilePath,
  evaluateLarkEventHeartbeat,
  buildLarkEventStaleAlertText,
  shanghaiTimeLabel,
};
