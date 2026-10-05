// 「采购链路搬进群聊」的三个配置项（配置先行）。
//
// 为什么单独一个文件、而不是散在服务里读 process.env：
//   · 业务负责人说群聊这条链路的参数（群、机器人、表情）**要能改**，
//     改的时候只动这一个文件，不去翻 larkMvpService / purchaseWebhookService；
//   · 单测可以直接传 env 进来，不用改全局 process.env（并发跑用例时不会互相污染）。
//
// ⚠️ 三条取值规则都是**没有默认值**，这是踩过坑之后的硬约束：
//   1. `PURCHASE_CHAT_ID` 没配 → 采购单**不发**，只在日志里大声说"没配群"。
//      绝不回落到"发给经办人私聊"：业务负责人明确说"不用再看经办人了"，
//      悄悄发到私聊会让人以为链路升级了、实际还停在旧行为。
//   2. `LARK_BOT_OPEN_ID` 没配 → 群聊里 @ 不 @ 机器人都判不出来。
//      这时候**一条群消息都不处理**，并留一条能排查的警告。绝不猜"可能是 @ 我"：
//      群里日常聊天被误触发、或者她的指令被静默丢掉，两种后果都不可接受。
//   3. `LARK_ACK_REACTION` 没配 → 用 OneSecond（真机验证过有效的那个）。
//      这一条是唯一有兜底的：表情只是"收到了"的信号，配错不影响任何业务事实。

// 采购单发到哪个群（chat_id，形如 oc_xxx）。**没有默认值**。
const PURCHASE_CHAT_ID_ENV_KEY = 'PURCHASE_CHAT_ID';

// 机器人自己的 open_id（形如 ou_xxx）。@ 判据就是它。**没有默认值**。
const BOT_OPEN_ID_ENV_KEY = 'LARK_BOT_OPEN_ID';

// 「收到」表情的 emoji_type。有默认值（表情不是业务事实）。
const ACK_REACTION_ENV_KEY = 'LARK_ACK_REACTION';
const DEFAULT_ACK_REACTION = 'OneSecond';

// 取一个"写了才算配置"的环境变量：去首尾空白，空串等于没配。
// ⚠️ 刻意不用 `process.env.X || 默认值` 那种写法（仓库里 getEnv 就是那样）：
// `||` 把空串当没配，于是"清空环境变量"关不掉任何东西，属于静默失效。
const readExplicit = (env, key) => {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
};

/** 采购单要发到哪个群。未配置返回空串（调用方据此跳过发送并记日志）。 */
const resolvePurchaseChatId = (env = process.env) => readExplicit(env, PURCHASE_CHAT_ID_ENV_KEY);

/** 机器人自己的 open_id。未配置返回空串（调用方据此不处理任何群消息）。 */
const resolveBotOpenId = (env = process.env) => readExplicit(env, BOT_OPEN_ID_ENV_KEY);

/** 「收到」表情类型。未配置回落到 OneSecond。 */
const resolveAckReaction = (env = process.env) => readExplicit(env, ACK_REACTION_ENV_KEY) || DEFAULT_ACK_REACTION;

module.exports = {
  PURCHASE_CHAT_ID_ENV_KEY,
  BOT_OPEN_ID_ENV_KEY,
  ACK_REACTION_ENV_KEY,
  DEFAULT_ACK_REACTION,
  resolvePurchaseChatId,
  resolveBotOpenId,
  resolveAckReaction,
};
