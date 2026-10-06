const { logInfo, logWarn } = require('../utils/logger');

// 「认不出是哪一批」和「说不清是哪一批」的回复文案（配置先行：改文案不碰逻辑）。
// ⚠️ 两条都是**明确的否定**，不是"我猜了一下"：参见 PurchaseBatchLocator 里的四条路。
const NO_BATCH_REPLY = '这条消息我没认出来是哪一批采购单～你引用一下我发的采购单，或者把批次号（BH-开头的那个）说给我。';
const AMBIGUOUS_BATCH_REPLY = '我分不清你说的是哪一批～引用一下我发的采购单，或者把批次号（BH-开头的那个）说给我。';

/**
 * 群里进来的采购消息的分派（C 链路的使用方）。
 * 准入由调用方判定（话题免 @ / 主群 @，见 LarkMvpService.acceptMessage）。
 *
 * 它自己做两件事，都只跟"路由"有关：
 *   · 把"是哪一批"**定位**出来；
 *   · 定位成功 → 把"这一批 + 她说的这句话"**转交**给到货核对（D，可注入）；
 *     认不出来 → 回一句问清楚，结束。
 *
 * ⚠️ 到货的业务规则一个字都不在这里：本类不判断"是不是采购申请单"、不判断
 * "她说完了没有"、不发卡片、不写业务表。这样 D 的规则怎么演进都不会动到定位，
 * 定位这条路明天被别的东西复用也不会带上到货的口径。
 */
class GroupPurchaseFlowService {
  constructor({ locator, replyText, sendText = null, arrivalConversation = null } = {}) {
    if (!locator) throw new Error('GroupPurchaseFlowService 需要 purchaseBatchLocator');
    this.locator = locator;
    // replyText：在**群里原地回复**那条消息（引用回复）。群聊里所有反馈都走它，
    // 免得私聊那套 sendText 把消息发到群里时没有上下文。
    this.replyText = replyText || (async () => '');
    // 保留 sendText 注入位（将来要在群里直接发消息时用），今天没有调用点。
    this.sendText = sendText;
    // 「到货核对」那一半（D）。定位成功之后由它决定"记下来 / 发卡片"。
    // ⚠️ 它是**可选的**：没注入时这里的行为和以前完全一样（只记日志），
    // 所以本类仍然只干"定位 + 分发"一件事，到货的业务规则一个字都不在这里。
    this.arrivalConversation = arrivalConversation;
  }

  /**
   * @param {{ messageId: string, text: string, parentId?: string, threadId?: string,
   *   senderOpenId?: string }} input
   * @returns {Promise<{resolved: boolean, reason: string, batch?: object, batchNo?: string,
   *   replied: boolean, arrival?: object|null}>}
   */
  async handleGroupPurchaseMessage({ messageId, text = '', parentId = '', threadId = '', senderOpenId = '' } = {}) {
    const located = await this.locator.resolve({ text, parentId, threadId });
    if (located.status === 'matched') {
      // 定位成功**只记日志、不回消息**：她引用着采购单说话时，卡片/结果才是回执，
      // 先垫一句"我找到了"只会刷屏。
      logInfo('purchase.group.message.located', {
        message_id: messageId, source: located.source, batch_no: located.batchNo,
      });
      const arrival = await this.dispatchToArrival({ located, messageId, text, threadId, senderOpenId });
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

  /**
   * 把"定位到的这一批 + 她说的这句话"原样交给到货核对。
   *
   * ⚠️ 这里**不做任何业务判断**（不判断"是不是采购申请单"、不判断"她说完了没有"）：
   * 那些都是到货核对那一侧的规则。本方法只负责"转交 + 失败不牵连定位"。
   */
  async dispatchToArrival({ located, messageId, text, threadId, senderOpenId }) {
    if (!this.arrivalConversation) return null;
    try {
      return await this.arrivalConversation.handleTopicMessage({
        batch: located.batch, text, messageId, threadId, senderOpenId,
      });
    } catch (error) {
      // 到货核对出问题绝不能影响"定位"这个已经成功的结论，更不能把整条群消息判失败。
      logWarn('purchase.arrival.reconcile.dispatch_failed', { message_id: messageId, error: error.message });
      return null;
    }
  }
}

module.exports = { GroupPurchaseFlowService, NO_BATCH_REPLY, AMBIGUOUS_BATCH_REPLY };
