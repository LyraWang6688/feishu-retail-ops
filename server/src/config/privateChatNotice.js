// 「私聊被挡下时回一句什么」的配置（业务负责人 2026-10-07 决定：**保留这句话**）。
//
// 背景：私聊链路已整体移除（2026-10-07，见 docs/private-chat-removal-decision-2026-10-07.md）：
//   私聊消息不建任务、不进 AI、不读表、不写表 —— **唯一保留的**是这一句固定回复。
//   为什么留：对方是**人**、而且是**冲我们机器人**说的；完全静默会让人以为机器人坏了。
//
// 🔴 这里**只有"回不回一句话"和"那句话是什么"两个旋钮** ——
//    没有、也不许有「恢复私聊入口 / 往私聊发业务消息」的开关（那正是被否掉的 ⓑ 方案）。
//
// ⚠️ 取值规则走 config/envValue（显式布尔：空串 = 关掉，认不出的值当场抛错）。
const { readFlag, readString } = require('./envValue');

const NOTICE_ENABLED_KEY = 'PRIVATE_CHAT_DISABLED_NOTICE_ENABLED';
const NOTICE_TEXT_KEY = 'PRIVATE_CHAT_DISABLED_NOTICE_TEXT';
const DEFAULT_NOTICE_TEXT = '这个机器人现在只在群里工作，请到群里说～';

/** @returns {{ enabled: boolean, text: string }} */
const resolvePrivateChatNotice = (env = process.env) => ({
  enabled: readFlag(env, NOTICE_ENABLED_KEY, true),
  text: readString(env, NOTICE_TEXT_KEY, DEFAULT_NOTICE_TEXT),
});

module.exports = {
  NOTICE_ENABLED_KEY,
  NOTICE_TEXT_KEY,
  DEFAULT_NOTICE_TEXT,
  resolvePrivateChatNotice,
};
