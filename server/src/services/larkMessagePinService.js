const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { logInfo, logWarn } = require('../utils/logger');

// 「把刚发出去的那条消息**置顶**（飞书 Pin）」——只干这一件事的 service。
//
// 官方口径（2026-10-07 用 curl 拉官方文档实查，出处见
// `docs/pending-deal-push-pin-2026-10-07.md` 第二节）：
//   · 置顶：POST   /open-apis/im/v1/pins                  body `{ message_id }`
//   · 取消：DELETE /open-apis/im/v1/pins/:message_id
//   · 权限（任一项即可）：`im:message` / `im:message.pins:write_only` / `im:message:send_as_bot`
//   · 前提：应用开了机器人能力、**机器人必须在那条消息所属的会话内**；
//   · 限制：同一条消息 Pin/Unpin ≤ 5 QPS；已被 Pin 的消息再 Pin 会**返回那条 Pin 的信息**（幂等）；
//     取消一条**没被 Pin / 已撤回**的消息也会**返回成功** ⇒ 重复取消是安全的；
//   · 错误码：230046（该群仅群主/群管理员可 Pin）· 230027（缺权限）· 230047（限流）·
//     230002（机器人不在群）· 230011（消息已撤回）· 230050（消息对操作者不可见）。
//   · ⚠️ 官方文档**没有**写「一个群最多能置顶几条」（list 的 page_size 上限 50 只是**分页大小**）。
//     ⇒ 按"没有可依赖的上限"设计：**每次置顶新的之前，先取消上一条我们自己置顶的**，
//       并把"当前置顶的是哪一条"记在本地状态里，否则每天一条会越堆越多。
//
// 🔴 本类的硬约束：**任何 pin / unpin / 状态读写的失败都不许抛出去** ——
//    消息**已经发出去了**，置顶只是增强；调用方拿到的永远是 `{ pinned, reason }`，不是异常。
//    （业务负责人 2026-10-07：「置顶失败不许影响推送本身」。）

// 本地状态记录 id：与「按天认领」那批记录**同一个 store、同一个目录**
// （`server/data/pending_deal_push`），所以排查时一个目录看全。
const PIN_STATE_TASK_ID = 'pending_deal_push_pin_state';

const codeOf = (response) => {
  const code = response?.code;
  return code === undefined || code === null ? -1 : code;
};

const errorText = (response) => `${response?.msg || 'unknown'} (Code: ${codeOf(response)})`;

class LarkMessagePinService {
  constructor(options = {}) {
    // 飞书 client：不注入时由调用方（pendingDealPushService）传它已有的那个，不另建。
    this.client = options.client;
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/pending_deal_push'), idField: 'task_id',
    });
    this.stateTaskId = options.stateTaskId || PIN_STATE_TASK_ID;
  }

  /** 我们**当前**置顶的那条消息 id（没有 → 空串）。读不到状态 → 抛（由调用方按"不置顶"处理）。 */
  async currentPinnedMessageId() {
    const state = await this.store.get(this.stateTaskId);
    return String(state?.pinned_message_id || '');
  }

  /**
   * 状态落盘（**upsert**：首次还没有这条记录时 `update` 会抛"任务不存在"，退回 `create`）。
   * 失败**不抛**，只记 warn —— 置顶本身已经成功，不能让"记账"把结果翻成失败。
   */
  async saveState(patch, { day = '' } = {}) {
    try {
      await this.store.update(this.stateTaskId, patch);
      return true;
    } catch (updateError) {
      try {
        await this.store.create({ task_id: this.stateTaskId, ...patch });
        return true;
      } catch (createError) {
        logWarn('sales.pending_deal_push.pin.state_write_failed', {
          day,
          update_error: updateError.message,
          create_error: createError.message,
          hint: '置顶已成功但本地状态没记上：下一次可能不会取消这一条（置顶会多一条），需要人工看一眼',
        });
        return false;
      }
    }
  }

  /**
   * 保证"群里**我们**置顶的只有这一条"：**先取消上一条 → 成功后才置顶这一条**。
   *
   * ⚠️ 上一条取消失败时**本次不置顶新的**（宁可让旧的那条继续挂着、明天再试，
   *    也绝不在"旧的还在"的情况下再钉一条 —— 那就是置顶堆积）。
   *
   * @returns {Promise<{pinned: boolean, reason: string, previousMessageId: string}>} **永不抛**
   */
  async pinLatest({ messageId, chatId = '', day = '' } = {}) {
    if (!messageId) return { pinned: false, reason: 'no_message_id', previousMessageId: '' };
    const pin = this.client?.im?.pin;
    if (typeof pin?.create !== 'function' || typeof pin?.delete !== 'function') {
      logWarn('sales.pending_deal_push.pin.client_missing', {
        day, message_id: messageId, hint: '飞书 client 没有 im.pin（create/delete），本次不置顶；推送照常',
      });
      return { pinned: false, reason: 'client_missing', previousMessageId: '' };
    }

    // 1) 先看"上一条我们自己置顶的是哪条"。
    let previousMessageId = '';
    try {
      previousMessageId = await this.currentPinnedMessageId();
    } catch (error) {
      // 读不到 = 不知道旧的哪条。此时**盲目置顶就会堆积**，所以宁可不置顶。
      logWarn('sales.pending_deal_push.pin.state_read_failed', {
        day, error: error.message, hint: '不知道上一条置顶是哪条，本次不置顶，避免置顶堆积',
      });
      return { pinned: false, reason: 'state_unavailable', previousMessageId: '' };
    }

    // 2) 取消上一条（每天一条、不取消就会越堆越多）。
    if (previousMessageId) {
      try {
        const response = await pin.delete({ path: { message_id: previousMessageId } });
        if (codeOf(response) !== 0) throw new Error(errorText(response));
        await this.saveState({ pinned_message_id: '', chat_id: '', day: '', unpinned_at: new Date().toISOString() }, { day });
        logInfo('sales.pending_deal_push.pin.unpinned', { day, message_id: previousMessageId });
      } catch (error) {
        logWarn('sales.pending_deal_push.pin.unpin_failed', {
          day,
          message_id: previousMessageId,
          error: error.message,
          hint: '上一条取消置顶失败 → 本次不置顶新的（避免置顶堆积），状态保留，明天再试；推送本身不受影响',
        });
        return { pinned: false, reason: 'previous_unpin_failed', previousMessageId };
      }
    }

    // 3) 再置顶新的。失败只记 warn —— **绝不抛、不重试到死**。
    try {
      const response = await pin.create({ data: { message_id: messageId } });
      if (codeOf(response) !== 0) throw new Error(errorText(response));
      await this.saveState({
        pinned_message_id: messageId,
        chat_id: chatId,
        day,
        pinned_at: new Date().toISOString(),
      }, { day });
      logInfo('sales.pending_deal_push.pin.succeeded', {
        day, message_id: messageId, previous_message_id: previousMessageId,
      });
      return { pinned: true, reason: '', previousMessageId };
    } catch (error) {
      logWarn('sales.pending_deal_push.pin.failed', {
        day,
        message_id: messageId,
        error: error.message,
        hint: '置顶失败不影响推送本身（消息已发出）；不重试，明天照常推',
      });
      return { pinned: false, reason: 'pin_failed', previousMessageId };
    }
  }
}

module.exports = { LarkMessagePinService, PIN_STATE_TASK_ID };
