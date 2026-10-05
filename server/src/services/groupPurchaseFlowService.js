const { logInfo } = require('../utils/logger');

// 「认不出是哪一批」和「说不清是哪一批」的回复文案（配置先行：改文案不碰逻辑）。
// ⚠️ 两条都是**明确的否定**，不是"我猜了一下"：参见 PurchaseBatchLocator 里的三条路。
const NO_BATCH_REPLY = '这条消息我没认出来是哪一批采购单～你引用一下我发的采购单，或者把批次号（BH-开头的那个）说给我。';
const AMBIGUOUS_BATCH_REPLY = '我分不清你说的是哪一批～引用一下我发的采购单，或者把批次号（BH-开头的那个）说给我。';

/**
 * 群里 @ 机器人之后的采购分派（C 链路的使用方）。
 *
 * 今天它只做一件事：**把"是哪一批"定位出来，然后把结果原样交回调用方**。
 * D（到货验收的新语义）还没定，所以这里**不发明任何业务规则**：
 *   · 不发卡片、不写业务表、不改任何状态；
 *   · 认出来 → 返回批次信息，调用方（将来的 D）自己决定下一步；
 *   · 认不出来 → 回一句问清楚，结束。
 *
 * 为什么单独一个类：D 要直接用定位结果，但 D 的业务规则还没定。
 * 把「定位 → 一句话交回」和「拿定位结果去改单据」分开，D 落地时只加一个使用方，
 * 不需要动这里，也不会让今天这版偷偷带上没被确认的验收口径。
 */
class GroupPurchaseFlowService {
  constructor({ locator, replyText, sendText = null } = {}) {
    if (!locator) throw new Error('GroupPurchaseFlowService 需要 purchaseBatchLocator');
    this.locator = locator;
    // replyText：在**群里原地回复**那条消息（引用回复）。群聊里所有反馈都走它，
    // 免得私聊那套 sendText 把消息发到群里时没有上下文。
    this.replyText = replyText || (async () => '');
    // 保留 sendText 注入位（将来 D 要在群里直接发消息时用），今天没有调用点。
    this.sendText = sendText;
  }

  /**
   * @param {{ messageId: string, text: string, parentId?: string, senderOpenId?: string }} input
   * @returns {Promise<{resolved: boolean, reason: string, batch?: object, batchNo?: string, replied: boolean}>}
   */
  async handleGroupPurchaseMessage({ messageId, text = '', parentId = '', senderOpenId = '' } = {}) {
    const located = await this.locator.resolve({ text, parentId });
    if (located.status === 'matched') {
      // 定位成功**只记日志、不回消息**：她引用着采购单说话时，卡片/结果才是回执，
      // 先垫一句"我找到了"只会刷屏。
      logInfo('purchase.group.message.located', {
        message_id: messageId, source: located.source, batch_no: located.batchNo,
      });
      return {
        resolved: true, reason: located.source, batch: located.batch, batchNo: located.batchNo, replied: false,
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
