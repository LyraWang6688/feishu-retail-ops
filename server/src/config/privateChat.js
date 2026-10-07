// 「私聊链路已移除」的配置（配置先行）—— **只剩下一句话**。
//
// 业务负责人口径（2026-10-07 逐字）：「**以后私聊这条链路我们就没有了**」；
// 2026-10-07 再拍板走 ⓐ：「**干净、彻底** …… **以后代码里【一行私聊都没有】**」。
// 承接件：[docs/private-chat-removal-decision-2026-10-07.md](../../docs/private-chat-removal-decision-2026-10-07.md)、
//         [docs/private-chat-removal-hard-2026-10-07.md](../../docs/private-chat-removal-hard-2026-10-07.md)。
//
// 🔴 **这里【故意】没有任何"入口开关"或"发送开关"**：
//   · 私聊消息 → `larkMvpService.acceptMessage` 里**只记一条日志**，不建任务、不跑链路；
//   · 私聊发送 → `sendTaskText` / `sendTaskCard` 里**没有那段代码**（非群任务不发）。
//   曾经有过 `PRIVATE_CHAT_INTAKE_ENABLED` / `PRIVATE_CHAT_SEND_ENABLED`（ⓑ 版的"可显式恢复"），
//   已**整体删除** —— 留着它们等于"私聊分支还在代码里"，与她的最终目标直接冲突。
//   ⇒ 要恢复私聊，请从 git 历史里取回（`git log -S 'PRIVATE_CHAT_INTAKE_ENABLED'`）。
//
// ⚠️ **为什么下面这一句文案还留着**：对面是**人**。机器人被私聊时一条都不回，
//   她会以为机器人坏了。所以保留**一个显式布尔 + 一句可配的文案**；
//   但它只是**文案层**：开关关掉 = 一个字都不发，绝不因此重新跑任何链路。
//
// ⚠️ 取值规则**统一走 `config/envValue`**（不在这里再写一套）：
//   · 变量**没设** → 用默认值；
//   · 变量**设了**（含**空串**）→ 就是显式取值，**空串 = false**（= 关掉，不回退默认）；
//   · 设成**认不出来的值** → **当场抛错**，不猜。
//   反面教材是 `process.env.X || 默认值`：`||` 把空串当"没配"，
//   于是"清空变量想关掉"会静默回退到默认值 —— **关不掉**（这正是 `getEnv` 踩过的坑）。
//
// ⚠️ 导出的是**解析函数**（每次调用时读 env），不是模块级常量：与仓库既有三个开关同形
//   （`config/groupAdmission` / `config/groupPurchase` / `config/purchaseArrivalIntake`），
//   好处是 `env` 可注入（单测直接传 env，不污染全局）、运行时改 env 立即生效。

const { readFlag, readString } = require('./envValue');

/** 私聊被挡下时要不要回一句固定文案。默认 **true**（免得对方以为机器人坏了）。 */
const PRIVATE_CHAT_NOTICE_ENV_KEY = 'PRIVATE_CHAT_DISABLED_NOTICE_ENABLED';

/** 上面那句话本身（改文案不用碰代码）。 */
const PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY = 'PRIVATE_CHAT_DISABLED_NOTICE_TEXT';

const DEFAULT_NOTICE_TEXT = '这个机器人现在只在群里工作，请到群里说～';

/**
 * 私聊被挡下时的固定回复。
 *
 * ⚠️ `enabled` 与 `text` 是**两个正交的旋钮**：文案被设成空串时 `text === ''`，
 *    调用方要自己判"没什么可说的就不发"（见 `larkMvpService.acceptMessage`）。
 *
 * @param {Record<string, unknown>} [env] 默认 `process.env`（可注入，便于单测）。
 * @returns {{ enabled: boolean, text: string }}
 * @throws {Error} 变量非空但认不出取值时抛错（不静默取默认）。
 */
const resolvePrivateChatNotice = (env = process.env) => ({
  enabled: readFlag(env, PRIVATE_CHAT_NOTICE_ENV_KEY, true),
  text: readString(env, PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY, DEFAULT_NOTICE_TEXT),
});

module.exports = {
  PRIVATE_CHAT_NOTICE_ENV_KEY,
  PRIVATE_CHAT_NOTICE_TEXT_ENV_KEY,
  DEFAULT_NOTICE_TEXT,
  resolvePrivateChatNotice,
};
