const { logInfo, logWarn } = require('../utils/logger');
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
//   ⇒ 但**不必卡在这儿**：话题深链可以按她给的格式用 `chat_id + thread_id` 拼（见上）。
//   本 service 就是"发出去那一刻"的唯一落点：飞书给就用飞书的，不给就用话题格式拼，都没有就留空。
//
// ── 存哪两处（业务负责人要的两处都要有）──────────────────────────────────
//   ① 本地路由映射 `data/sales_group_threads/`（`SalesGroupThreadLocator`）——
//      机器人自己回查用（"这笔销售当初是哪条群消息"），**不是经营事实、不进她的表**；
//   ② 销售主表的「消息链接」列 —— 她要在表里点。
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
// ⚠️ 边界：本 service **不解析业务、不判断该不该发**；它只做"把链接存到两处 + 如实记日志"。
//   存不下（没拿链接 / 字段没同步 / 网络失败）**只告警，绝不让已经发出去的卡片判失败**。

// 飞书多维表格「超链接」字段的 type：写值必须是 { text, link }，不是裸字符串
// （已 curl 官方文档核对：app-table-record/create 的字段类型说明）。
const BITABLE_URL_FIELD_TYPE = 15;

/** 语义字段名：`v1BitableSchema.tables.salesEntry.fields.messageLink`（业务负责人在生产表加的列）。 */
const MESSAGE_LINK_FIELD_KEY = 'messageLink';

class SalesMessageLinkService {
  constructor(options = {}) {
    if (!options.locator) throw new Error('SalesMessageLinkService 需要 SalesGroupThreadLocator');
    this.locator = options.locator;
    // 网关可以缺省（单测 / 只跑本地映射的场景）：缺了就是"只存本地映射"。
    this.gateway = options.gateway || null;
    // 字段 type 只查一次（省掉每条消息一次 appTableField.list）。
    this.messageLinkFieldType = undefined;
    // 拼话题深链用的模板（她给的格式；配置可覆盖，见 config/salesThreadLink）。
    this.threadLinkTemplate = options.threadLinkTemplate === undefined
      ? resolveSalesThreadLinkTemplate()
      : String(options.threadLinkTemplate || '');
  }

  /**
   * 「发消息那一刻」的唯一入口：把这条回复的深链同时落到本地映射与销售主表。
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
   * @param {boolean} input.storeInBitable 要不要顺手写销售主表「消息链接」列。
   *   ⚠️ **只有"卖卡片"那条出口才写**（`sendTaskCard` / `replyTaskCard`）；**文字回复一律不写**
   *   —— 见 `larkMvpService.sendTaskText` 的注释：深链是**话题级**的（同一个话题不管哪条回复
   *   拼出来都是同一条），卡片那条出口已经写过了；而文字出口里混着"**不猜、不写业务表**"的路径
   *   （例：多笔未收款占位 / 金额对不上时回一句「有多条待收款」），业务表的写入**不能搭在它上面**。
   *   本地路由映射（①）不受这个开关影响：**无论写不写表都要记**。
   * @returns {Promise<{record: object|null, storedInBitable: boolean, link: string, linkSource: string}>}
   */
  async rememberFromSend({
    salesEntryRecordId = '', taskId = '', orderNo = '', messageId = '', threadId = '',
    chatId = '', senderOpenId = '', replyMessageId = '', appLink = '', storeInBitable = true,
  } = {}) {
    const fromSend = String(appLink || '').trim();
    // ② 她给的话题深链格式（chat_id + thread_id 我们都有）；缺 id 时返回空串。
    const fromThread = buildSalesThreadLink({
      chatId, threadId, template: this.threadLinkTemplate,
    });
    const url = fromSend || fromThread;
    const linkSource = fromSend ? 'send_response' : fromThread ? 'thread_format' : '';
    // ① 本地映射：**无论有没有深链都要记**（话题 ↔ 销售 的路由本身是另一件必须的事）。
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
          + ' —— 这一单的「消息链接」留空（不伪造）',
      });
      return { record, storedInBitable: false, link: '', linkSource: '' };
    }

    const storedInBitable = storeInBitable ? await this.writeToSalesEntry({
      salesEntryRecordId, url, messageId: replyMessageId || messageId,
    }) : false;
    if (!storeInBitable) {
      // 如实留一条：这条回复**故意**不碰业务表（本地映射照记），排查时看得出来不是失败。
      logInfo('sales.message_link.bitable_skipped', {
        sales_entry_record_id: String(salesEntryRecordId || '').trim(),
        message_id: String(messageId || '').trim(),
        link_source: linkSource,
        reason: 'this_reply_path_does_not_write_the_business_table',
      });
    }
    return { record, storedInBitable, link: url, linkSource };
  }

  /**
   * 把深链写进销售主表的「消息链接」列。
   *
   * 值格式按**真表的字段类型**决定（Text 写字符串；超链接 type=15 写 {text, link}）：
   * 生产表那一列是她自己建的，本地读不到生产表，所以**不假设类型**、运行时读一次字段元数据。
   * ⚠️ 字段还没同步（schema 里没有 messageLink）→ 一条警告，**不写**（写下去会 FieldNameNotFound）。
   */
  async writeToSalesEntry({ salesEntryRecordId, url, messageId = '' }) {
    const recordId = String(salesEntryRecordId || '').trim();
    const link = String(url || '').trim();
    if (!recordId || !link) return false;
    if (!this.gateway) {
      logWarn('sales.message_link.skipped', { reason: 'no_gateway', sales_entry_record_id: recordId });
      return false;
    }
    const fieldName = this.gateway.table?.('salesEntry')?.fields?.[MESSAGE_LINK_FIELD_KEY];
    if (!fieldName) {
      logWarn('sales.message_link.skipped', {
        reason: 'field_not_mapped', sales_entry_record_id: recordId,
        hint: 'v1BitableSchema.tables.salesEntry.fields.messageLink 没配（生产表那一列叫「消息链接」）',
      });
      return false;
    }

    try {
      const type = await this.resolveMessageLinkFieldType();
      const value = type === BITABLE_URL_FIELD_TYPE ? { text: link, link } : link;
      await this.gateway.update('salesEntry', recordId, { [MESSAGE_LINK_FIELD_KEY]: value });
      logInfo('sales.message_link.stored', {
        sales_entry_record_id: recordId,
        message_id: String(messageId || '').trim(),
        field_type: type,
      });
      return true;
    } catch (error) {
      // 写不进去**不能**影响"卡片已经发出去了"这个事实：只留可排查的痕迹。
      logWarn('sales.message_link.store_failed', {
        sales_entry_record_id: recordId, error: error.message,
      });
      return false;
    }
  }

  /** 「消息链接」列的飞书字段 type；读不到（或没这个字段）返回 undefined（按字符串写）。 */
  async resolveMessageLinkFieldType() {
    if (this.messageLinkFieldType !== undefined) return this.messageLinkFieldType;
    let type;
    try {
      const fields = await this.gateway.listFields('salesEntry');
      const fieldName = this.gateway.table('salesEntry').fields[MESSAGE_LINK_FIELD_KEY];
      type = fields.find((field) => field.field_name === fieldName)?.type;
    } catch (error) {
      logWarn('sales.message_link.field_type_unreadable', { error: error.message });
      type = undefined;
    }
    this.messageLinkFieldType = type;
    return type;
  }
}

module.exports = { SalesMessageLinkService, MESSAGE_LINK_FIELD_KEY, BITABLE_URL_FIELD_TYPE };
