// 群聊准入判据的配置（配置先行）。
//
// 业务负责人 2026-10-06 拍板（逐字）：
//   「我们主群里面可不可以不 @ 机器人啊？机器人它自动就能识别销售信息并进行回复呀。」
//   ⇒ 主群**不再要求 @**：靠正文判「像不像销售」。
//   ⇒ 不像销售的主群消息**完全不搭理**（静默、零远端调用）。
//
// 判据本身（三条满足**任一条**就理，实现在 LarkMvpService.resolveMainChatAdmission）：
//   ① `mentions` 里有机器人（@ 了）—— 改动前的老判据，照旧；
//   ② 正文过**销售闸门**（`config/messageGate`，与私聊**同一把尺子**）；
//   ③ 正文里有采购批次号 `CGD-YYYYMMDD-NNNN`（旧号 `BH-…` 仍然认） → 归采购那条路。
//
// 这个开关只回答一个问题：**主群是否仍然要求 @ 机器人**。
//   · 不配 / 空串 → `false`（放宽 = 新行为，**默认**）
//   · 显式 true    → `true`（回到改动前：主群只认 @）
//
// ⚠️ 刻意写成**显式布尔**，不用 `process.env.X || 默认值`：
//    `||` 会把「清空变量」当成没配而回退默认值，于是**关不掉**
//    （与 `config/groupPurchase.js` 里同一条坑，业务负责人的硬要求）。
// ⚠️ 值只认下面那几种写法，其余**当场抛错**、不静默取默认：
//    这道闸门决定的正是「群里日常聊天会不会被误触发」，
//    拼错一个字母就悄悄换一种口径，属于最难查的静默失效。

const MAIN_CHAT_REQUIRE_MENTION_ENV_KEY = 'GROUP_MAIN_CHAT_REQUIRE_MENTION';

// 默认**放宽**（= 业务负责人要的新行为）。
const DEFAULT_MAIN_CHAT_REQUIRE_MENTION = false;

const TRUE_VALUES = Object.freeze(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = Object.freeze(['0', 'false', 'no', 'off']);

/**
 * 主群消息是否仍然要求 @ 机器人。
 *
 * @param {Record<string, unknown>} [env] 默认 `process.env`（可注入，便于测试）。
 * @returns {boolean} `true` = 主群只认 @（老行为）；`false` = 正文过闸门也理（默认）。
 * @throws {Error} 变量非空但认不出取值时抛错（不静默取默认）。
 */
const resolveMainChatRequireMention = (env = process.env) => {
  const raw = env ? env[MAIN_CHAT_REQUIRE_MENTION_ENV_KEY] : undefined;
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_MAIN_CHAT_REQUIRE_MENTION;
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  throw new Error(
    `${MAIN_CHAT_REQUIRE_MENTION_ENV_KEY} 只接受 true/false/1/0/yes/no/on/off，当前取值认不出；`
    + '留空 = 默认（主群不要求 @，靠正文判销售）',
  );
};

module.exports = {
  MAIN_CHAT_REQUIRE_MENTION_ENV_KEY,
  DEFAULT_MAIN_CHAT_REQUIRE_MENTION,
  resolveMainChatRequireMention,
};
