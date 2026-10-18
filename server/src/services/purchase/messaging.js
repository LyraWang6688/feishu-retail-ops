'use strict';

/**
 * 采购链路的「对外发消息」小模块 —— 2026-10-18 从 `services/purchaseWebhookService.js`
 * **原样搬出**（文件大小门禁，见 task-6）。方法体 / 文案 / payload / 日志事件名一个字没改。
 *
 * ⚠️ 本模块的方法是"服务对象的 mixin"：`this` 由调用方绑成 `PurchaseWebhookService` 实例
 * （facade 里保留了同名薄委托方法），所以 `this.client` / `this.sandboxChatId` 等照旧可用。
 */
const { larkErrorText: larkErrorTextOf } = require('../../utils/larkError');
const { resolvePurchaseChatId } = require('../../config/groupPurchase');
const {
  resolvePurchaseGroupNoticeConfig, renderPurchaseGroupNoticeMention,
} = require('../../config/purchaseGroupNoticeText');
const { correlationFields } = require('../../utils/correlationFields');
const { logInfo, logWarn } = require('../../utils/logger');

/**
 * 「回复某条消息」时要不要**进话题**：`options.inThread === true` → `reply_in_thread: true`。
 *
 * 为什么需要这个字段（业务负责人 2026-10-07 真机测试后提的）：
 *   · 飞书里**回复 ≠ 话题**：不带 `reply_in_thread` 的回复只是**引用回复**，
 *     在普通群里就表现为**又一条并列消息** —— 她看到的就是"图一条、@文字一条，两条消息"；
 *   · 带 `reply_in_thread: true` 才是**话题**：主群里我们那条回复会**创建**话题，
 *     响应里回带 `thread_id`（`PurchaseBatchLocator` 正是拿它写「话题 ↔ 批次」映射的）。
 * ⚠️ **只在真的在回复某条消息时才有意义**（调用方只在 `replyToMessageId` 非空时传它）：
 *    顶层 `create` 没有"回复谁"这回事，带上这个字段没有意义。
 * ⚠️ 字段名与用法与 `larkMvpService.replyMessage(..., { inThread: true })` **完全一致**
 *    （`@larksuiteoapi/node-sdk` 的 `im.message.reply` 本来就带 `reply_in_thread`）——
 *    **不新引 SDK、也不换调用方式**。
 * ⚠️ 默认 `false` ⇒ 不传时出站 payload 与改动前**逐字节相同**（单测钉住了这一条）。
 */
const replyThreadFields = (options = {}) => (options?.inThread === true ? { reply_in_thread: true } : {});

/**
 * 飞书 SDK 抛错时 message 往往只有 "Request failed with status code 400"，
 * 真正有用的错误码和原因在 response.data 里（例如缺权限的 99991672）。
 * 出图/发图的失败只会写日志，所以日志必须带上这两个字段，否则线上排查只能靠猜。
 *
 * ⚠️ 2026-10-08：实现**收敛到 `utils/larkError`**（同一个形状只留一处实现）；
 *    这里的 `larkErrorText` 仍然是 `msg (Code: code)`，调用点与文案一个字不变。
 */
const larkErrorText = (error) => larkErrorTextOf(error);

