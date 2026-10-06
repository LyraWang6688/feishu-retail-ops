const { logInfo } = require('../utils/logger');

// 「认不出是哪一批」和「说不清是哪一批」的回复文案（配置先行：改文案不碰逻辑）。
// ⚠️ 两条都是**明确的否定**，不是"我猜了一下"：参见 PurchaseBatchLocator 里的四条路。
const NO_BATCH_REPLY = '这条消息我没认出来是哪一批采购单～你引用一下我发的采购单，或者把批次号（BH-开头的那个）说给我。';
const AMBIGUOUS_BATCH_REPLY = '我分不清你说的是哪一批～引用一下我发的采购单，或者把批次号（BH-开头的那个）说给我。';

/**
 * 群里进来的采购消息的分派（C 链路的使用方）。
 * 准入由调用方判定（话题免 @ / 主群 @，见 LarkMvpService.acceptMessage）。
 *
 * 它自己做两件事：**把"是哪一批"定位出来**，然后在定位成功时把这句话交给
 * 「对话到货」（D，`ArrivalConversationService`）——**记录**，必要的话发确认卡片。
 *   · 认出来 → 返回批次信息 + D 的处理结果，调用方（LarkMvpService）不再做别的；
 *   · 认不出来 → 回一句问清楚，结束。
 *
 * ⚠️ 本类**不写任何业务表**：定位只读，记录只写 D 自己的本地会话记录。
 * ⚠️ D 是可以**不注入**的（`arrivalConversation: null`）：那种情况下本类回到
 *    "只记日志就返回"的旧行为，不会偷偷开始写东西。
 */
class GroupPurchaseFlowService {
  constructor({ locator, replyText, sendText = null, arrivalConversation = null } = {}) {
    if (!locator) throw new Error('GroupPurchaseFlowService 需要 purchaseBatchLocator');
    this.locator = locator;
    // replyText：在**群里原地回复**那条消息（引用回复）。群聊里所有反馈都走它，
    // 免得私聊那套 sendText 把消息发到群里时没有上下文。
    this.replyText = replyText || (async () => '');
    // 保留 sendText 注入位（将来 D 要在群里直接发消息时用），今天没有调用点。
    this.sendText = sendText;
    // 「对话到货」（D）那一半：定位成功之后，把这句话交给它**记下来**并判意图。
    // ⚠️ 默认 null = 今天的行为（只记日志就返回）：没接上时这条链路一点副作用都没有，
    //    单测/演练环境不会因为多了一个依赖而偷偷开始写东西。
    this.arrivalConversation = arrivalConversation;
  }

  /**
   * @param {{ messageId: string, text: string, parentId?: string, threadId?: string,
   *   senderOpenId?: string }} input
   * @returns {Promise<{resolved: boolean, reason: string, batch?: object, batchNo?: string, replied: boolean}>}
   */
  async handleGroupPurchaseMessage({ messageId, text = '', parentId = '', threadId = '', senderOpenId = '' } = {}) {
    const located = await this.locator.resolve({ text, parentId, threadId });
    if (located.status === 'matched') {
      // 定位成功**只记日志、不回消息**：她引用着采购单说话时，卡片/结果才是回执，
      // 先垫一句"我找到了"只会刷屏。
      logInfo('purchase.group.message.located', {
        message_id: messageId, source: located.source, batch_no: located.batchNo,
      });
      // 「对话到货」：把这一句记进本地会话（此时**一张业务表都不写**），
      // 由它自己决定要不要判"核对完了"、要不要发确认卡片。
      // ⚠️ 失败只记日志：这句话不能被一个记录级的问题弄丢成"群消息处理失败"。
      let arrival = null;
      if (this.arrivalConversation) {
        try {
          arrival = await this.arrivalConversation.noteTopicMessage({
            batchNo: located.batchNo,
            threadId,
            chatId: located.batch?.chat_id || '',
            requestIds: located.batch?.request_ids || [],
            messageId,
            text,
            senderOpenId,
          });
        } catch (error) {
          logWarn('purchase.arrival.conversation.note_failed', {
            message_id: messageId, batch_no: located.batchNo, error: error.message,
          });
        }
      }
      return {
        resolved: true, reason: located.source, batch: located.batch, batchNo: located.batchNo,
        replied: false, arrival,
      };
    }
    const content = located.status === 'not_found' ? NO_BATCH_REPLY : AMBIGUOUS_BATCH_REPLY;
    let replied = false;
    try {
      await this.replyText(messageId, content);
      replied = true;
    } catch (error) {
      // 回不出去（例如缺 im:message 权限）不能把整条链路判失败：日志留痕即可，
      // 她再 @ 一次还会走同样的路。
      logInfo('purchase.group.message.reply_failed', { message_id: messageId, error: error.message });
    }
    logInfo('purchase.group.message.unresolved', {
      message_id: messageId, status: located.status, source: located.source, replied,
      sender_open_id: senderOpenId,
    });
    return { resolved: false, reason: located.status, replied };
  }
}

module.exports = { GroupPurchaseFlowService, NO_BATCH_REPLY, AMBIGUOUS_BATCH_REPLY };
