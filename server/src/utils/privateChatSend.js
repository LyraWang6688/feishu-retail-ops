// 🔴「没有群上下文 = 没有去处」的**唯一实现**（业务负责人 2026-10-07 拍板的 ⓐ：
//    「代码里一行私聊都不留」，见 docs/private-chat-removal-decision-2026-10-07.md）。
//
// 私聊入口已整体移除：任何服务要给"某个任务"发消息时，如果手里那个任务**没有群上下文**
// （`chat_type !== 'group'`），它就**没有去处** ——
//   · **不回落** `task.sender_open_id`（那就是偷偷发私聊，正是被否掉的行为）；
//   · 只记一条 `lark.private_chat.send_skipped`（可排查：不是静默失效）；
//   · 返 `null`，调用方据此知道"这次没发出去"（别谎报已发送）。
//
// ⚠️ 把这段行为收在**一处**：全仓所有"缺省出口"都调它，日志形状只有一份定义。
//    哪天有人往某个 service 里重新加"缺省发私聊"，只要那个出口不调这里，
//    grep `lark.private_chat.send_skipped` 的覆盖就会露馅。
//
// ⚠️ 群任务那条路**不经过这里**：`chat_type === 'group'` 时由注入的渠道感知出口
//    （`larkMvpService.sendTaskCard` / `sendTaskText`）回到那条话题（`reply_in_thread`）。
//
// 🔴 这里**没有开关**：要恢复私聊是**重新实现那条链路**，不是翻一个开关。
const { logWarn } = require('./logger');

const SEND_SKIPPED_EVENT = 'lark.private_chat.send_skipped';

/**
 * 记一条 skip，并明确告诉调用方"这条不发"。
 *
 * ⚠️ **同步**返回 `null`（不是 Promise）——调用方一律这样用：
 *   `options.sendCardToTask || (async (task, card) => skipNoGroupContext('card', task))`
 * `async` 那层会把 `null` 包成 resolved promise，语义就是"这条路不发"。
 *
 * @param {'card'|'text'} kind 发的是卡片还是文字（日志按它分开数）
 * @param {{task_id?: string}} [task] 目标任务（没有也照样记，`task_id` 会是 undefined）
 * @param {string} [reason] 为什么没去处（目前只有 `no_group_context`）
 * @returns {null}
 */
const skipNoGroupContext = (kind, task, reason = 'no_group_context') => {
  logWarn(SEND_SKIPPED_EVENT, { kind, task_id: task?.task_id, reason });
  return null;
};

module.exports = { skipNoGroupContext, SEND_SKIPPED_EVENT };