const messaging = {
  /**
   * 采购单要发到哪儿。**配置先行，没有默认值**。
   *
   * 返回 `{ chatId, sandbox, reason }`：
   *   · 配了 `PURCHASE_CHAT_ID` → 发那个群；
   *   · 没配 → sandbox=true，调用方**大声跳过并记日志**，绝不回落到私聊
   *     （业务负责人明确说「不用再看经办人了」，偷偷发私聊会让人以为已经升级到群）。
   *
   * 沙箱是测试用的显式通道（构造时注入 chatId，不读环境变量）：
   * 用 `process.env` 直接判的话，一个进程里并发跑的用例会互相污染。
   */
  resolvePurchaseGroupTarget(options = {}) {
    if (options.sandboxChatId) return { chatId: options.sandboxChatId, sandbox: true, reason: 'sandbox' };
    const chatId = resolvePurchaseChatId();
    if (!chatId) return { chatId: '', sandbox: false, reason: 'chat_id_unconfigured' };
    return { chatId, sandbox: false, reason: 'configured' };
  },

  /**
   * 采购单发到群里时，@那个记录的**经办人** —— 业务负责人明确改的。
   *
   * 为什么不再 @所有人：她要的是"经办人知道这批单子发了"，@所有人是群骚扰；
   * 经办人目前都在这个采购群里，所以直接在群里 @他（不再单独发私聊）。
   *
   * ⚠️ 拿不到经办人 open_id 时**不加 @**（只发正文）：宁可少一个提醒，也不能 @错人，
   *    更不能退回 @所有人。调用方会同时记一条 warn 日志，便于排查"为什么没 @到"。
   *
   * ⚠️ 2026-10-07：那段飞书 @ 标记**也进了配置**（`config/purchaseGroupNoticeText` 的
   *    `mention`，占位符 `{openId}`）—— 这里不再有写死的 `<at …>`。
   */
  mentionOperatorText(operatorOpenId, content, config = resolvePurchaseGroupNoticeConfig()) {
    // 拿不到 open_id → 空 @ 前缀（`renderPurchaseGroupNoticeMention` 返回空串）。
    return `${renderPurchaseGroupNoticeMention(operatorOpenId, config)}${String(content || '')}`;
  },

  /**
   * 在**采购群**（PURCHASE_CHAT_ID，和出图同一个群）说一句纯文本。
   *
   * 业务负责人 2026-10-06 的口径：「"说明和勾选对不上"时要不要在群里给个提示」→
   * 「可以给提示」。所以这是**运营可见的反馈**，不再让她"提交了没反应、只能查日志"。
   *
   * 与 sendText 是刻意分开的语义：
   *   · sendText —— 主链动作，发不出去就算这次处理失败；
   *   · sendPurchaseGroupNotice —— 发给采购群的事后通知，**失败不抛错**（只记日志、返回 false）：
   *     它出现在"这条报货没进图" / "退货数量对不上"之后，绝不能因为一句提示发不出去
   *     就把整批判成失败。
   *
   * 群 id 走 config/groupPurchase（未配置就大声跳过、不回落私聊，与出图同一条口径）。
   * `options.sandboxChatId`（构造入参）是测试用的显式通道：不读环境变量，避免并发用例互相污染。
   *
   * ⭐ `options.replyToMessageId`：传了就**回复那条消息**而不发顶层消息 ——
   *    采购退货的差额提示用它挂到**这一批退货单（图）的那个话题**下，
   *    而不是在群里另开一个话题（业务负责人：「一律在话题群里」）。不传 = 照旧发顶层。
   * ⚠️ 2026-10-07：回复时**同时带 `inThread: true`**（飞书 `reply_in_thread`）。
   *    只"回复某条消息"在飞书里是**引用回复**，不建话题 —— 那正是她看到"两条消息"的原因。
   */
  async sendPurchaseGroupNotice(content, options = {}) {
    // 关联键（task_id / batch_no / 记录 id）：只进日志。不传 = 日志形状**逐字不变**。
    const correlation = correlationFields(options.correlation);
    const target = this.resolvePurchaseGroupTarget({ sandboxChatId: this.sandboxChatId });
    if (!target.chatId) {
      logWarn('purchase.group_notice.skipped', {
        reason: 'purchase_chat_id_unconfigured', env: 'PURCHASE_CHAT_ID', content, ...correlation,
      });
      return false;
    }
    const replyToMessageId = String(options?.replyToMessageId || '').trim();
    try {
      await this.sendText(target.chatId, content, 'chat_id', {
        replyToMessageId: replyToMessageId || undefined,
        // 有回复对象 = 挂在那一批的话题下 → 必须进话题，否则又是一条并列的引用回复。
        inThread: Boolean(replyToMessageId),
      });
      logInfo('purchase.group_notice.sent', {
        chat_id: target.chatId, reply_to_message_id: replyToMessageId, ...correlation,
      });
      return true;
    } catch (error) {
      logWarn('purchase.group_notice.failed', { chat_id: target.chatId, error: error.message, ...correlation });
      return false;
    }
  },

  /**
   * 发送图片消息（飞书图片消息要先用 im.image 上传拿 image_key）。
   *
   * ⚠️ 上传图片用的是应用身份权限 im:resource:upload（或 im:resource）。
   * 没开通时这里会以 99991672 失败，日志里带上错误码，便于线上直接定位到权限问题。
   *
   * `receiveIdType` 默认为 open_id（私聊那条路今天仍在用：到货异常告知）；采购单发到群时
   * 由调用方传 `chat_id`（参数名必须跟着 receive_id 的实际类型走，不能写死 open_id）。
   *
   * 返回 `{ imageKey, messageId, threadId }`：采购单发到群之后要把 message_id / thread_id
   * 记进映射，供「话题里的消息 / 引用那条消息 → 是哪一批」反查（见 PurchaseBatchLocator）。
   * `threadId` 只有话题群（或飞书已经给这条消息开了话题）才有值，普通群是空串——
   * 那种情况由定位器在她第一次回复时补记，不影响定位。
   *
   * `options.replyToMessageId`：传了就**回复那条消息**（`im.message.reply`）而不是
   * 发一条顶层消息——采购单发到群时用它把第 2 条起的消息都挂到第 1 条的话题下
   * （业务负责人 2026-10-06 拍板，见 deliverSupplierImagesInner）。
   *
   * ⚠️ 2026-10-07 新增 `options.inThread`（**只在有 `replyToMessageId` 时有意义**）：
   * 带上它 → `im.message.reply` 的 `data.reply_in_thread = true` → 飞书把这条回复
   * **放进话题**（主群里我们这条回复会**创建**那个话题，响应里回带 `thread_id`）。
   * 🔴 不带它时，"回复某条消息"在飞书里只是**引用回复**、**不建话题** ——
   * 那正是业务负责人看到的"图一条、文字一条，两条并列消息"。
   * ⚠️ 与 `larkMvpService.replyMessage(..., { inThread: true })` 是**同一个字段、同一种用法**
   * （`@larksuiteoapi/node-sdk` 的 `im.message.reply` 本来就带 `reply_in_thread`），
   * **不新引 SDK、也不换调用方式**。默认 `false` ⇒ 不传时 payload 与改动前**逐字节相同**。
   */
  async sendImage(openId, imageBuffer, receiveIdType = 'open_id', options = {}) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送图片');
    let upload;
    try {
      upload = await this.client.im.image.create({
        data: { image_type: 'message', image: imageBuffer },
      });
    } catch (error) {
      throw new Error(`上传采购申请图片失败：${larkErrorText(error)}`);
    }
    // SDK 会剥掉外层信封、把 image_key 放在顶层；保留 .data.image_key 兜底，
    // 免得将来换了 http 实现之后这里静默拿不到 key。
    const imageKey = upload?.image_key || upload?.data?.image_key;
    if (!imageKey) throw new Error('采购申请图片上传成功但未返回 image_key');
    const content = JSON.stringify({ image_key: imageKey });
    const response = options.replyToMessageId
      ? await this.client.im.message.reply({
        path: { message_id: String(options.replyToMessageId) },
        data: { msg_type: 'image', content, ...replyThreadFields(options) },
      })
      : await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: openId, msg_type: 'image', content },
      });
    if (response.code !== 0) throw new Error(`发送采购申请图片失败: ${response.msg} (Code: ${response.code})`);
    return {
      imageKey,
      messageId: response.data?.message_id || '',
      threadId: response.data?.thread_id || '',
    };
  },

  /**
   * 发一条纯文字。返回 `{ messageId, threadId }`。
   *
   * ⚠️ 返回值从"messageId 字符串"改成对象，是为了把 `thread_id` 一起带出来记映射
   * （话题里后续消息只带 thread_id，不带 parent_id）。本类里只有采购单发到群那一个
   * 调用点，已同步改成解构 `{ messageId, threadId }`。
   *
   * `options.replyToMessageId`：传了就**回复那条消息**而不是发顶层消息——采购单发到群时
   * 用它把「文字 @」挂到第 1 条图的话题下（业务负责人 2026-10-06 拍板）。
   * ⚠️ 一律回复**第 1 条**（不是回复上一条）：飞书的话题 = 一条消息 + 回复它的消息，
   * 回复话题里任何一条都算同一个话题；固定回复第 1 条，归属最稳、也最好解释。
   *
   * ⚠️ 2026-10-07 新增 `options.inThread`：见 `replyThreadFields` 的注释 ——
   * **只"回复"不建话题**（飞书那是引用回复），要"图与文字落在同一个话题"就必须带它。
   * 不传时 payload 与改动前**逐字节相同**。
   */
  async sendText(openId, content, receiveIdType = 'open_id', options = {}) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送说明');
    const text = JSON.stringify({ text: content });
    const response = options.replyToMessageId
      ? await this.client.im.message.reply({
        path: { message_id: String(options.replyToMessageId) },
        data: { msg_type: 'text', content: text, ...replyThreadFields(options) },
      })
      : await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: openId, msg_type: 'text', content: text },
      });
    if (response.code !== 0) throw new Error(`发送采购申请说明失败: ${response.msg} (Code: ${response.code})`);
    return {
      messageId: response.data?.message_id || '',
      threadId: response.data?.thread_id || '',
    };
  },

  /**
   * 更新采购消息卡片（类似销售的 updateSalesActionCard）
   */
  async updatePurchaseActionCard(task, event, card) {
    const messageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id;
    if (!messageId) {
      console.warn('lark.purchase.card.update.skipped', { task_id: task.task_id, reason: 'missing_message_id' });
      return false;
    }
    try {
      const patch = this.client.im?.v1?.message?.patch || this.client.im?.message?.patch;
      if (!patch) return false;
      const response = await patch.call(this.client.im?.v1?.message || this.client.im.message, {
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      if (response.code !== 0) throw new Error(response.msg + ' (Code: ' + response.code + ')');
      return true;
    } catch (error) {
      console.warn('lark.purchase.card.update.failed', { task_id: task.task_id, error: error.message });
      return false;
    }
  },
};

module.exports = messaging;
