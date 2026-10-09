const { logInfo } = require('../utils/logger');
const { buildSalesThreadLink, resolveSalesThreadLinkTemplate } = require('../config/salesThreadLink');

// 「一条销售群消息的深链」存哪儿 —— 只此一处实现（被 larkMvpService 在**发卡片那一刻**调）。
//
// ── 为什么要有这个 service ────────────────────────────────────────────────
// 业务负责人 2026-10-06 明确：
//   「没关系，我们现在不需要历史消息的补拉了……我在多维表格的销售主表里加了一列
//     叫做**消息链接**，可以写入这里～」
// ⇒ **历史单不管**（拿不到就留空，绝不伪造）；**从今往后新建的单必须能取回链接**。
//
// 而实测（docs/reports/group-message-deep-link-2026-10-06.md）：
//   · `im.message.create` / `im.message.reply` 的**发送响应**里*可能*有 `data.message_app_link`
//     —— 🔴 实测四（2026-10-06 晚，测试群真发 6 条核对 `data` 的键）：**这个应用当前不回带**；
//   · 历史消息用 `im.message.get` / `list` / 官方 AppLink 协议**都取不回来**；
//   ⇒ 但**不必卡在这儿**：话题深链可以按她给的格式用 `chat_id + thread_id` 拼（见下）。
//   本 service 就是"发出去那一刻"的唯一落点：飞书给就用飞书的，不给就用话题格式拼，都没有就留空。
//
// ── 存哪儿（2026-10-09 起**只剩一处**）──────────────────────────────────
//   ① 本地路由映射 `data/sales_group_threads/`（`SalesGroupThreadLocator`）——
//      机器人自己回查用（"这笔销售当初是哪条群消息"），**不是经营事实、不进她的表**。
//      ⭐「9 点推送」里那句「**查看原话**」的深链读的就是它（`pendingDealPushService`）——
//      **这条功能现在仍然活着**，与业务表无关。
//   ② ~~销售主表的「消息链接」列~~ —— 🔴 **2026-10-09 删掉了**：
//      业务负责人当天口径「当前这个状态下，现有的一些字段已经不太适配我们当前的决定了，
//      也就是我们要用**扫码**」⇒ 原话 / 解析状态 / 解析结果摘要 / 失败原因 / **消息链接**
//      这 5 列（语音+文字录入时代的产物）她**从生产表删掉了**，代码同步
//      **删映射 + 删写入点**（`config/v1BitableSchema.salesEntry` 段有完整记录）。
//      ⇒ 本 service 原来那一半（`writeToSalesEntry` / 运行时读字段类型 / `{text, link}` 写法）
//        **整体删除**；`rememberFromSend` 现在**只记本地映射**。
//
// ── 存【哪条消息】的链接：**我们回复的那条（卡片消息）**，不是话题根 ──────────
// 理由（也是唯一可行的选择）：
//   · 话题根是**她**在群里说的那句话（`task.message_id`） —— 不是我们发的，
//     飞书**不会**把它的 `message_app_link` 给我们（只有发送响应才可能回带）；
//   · 我们能拿到链接的只有**我们自己发出去的那条回复**（`reply_in_thread: true`，
//     它就在**同一个话题**里，且主群第一条这样的回复就是**创建**那个话题的那条）。
//   ⇒ 存它，点开就落在同一个话题里，能接着回复。
//   ⭐ 而且**不必等飞书回带**：回复响应里把 `thread_id` 给了我们，配上事件里的 `chat_id`，
//     按**她 2026-10-06 给的真实格式**就能拼出这个话题的深链（`config/salesThreadLink`，
//     她的话：「点开之后就直接可以看到那条消息的所有沟通内容」）。
//   🔴 两个 id 缺一个 → 返回空、**留空**：这里绝不猜、不拿空值拼一条点开是别处的链接。
//
// ⚠️ 边界：本 service **不解析业务、不判断该不该发**；它只做"把链接存到本地一处 + 如实记日志"。
//   存不下（没拿链接 / 网络失败）**只告警，绝不让已经发出去的卡片判失败**。

class SalesMessageLinkService {
  constructor(options = {}) {
    if (!options.locator) throw new Error('SalesMessageLinkService 需要 SalesGroupThreadLocator');
    this.locator = options.locator;
    // 拼话题深链用的模板（她给的格式；配置可覆盖，见 config/salesThreadLink）。
    this.threadLinkTemplate = options.threadLinkTemplate === undefined
      ? resolveSalesThreadLinkTemplate()
      : String(options.threadLinkTemplate || '');
  }

  /**
   * 「发消息那一刻」的唯一入口：把这条回复的深链落到**本地**路由映射。
   *
   * 链接来源有两条，**优先用飞书给的、拿不到就用她给的话题深链格式拼**：
   *   ① 发送响应里的 `data.message_app_link`（飞书回带时才有 —— 实测四：这个应用当前不回带）；
   *   ② `buildSalesThreadLink(chat_id, thread_id)`：她 2026-10-06 给的**真实话题深链格式**，
   *      两个 id 都是我们自己发消息时拿到的（见 config/salesThreadLink 的注释）。
   * ⚠️ 两条都拿不到（例如普通群第一条回复没带 thread_id）→ **留空**，不拼、不猜。
   *
   * @param {object} input
   * @param {string} input.salesEntryRecordId 这个群话题对应的销售主表 record_id
   * @param {string} input.appLink 发送响应里的 `data.message_app_link`（飞书不回带时为空）
   * @param {string} input.replyMessageId 我们刚发出去的那条消息 id（= 链接指向的消息）
   * @returns {Promise<{record: object|null, link: string, linkSource: string}>}
   */
  async rememberFromSend({
    salesEntryRecordId = '', taskId = '', orderNo = '', messageId = '', threadId = '',
    chatId = '', senderOpenId = '', replyMessageId = '', appLink = '',
  } = {}) {
    const fromSend = String(appLink || '').trim();
    // ② 她给的话题深链格式（chat_id + thread_id 我们都有）；缺 id 时返回空串。
    const fromThread = buildSalesThreadLink({
      chatId, threadId, template: this.threadLinkTemplate,
    });
    const url = fromSend || fromThread;
    const linkSource = fromSend ? 'send_response' : fromThread ? 'thread_format' : '';
    // 本地映射：**无论有没有深链都要记**（话题 ↔ 销售 的路由本身是另一件必须的事，
    // 「9 点推送」那句「查看原话」也靠它）。这一处是**唯一**的落点。
    const record = await this.locator.rememberSaleThread({
      salesEntryRecordId, taskId, orderNo, messageId, threadId, chatId, senderOpenId,
      replyMessageId, appLink: fromSend, threadLink: fromThread,
    });

    if (!url) {
      // 两条来源都空：如实记一条，别让她以后问"为什么这单没链接"。
      logInfo('sales.message_link.unavailable', {
        sales_entry_record_id: String(salesEntryRecordId || '').trim(),
        message_id: String(messageId || '').trim(),
        reply_message_id: String(replyMessageId || '').trim(),
        hint: '既没有发送响应的 message_app_link，也没有 chat_id/thread_id 可拼话题深链'
          + ' —— 这一单的深链留空（不伪造）。⚠️ 业务表那一列 2026-10-09 已删，深度链接只在本地',
      });
      return { record, link: '', linkSource: '' };
    }
    return { record, link: url, linkSource };
  }
}

module.exports = { SalesMessageLinkService };
