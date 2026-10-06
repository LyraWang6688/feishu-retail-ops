const { logWarn } = require('../utils/logger');

// 「某笔销售 → 它当初那条群消息的深链」。
//
// ── 实测结论（2026-10-06，测试群 oc_9f2cb1… 里的**真实消息**）──
// ⭐ 完整证据（curl 到的官方文档 + 逐条 SDK 实测返回）见
//    `docs/reports/group-message-deep-link-2026-10-06.md`，这里只留结论：
//   · `client.im.message.get({ path: { message_id } })` → code=0，**确实不返回** `message_app_link`。
//     试过且都拿不到：默认参数 / `params.with_app_link = true` / `= 'true'`（字符串）/
//     `with_sender_name = true` / 绕过封装直接对 `/open-apis/im/v1/messages/:id` 发原始 GET。
//     同一条响应里 `message_position` / `thread_message_position` / `thread_id` 都有值 ——
//     说明字段位是通的，就是 `message_app_link` 这个字段没有被填。
//   · `client.im.message.list`（container_id_type = chat 或 thread）→ **code 230027**：
//     `need scope: im:message.group_msg`。这是**开发者后台的权限**，代码里绕不过去。
//   · AppLink 协议里**没有**「打开某条消息 / 打开某个话题」这一条（已 curl 官方文档核对：
//     `applink.feishu.cn/client/chat/open` 只认 `openId` / `openChatId`，没有 message/thread 参数）。
//   ⇒ 今天能从**官方渠道**拿到 `message_app_link` 的只有**发送响应**
//     （`im.message.create` / `im.message.reply` 的 `data.message_app_link`，SDK 类型里有这个字段）：
//     那是"发出去的那一刻"才知道的，必须**当时就存进本地映射**
//     （`sales_group_threads` 记录上的 `app_link` 字段，由销售群链路开话题时写）。
//
// ── 本解析器的规矩 ──
// 三级去找，**找不到就返回空 URL**，绝不自己拼一条"看起来能定位、点开却不在话题里"的链接
// （业务负责人明确说过：深链要用飞书给的，不要自己拼）：
//   ① `storedAppLink`：本地映射里存着的那条（发消息时落下来的）——最可靠；
//   ② 现查：`im.message.get` 读 `message_app_link`（开关 `…_LINK_LOOKUP_ENABLED`，默认开；
//      今天是空手而归，但飞书哪天开始返回就自动生效，不用改代码）；
//   ③ `linkTemplate`：**运营自己填**的模板（默认空）。代码不预设任何 URL。
class LarkMessageLinkResolver {
  constructor(options = {}) {
    this.client = options.client || null;
    this.lookupEnabled = options.lookupEnabled !== false;
    this.template = String(options.template || '').trim();
  }

  /**
   * @returns {Promise<{url: string, source: 'stored'|'message_get'|'template'|'unavailable'}>}
   */
  async resolve({ storedAppLink = '', messageId = '', threadId = '', chatId = '' } = {}) {
    const stored = String(storedAppLink || '').trim();
    if (stored) return { url: stored, source: 'stored' };

    const id = String(messageId || '').trim();
    if (this.lookupEnabled && id && this.client?.im?.message?.get) {
      try {
        const response = await this.client.im.message.get({ path: { message_id: id } });
        const url = String(response?.data?.items?.[0]?.message_app_link || '').trim();
        if (url) return { url, source: 'message_get' };
      } catch (error) {
        // 读不到深链不是致命错误：调用方会照常推单号 + 金额，只把原因记下来。
        logWarn('sales.pending_deal_push.link.lookup_failed', {
          message_id: id, error: error.message,
        });
      }
    }

    const fromTemplate = this.applyTemplate({ messageId: id, threadId, chatId });
    if (fromTemplate) return { url: fromTemplate, source: 'template' };

    return { url: '', source: 'unavailable' };
  }

  /** 模板里只替换三个占位符；替换完还是空（或模板本身为空）就返回空串。 */
  applyTemplate({ messageId = '', threadId = '', chatId = '' } = {}) {
    if (!this.template) return '';
    return this.template
      .replace(/\{message_id\}/g, String(messageId || ''))
      .replace(/\{thread_id\}/g, String(threadId || ''))
      .replace(/\{chat_id\}/g, String(chatId || ''))
      .trim();
  }
}

module.exports = { LarkMessageLinkResolver };
