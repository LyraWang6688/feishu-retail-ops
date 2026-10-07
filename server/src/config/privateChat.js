// 「私聊链路已移除」的配置（配置先行）。
//
// 业务负责人口径（2026-10-07 逐字）：「**以后私聊这条链路我们就没有了**」。
// 背景：私聊曾经是唯一入口；现在入口统一到【群聊 + 话题】，私聊不再承载任何链路。
// 这里保留**显式开关**，是为了万一要临时恢复有个明确的口子 ——
// ⚠️ 但**不要再往代码里加私聊专属逻辑**（新功能一律走群话题）。
//
// ⚠️ 取值规则**统一走 `config/envValue`**（不在这里再写一套）：
//   · 变量**没设** → 用默认值；
//   · 变量**设了**（含**空串**）→ 就是显式取值，**空串 = false**（= 关掉，不回退默认）；
//   · 设成**认不出来的值** → **当场抛错**，不猜。
//   反面教材是 `process.env.X || 默认值`：`||` 把空串当"没配"，
//   于是"清空变量想关掉"会静默回退到默认值 —— **关不掉**（这正是 `getEnv` 踩过的坑）。
//
// ⚠️⭐ 为什么是**函数**而不是模块级的 `Object.freeze({...})` 常量：
//   常量在**模块加载那一刻**就把值定死了。这个仓库的单测是**多进程**跑的
//   （`node --test` 每个测试文件一个子进程），历史用例又是**拿私聊当入口**测下游的，
//   要让它们继续跑就得让 `PRIVATE_CHAT_INTAKE_ENABLED=true` 在**被 require 之前**生效 ——
//   也就是**依赖 require 顺序**。顺序是隐式的，重排一次就静默失效
//   （失败方式还是"用例莫名其妙开始测另一个分支"，最难查）。
//   ⇒ 改成**每次调用时读**，与仓库既有三个开关完全同形：
//     `config/groupAdmission.js` 的 `resolveMainChatRequireMention`、
//     `config/groupPurchase.js` 的三个 `resolve*`、
//     `config/purchaseArrivalIntake.js` 的 `isPurchaseArrivalIntakeEnabled`。
//   顺带收益：`env` 可注入 → 单测直接传 env，不污染全局；运行时改 env 立即生效。

const { readFlag, readString } = require('./envValue');

/** 私聊入口开关：私聊消息处不处理。默认 **false = 不处理**（= 私聊入口已移除）。 */
const PRIVATE_CHAT_INTAKE_ENV_KEY = 'PRIVATE_CHAT_INTAKE_ENABLED';

/** 私聊发送开关：允不允许**主动往私聊**发消息。默认 **false = 不发**。 */
const PRIVATE_CHAT_SEND_ENV_KEY = 'PRIVATE_CHAT_SEND_ENABLED';

/** 私聊被挡下时要不要回一句固定文案。默认 **true**（免得对方以为机器人坏了）。 */
const PRIVATE_CHAT_NOTICE_ENV_KEY = 'PRIVATE_CHAT_DISABLED_NOTICE_ENABLED';

/** 上面那句话本身（改文案不用碰代码）。 */
const PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY = 'PRIVATE_CHAT_DISABLED_NOTICE_TEXT';

const DEFAULT_NOTICE_TEXT = '这个机器人现在只在群里工作，请到群里说～';

/**
 * 私聊**入口**是否启用。默认 `false`（= 私聊消息不建任务、不跑任何链路）。
 *
 * @param {Record<string, unknown>} [env] 默认 `process.env`（可注入，便于单测）。
 * @throws {Error} 变量非空但认不出取值时抛错（不静默取默认）。
 */
const isPrivateChatIntakeEnabled = (env = process.env) => readFlag(env, PRIVATE_CHAT_INTAKE_ENV_KEY, false);

/**
 * 是否允许**主动往私聊**发消息。默认 `false`。
 *
 * ⚠️ 它只管"**没有群上下文**时要不要回落私聊"这一个问题；
 *   群话题的回复（`reply_in_thread`）**不看这个开关**。
 */
const isPrivateChatSendEnabled = (env = process.env) => readFlag(env, PRIVATE_CHAT_SEND_ENV_KEY, false);

/**
 * 私聊被挡下时的固定回复。
 *
 * ⚠️ `enabled` 与 `text` 是**两个正交的旋钮**：文案被设成空串时 `text === ''`，
 *    调用方要自己判"没什么可说的就不发"（见 `larkMvpService.acceptMessage`）。
 *
 * @returns {{ enabled: boolean, text: string }}
 */
const resolvePrivateChatNotice = (env = process.env) => ({
  enabled: readFlag(env, PRIVATE_CHAT_NOTICE_ENV_KEY, true),
  text: readString(env, PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY, DEFAULT_NOTICE_TEXT),
});

module.exports = {
  PRIVATE_CHAT_INTAKE_ENV_KEY,
  PRIVATE_CHAT_SEND_ENV_KEY,
  PRIVATE_CHAT_NOTICE_ENV_KEY,
  PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY,
  DEFAULT_NOTICE_TEXT,
  isPrivateChatIntakeEnabled,
  isPrivateChatSendEnabled,
  resolvePrivateChatNotice,
};
