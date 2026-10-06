const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const doubaoService = require('./doubaoService');
const { arrivalConfirmationCard, arrivalPostedCard } = require('../utils/larkCards');
const { logInfo, logWarn } = require('../utils/logger');
const {
  ARRIVAL_CONFIRM_ACTION,
  ARRIVAL_TIMEZONE,
  arrivalDateOf,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_SEEN_MESSAGE_IDS,
  ZERO_ARRIVAL_REPLY,
  ZERO_ARRIVAL_LOG_REASON,
  UNMATCHED_ARRIVAL_REPLY,
  UNDERSTAND_FAILED_REASON,
  overageNotice,
  postedReply,
  alreadyPostedReply,
} = require('../config/arrivalConversation');
// 入口开关：**就是**当初为「对话到货」刻意保留的那一个（见 config/arrivalConversation.js 的说明）。
const { isPurchaseArrivalIntakeEnabled } = require('../config/purchaseArrivalIntake');

// 一条"对话"的身份。优先用**报货批次号**：一次报货 = 一张采购申请单 = 一个群话题，
// 三者一一对应（见 PurchaseBatchLocator 的映射记录）。
// 批次号缺失（历史映射）时退回 thread_id——**绝不退回"最近一批"**。
const conversationKey = (batchNo, threadId) => {
  const seed = String(batchNo || '').trim() || `thread:${String(threadId || '').trim()}`;
  return `arrival_conversation_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
};

const positiveInt = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/**
 * 「采购到货：群话题对话式核对」里**对话那一半**。
 *
 * 规格：`docs/arrival-conversation-flow.md`（业务负责人 2026-10-06 定稿）。
 * 它负责四步：① 把话题里的话**只记下来**（此时一张业务表都不写）→
 * ② 靠**文字模型**判断她是不是说了"核对完了"（不是关键词匹配）→
 * ③ 在话题里发确认卡片 → ④ 她点「是」时调 `PurchaseWebhookService` 入库。
 *
 * ⚠️ 为什么是**独立 service**（不塞进 PurchaseWebhookService / GroupPurchaseFlowService）：
 *   · `PurchaseWebhookService` 已经够大，而且它管的是"表怎么写"；本类管的是"话怎么理解"。
 *     两件事的变更节奏完全不同（口径会改、表结构也会改），绑在一起就是每次改一处都要动全身。
 *   · `GroupPurchaseFlowService` 只负责"这条消息是哪一批"；把对话状态机塞进去，
 *     它就不再是"定位器 + 一句话交回"了。
 *   · 这条链路**随时可能被她改口径**（她自己说规格会演进），所以它必须能单独关掉、
 *     单独测试、单独替换——见 config/arrivalConversation.js 的开关。
 *
 * ⚠️ 本类**不直接写任何业务表**：
 *   · 核对期间只写自己的本地会话记录（`data/arrival_conversations`，路由信息，不是经营事实）；
 *   · 入库那一步一律经 `purchaseWebhooks`（表怎么写只有那一处实现）。
 *   这条约束有测试钉住：核对期间断言 gateway 的 create/update 调用数为 **0**。
 *
 * ⚠️ 输入（`understand`）与输出（`replyCard` / `replyText` / `updateCard`）全部注入：
 *   单测不需要真的调模型、也不需要真的发消息，就能把整条状态机跑完。
 */
class ArrivalConversationService {
  constructor({
    gateway,
    store,
    purchaseWebhooks,
    understand,
    replyCard,
    replyText,
    updateCard,
    getSizeReferences,
    isEnabled = isPurchaseArrivalIntakeEnabled,
    now = Date.now,
  } = {}) {
    if (!gateway) throw new Error('ArrivalConversationService 需要 gateway');
    if (!purchaseWebhooks) throw new Error('ArrivalConversationService 需要 purchaseWebhooks（入库那一步）');
    this.gateway = gateway;
    this.store = store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/arrival_conversations'),
      idField: 'conversation_id',
    });
    this.purchaseWebhooks = purchaseWebhooks;
    // 读采购申请明细要把「尺码」关联解回整数，用的是项目里唯一的那个尺码服务；
    // 默认从 purchaseWebhooks 借（它们本来就共用同一个实例），也可以显式注入。
    this.getSizeReferences = getSizeReferences
      || (() => purchaseWebhooks.getSizeReferences());
    // 默认实现是项目自己的文字模型入口（和销售录单、采购数量说明同一组配置）。
    this.understand = understand || ((input) => doubaoService.understandArrivalConversation(input));
    this.replyCard = replyCard || (async () => '');
    this.replyText = replyText || (async () => '');
    this.updateCard = updateCard || (async () => false);
    this.isEnabled = isEnabled;
    this.now = now;
  }

  /** 卡片动作分派用：这个动作归本类处理吗。 */
  matches(action) {
    return action === ARRIVAL_CONFIRM_ACTION;
  }

  /**
   * 话题里进来一句话（已由 PurchaseBatchLocator 定位到某一批）。
   *
   * 只做三件事：记下来 → 判意图 → 需要时发卡片。
   * 任何一步失败都只记日志、**绝不抛给群消息入口**：她说的话不能被一条日志级别的
   * 问题弄丢成"这条消息处理失败"。
   *
   * @returns {Promise<{recorded: boolean, evaluated: boolean, state: string, reason: string}>}
   */
  async noteTopicMessage({
    batchNo = '', threadId = '', chatId = '', requestIds = [],
    messageId = '', text = '', senderOpenId = '',
  } = {}) {
    if (!this.isEnabled()) return { recorded: false, evaluated: false, state: '', reason: 'disabled' };
    const normalizedBatchNo = String(batchNo || '').trim();
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedBatchNo && !normalizedThreadId) {
      return { recorded: false, evaluated: false, state: '', reason: 'no_batch_identity' };
    }
    const conversationId = conversationKey(normalizedBatchNo, normalizedThreadId);
    let conversation = await this.store.get(conversationId);
    if (!conversation) {
      conversation = await this.store.create({
        conversation_id: conversationId,
        batch_no: normalizedBatchNo,
        thread_id: normalizedThreadId,
        chat_id: String(chatId || '').trim(),
        request_ids: (Array.isArray(requestIds) ? requestIds : []).filter(Boolean),
        messages: [],
        seen_message_ids: [],
        state: 'collecting',
      });
      logInfo('purchase.arrival.conversation.opened', {
        conversation_id: conversationId, batch_no: normalizedBatchNo, thread_id: normalizedThreadId,
        request_count: conversation.request_ids.length,
      });
    }
    const seen = Array.isArray(conversation.seen_message_ids) ? conversation.seen_message_ids : [];
    if (messageId && seen.includes(messageId)) {
      // 飞书对同一条消息会重投：不重复记录、更不重复判意图（否则会重复发卡片）。
      logInfo('purchase.arrival.conversation.duplicate_message', { conversation_id: conversationId, message_id: messageId });
      return { recorded: false, evaluated: false, state: conversation.state || 'collecting', reason: 'duplicate_message' };
    }
    const body = String(text || '').trim();
    const messages = [...(conversation.messages || []), {
      message_id: String(messageId || ''), text: body,
      sender_open_id: String(senderOpenId || ''), at: this.now(),
    }];
    conversation = await this.store.update(conversationId, {
      messages: messages.slice(-MAX_TRANSCRIPT_MESSAGES),
      // 正文为空的（只 @ 了机器人）不进提示词，但也要记"这条已经处理过了"。
      seen_message_ids: [...seen, messageId].filter(Boolean).slice(-MAX_SEEN_MESSAGE_IDS),
      last_message_at: this.now(),
    });
    logInfo('purchase.arrival.conversation.message_recorded', {
      conversation_id: conversationId, batch_no: conversation.batch_no, message_id: messageId,
      text_length: body.length,
      // ⚠️ 原话本身**不进日志**（群里可能有别的信息）；要追溯看本地会话记录。
    });
    if ((conversation.state || 'collecting') !== 'collecting') {
      // 卡片已经发出去了：她后面再说什么都只记录，不再重复发卡片（"不重复发卡片/不重复回话"）。
      return { recorded: true, evaluated: false, state: conversation.state, reason: `state_${conversation.state}` };
    }
    if (!body) return { recorded: true, evaluated: false, state: 'collecting', reason: 'empty_text' };
    try {
      const result = await this.evaluate(conversation);
      return { recorded: true, ...result };
    } catch (error) {
      logWarn('purchase.arrival.conversation.evaluate_failed', {
        conversation_id: conversationId, error: error.message,
      });
      return { recorded: true, evaluated: false, state: 'collecting', reason: 'evaluate_failed' };
    }
  }

  /**
   * 判意图 → 必要时发确认卡片。**只读业务表、只写本地会话记录**。
   *
   * 返回 { evaluated, state, reason }：evaluated=true 表示这一句被判成"核对完了"。
   */
  async evaluate(conversation) {
    const conversationId = conversation.conversation_id;
    const baseline = (Array.isArray(conversation.baseline) && conversation.baseline.length)
      ? conversation.baseline
      : await this.buildBaseline(conversation);
    if (!baseline.length) {
      // 连申请明细都读不到 → 不能猜"到了什么"。只记日志，等她说下一句或者人工核对。
      logWarn('purchase.arrival.conversation.baseline_missing', {
        conversation_id: conversationId, batch_no: conversation.batch_no,
        request_count: (conversation.request_ids || []).length,
      });
      return { evaluated: false, state: 'collecting', reason: 'baseline_missing' };
    }
    let understood;
    try {
      understood = await this.understand({
        baseline,
        transcript: (conversation.messages || []).map((message) => ({ text: message.text })),
        batchNo: conversation.batch_no,
      });
    } catch (error) {
      // 判不出来 = 继续收集，不猜、不回复（她还在核对过程中，追问只会刷屏）。
      logWarn('purchase.arrival.conversation.understand_failed', {
        conversation_id: conversationId, reason: UNDERSTAND_FAILED_REASON, error: error.message,
      });
      return { evaluated: false, state: 'collecting', reason: UNDERSTAND_FAILED_REASON };
    }
    if (!understood?.finalized) return { evaluated: false, state: 'collecting', reason: 'not_finalized' };

    // 「验收原话」= **最后那句**表达"核对完了"的原话（默认 ⑦：最省，也够追溯）。
    // ⚠️ 全存需要加一列或改成拼接 —— 见 PR 里的"这处待你确认"。
    const finalizingText = [...(conversation.messages || [])].reverse()
      .find((message) => String(message.text || '').trim())?.text || '';
    const { actual, matchedIndexes } = this.resolveActual(understood.items, baseline, conversationId);
    if (matchedIndexes === 0) {
      // 她说的到货在申请里一行都对不上：不入库、不猜，明确回一句。
      // ⚠️ 注意与「全没到」区分：这里连**行号都没对上**，不可能算出"到了几双"。
      await this.notifyOnce(conversation, 'actual_unmatched', UNMATCHED_ARRIVAL_REPLY);
      logWarn('purchase.arrival.conversation.actual_unmatched', {
        conversation_id: conversationId, batch_no: conversation.batch_no,
      });
      return { evaluated: true, state: 'collecting', reason: 'actual_unmatched' };
    }
    const quantity = actual.reduce((sum, item) => sum + item.quantity, 0);
    const overage = actual.reduce((sum, item) => sum + Math.max(0, item.quantity - item.requested_quantity), 0);
    if (quantity <= 0) {
      // ② 实际到货 = 0：`inventory.applyPurchase` 不接受 0，而且"全没到"到底是真没到
      // 还是要取消/改数量只有她改表才能表达。所以**拒绝入库 + 零写入 + 回一句**。
      // ⚠️ 这是**规则**，不是错误：按 logInfo 记，排查时不要按 error 找。
      await this.notifyOnce(conversation, 'zero_arrival', ZERO_ARRIVAL_REPLY);
      logInfo('purchase.arrival.conversation.zero_arrival', {
        conversation_id: conversationId, batch_no: conversation.batch_no,
        reason: ZERO_ARRIVAL_LOG_REASON, table_writes: 0,
      });
      return { evaluated: true, state: 'collecting', reason: 'zero_arrival' };
    }

    // 卡片要发在她说话的那条消息下（一定在同一话题里），不依赖映射记录里存的是哪一条。
    const replyTo = conversation.messages?.[conversation.messages.length - 1]?.message_id || '';
    const prepared = await this.store.update(conversationId, {
      baseline,
      actual,
      finalizing_text: finalizingText,
      overage,
      quantity,
      state: 'awaiting_confirmation',
      card_reply_to: replyTo,
      card_message_id: '',
      // ⚠️ 把申请行号**从基准本身**补回会话记录：映射记录里可能没带 request_ids
      //（历史映射 / 旧数据），而入库那一步要用它去挂回采购申请、并推导报货批次。
      // 不回填的话，"基准靠批次号找回、点「是」却报没有来源"——错在最不该出错的那一步。
      request_ids: [...new Set(baseline.map((row) => row.request_record_id).filter(Boolean))],
    });
    let cardMessageId = '';
    try {
      cardMessageId = await this.replyCard(replyTo, arrivalConfirmationCard({
        conversationId,
        batchNo: prepared.batch_no,
        actual,
        overage,
      }));
    } catch (error) {
      // 卡片没发出去 → 退回 collecting，她的下一句话会重试；绝不能停在"以为发了"的状态。
      await this.store.update(conversationId, { state: 'collecting' });
      logWarn('purchase.arrival.conversation.card_send_failed', {
        conversation_id: conversationId, error: error.message,
      });
      return { evaluated: true, state: 'collecting', reason: 'card_send_failed' };
    }
    await this.store.update(conversationId, { card_message_id: cardMessageId || '' });
    logInfo('purchase.arrival.conversation.card_sent', {
      conversation_id: conversationId, batch_no: prepared.batch_no,
      size_count: actual.length, quantity, overage,
      arrival_date: arrivalDateOf(this.now()), timezone: ARRIVAL_TIMEZONE,
      card_message_id: cardMessageId || '',
    });
    return { evaluated: true, state: 'awaiting_confirmation', reason: 'finalized' };
  }

  /**
   * 读采购申请明细，作为"实际到货"的基准（**只读**）。
   *
   * 优先用映射记录里带的 request_ids（发单时就记好了，最确定）；
   * 拿不到时退回"按批次号找申请行"（历史映射可能没记 request_ids）。
   * 两条都拿不到 → 返回空数组，调用方据此不入库、不猜。
   */
  async buildBaseline(conversation) {
    const requestTable = this.gateway.table('purchaseRequest');
    const rows = [];
    for (const recordId of conversation.request_ids || []) {
      const record = await this.gateway.get('purchaseRequest', recordId).catch(() => null);
      if (record) rows.push(record);
    }
    if (!rows.length && conversation.batch_no) {
      const batchTable = this.gateway.table('purchaseOrderBatch');
      const batch = (await this.gateway.listAll('purchaseOrderBatch'))
        .find((record) => textValue(record.fields?.[batchTable.fields.batchNo]).trim() === conversation.batch_no);
      if (batch) {
        for (const record of await this.gateway.listAll('purchaseRequest')) {
          if (linkedRecordIds(record.fields?.[requestTable.fields.batchNo]).includes(batch.record_id)) rows.push(record);
        }
      }
    }
    const sizes = this.getSizeReferences();
    const baseline = [];
    for (const row of rows) {
      const productRecordId = linkedRecordIds(row.fields?.[requestTable.fields.product])[0] || '';
      if (!productRecordId) {
        logWarn('purchase.arrival.conversation.baseline_row_skipped', {
          conversation_id: conversation.conversation_id, request_record_id: row.record_id, reason: 'no_product',
        });
        continue;
      }
      let size = null;
      try {
        size = (await sizes.resolveLinkedCell(row.fields?.[requestTable.fields.size])).size;
      } catch (error) {
        logWarn('purchase.arrival.conversation.baseline_row_skipped', {
          conversation_id: conversation.conversation_id, request_record_id: row.record_id, reason: error.message,
        });
        continue;
      }
      const product = await this.gateway.get('product', productRecordId).catch(() => null);
      const productTable = this.gateway.table('product');
      const requested = Number(textValue(row.fields?.[requestTable.fields.quantity]));
      baseline.push({
        request_record_id: row.record_id,
        product_record_id: productRecordId,
        item_no: textValue(product?.fields?.[productTable.fields.itemNo]).trim(),
        color: textValue(product?.fields?.[productTable.fields.color]).trim(),
        product_number: textValue(product?.fields?.[productTable.fields.number]).trim(),
        size,
        requested_quantity: Number.isFinite(requested) ? requested : 0,
      });
    }
    return baseline;
  }

  /**
   * 把模型给的「基准行号 + 实际数量」落成实际的到货明细。
   *
   * ⚠️ 未到的尺码**不留记录**（默认 ③）：quantity <= 0 的行直接丢掉，
   * 与"按核对结果入库"一致——「采购入库」只写真的到了的那几条。
   * 基准里没有的行号 / 负数 / 非整数一律**忽略并记 warn**，绝不自己编一条明细。
   *
   * @returns {{actual: Array, matchedIndexes: number}} matchedIndexes = 模型给的行号里
   *   落在基准范围内的条数（**含 quantity = 0**）。它把"行号没对上"与"全都没到"
   *   这两件事分开：前者不能算数量，后者是明确的"本次一双都没到"。
   */
  resolveActual(items, baseline, conversationId) {
    const quantityByIndex = new Map();
    let matchedIndexes = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const index = Number(item?.index);
      if (!Number.isSafeInteger(index) || index < 0 || index >= baseline.length) {
        logWarn('purchase.arrival.conversation.actual_item_ignored', {
          conversation_id: conversationId, index: item?.index, reason: 'index_out_of_range',
        });
        continue;
      }
      // 行号落在基准里就算"对上了"（哪怕数量是 0）：
      // 「全都没到」和「一条都没对上」是两件不同的事，不能混为一谈。
      matchedIndexes += 1;
      const quantity = positiveInt(item?.quantity);
      if (quantity === null) {
        // quantity = 0 是**合法**的（"这个尺码一双都没到"）：它表示"不留记录"，
        // 所以不进 map，也不告警。负数 / 非整数才是要记的异常。
        if (Number(item?.quantity) !== 0) {
          logWarn('purchase.arrival.conversation.actual_item_ignored', {
            conversation_id: conversationId, index, quantity: item?.quantity, reason: 'invalid_quantity',
          });
        }
        continue;
      }
      if (quantityByIndex.has(index)) {
        logWarn('purchase.arrival.conversation.actual_item_duplicated', {
          conversation_id: conversationId, index, kept: quantity, dropped: quantityByIndex.get(index),
        });
      }
      quantityByIndex.set(index, quantity);
    }
    const actual = baseline
      .map((row, index) => ({ row, quantity: quantityByIndex.get(index) || 0 }))
      .filter((entry) => entry.quantity > 0)
      .map(({ row, quantity }) => ({
        product_record_id: row.product_record_id,
        product_number: row.product_number,
        item_no: row.item_no,
        color: row.color,
        size: row.size,
        quantity,
        requested_quantity: row.requested_quantity,
        request_record_id: row.request_record_id,
        created_product: false,
      }));
    return { actual, matchedIndexes };
  }

  /**
   * ⭐ 她点「是」——**这是最终入库的点**（规格 ⑤）。
   *
   * 顺序：先按会话记录确认"确实有一张待确认的卡" → 交给 PurchaseWebhookService
   * （建/找「采购到货」那一行 → 写「采购入库」→ 库存 applyPurchase → 「采购到货」确认状态）
   * → 群里回一句结果 → 把卡片改成"已入库"。
   *
   * 幂等：会话记录一旦进入 `posted` 就直接回"已经入过库了"；
   * 任务那一侧还有 `confirmationQueue` 串行 + `status === 'posted'` 早退 + 入库行回查三道。
   */
  async handleCardAction(value, operatorOpenId, event = {}) {
    const conversationId = String(value?.conversation_id || value?.draft_id || '').trim();
    if (!conversationId) throw new Error('到货确认卡片缺少会话 ID');
    const conversation = await this.store.get(conversationId);
    if (!conversation) throw new Error('这次到货核对已经过期，请重新核对');
    if (conversation.state === 'posted') {
      // 重复点「是」/ 飞书重投：明确回一句，不再写任何表。
      logInfo('purchase.arrival.conversation.already_posted', {
        conversation_id: conversationId, batch_no: conversation.batch_no,
      });
      return { toast: { type: 'info', content: alreadyPostedReply({ batchNo: conversation.batch_no }) } };
    }
    if (conversation.state !== 'awaiting_confirmation') {
      logWarn('purchase.arrival.conversation.card_not_armed', {
        conversation_id: conversationId, state: conversation.state,
      });
      throw new Error('这张卡片对应的核对还没有完成，请先在话题里说一句"核对完了"');
    }
    const actual = Array.isArray(conversation.actual) ? conversation.actual : [];
    if (!actual.length || actual.every((item) => Number(item.quantity) <= 0)) {
      // 兜底：真到 0 的规则在 evaluate 那一步就拦了；卡片如果被重复点，这里也必须零写入。
      await this.safeReplyText(conversation, ZERO_ARRIVAL_REPLY);
      logInfo('purchase.arrival.conversation.zero_arrival', {
        conversation_id: conversationId, batch_no: conversation.batch_no,
        reason: ZERO_ARRIVAL_LOG_REASON, table_writes: 0, stage: 'card_action',
      });
      return { toast: { type: 'warning', content: ZERO_ARRIVAL_REPLY } };
    }

    const occurredAt = this.now();
    const arrivalDate = arrivalDateOf(occurredAt);
    // ④「到货日」= **她点「是」这一刻**（上海时区）。到这一刻之前的任何写入都不该发生，
    // 所以时间戳在这里取，而不是在"核对完了"那一刻。
    let prepared;
    try {
      prepared = await this.purchaseWebhooks.ensureConversationArrival({
        batchNo: conversation.batch_no,
        requestIds: conversation.request_ids || [],
        actual,
        acceptanceText: conversation.finalizing_text || '',
        occurredAt,
        operatorOpenId,
      });
    } catch (error) {
      logWarn('purchase.arrival.conversation.arrival_record_failed', {
        conversation_id: conversationId, batch_no: conversation.batch_no, error: error.message,
      });
      await this.safeReplyText(conversation, `到货记录没建起来，我没有入库：${error.message}`);
      return { toast: { type: 'warning', content: `没有入库：${error.message}` } };
    }
    let posted;
    try {
      posted = await this.purchaseWebhooks.confirmArrivalForConversation(prepared.taskId, operatorOpenId);
    } catch (error) {
      logWarn('purchase.arrival.conversation.post_failed', {
        conversation_id: conversationId, batch_no: conversation.batch_no, error: error.message,
      });
      await this.safeReplyText(conversation, `入库没成功，我没有改任何单据：${error.message}`);
      // 会话留在 awaiting_confirmation：她可以再点一次，重试是安全的（入库那侧幂等）。
      return { toast: { type: 'warning', content: `入库没成功：${error.message}` } };
    }

    const quantity = actual.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const inboundCount = (posted.inboundRecordIds || []).length || actual.length;
    if (posted.alreadyPosted) {
      await this.store.update(conversationId, { state: 'posted', posted_at: occurredAt, arrival_record_id: prepared.arrivalRecordId });
      await this.safeReplyText(conversation, alreadyPostedReply({ batchNo: conversation.batch_no }));
      return { toast: { type: 'info', content: alreadyPostedReply({ batchNo: conversation.batch_no }) } };
    }
    await this.store.update(conversationId, {
      state: 'posted', posted_at: occurredAt, arrival_record_id: prepared.arrivalRecordId,
      inbound_record_ids: posted.inboundRecordIds || [],
    });
    // 回执里带上 ① 的超额说明（"这次比申请多了 X 双"）——她必须知道。
    const resultText = [
      postedReply({ batchNo: conversation.batch_no, inboundCount, quantity, arrivalDate }),
      ...(Number(conversation.overage) > 0 ? [overageNotice(conversation.overage)] : []),
    ].join('\n');
    await this.safeReplyText(conversation, resultText);
    await this.patchPostedCard(conversation, event, { actual, overage: conversation.overage, quantity, arrivalDate });
    logInfo('purchase.arrival.conversation.posted', {
      conversation_id: conversationId, batch_no: conversation.batch_no,
      arrival_record_id: prepared.arrivalRecordId, inbound_count: inboundCount,
      quantity, overage: Number(conversation.overage) || 0,
      arrival_date: arrivalDate, timezone: ARRIVAL_TIMEZONE,
      already_posted: false,
    });
    return { toast: { type: 'success', content: postedReply({ batchNo: conversation.batch_no, inboundCount, quantity, arrivalDate }) } };
  }

  /** 群里回一句。回不出去只记日志：入库已经落地，不能因为一句回执把它判成失败。 */
  async safeReplyText(conversation, content) {
    const target = conversation.card_reply_to || conversation.messages?.[conversation.messages.length - 1]?.message_id || '';
    if (!content || !target) return false;
    try {
      await this.replyText(target, content);
      return true;
    } catch (error) {
      logWarn('purchase.arrival.conversation.reply_failed', {
        conversation_id: conversation.conversation_id, error: error.message,
      });
      return false;
    }
  }

  /**
   * 「规则性」的一句话（全没到 / 到货对不上）：**同一句话只说一次**。
   *
   * 为什么要有它：她可能连着说两句都是同一个意思（"一双都没到，核对完了" / "真的没到"）。
   * 每句都回一遍就是刷屏，而"不重复回话"是验收标准里的一条。
   * 记的是**内容**不是次数：只要这次的说法和上次不同（比如她改口说"到了两双"），
   * 就会正常往下走（走卡片那一路，不经过这里）。
   */
  async notifyOnce(conversation, reason, content) {
    const last = conversation.last_notice;
    if (last && last.reason === reason && last.content === content) {
      logInfo('purchase.arrival.conversation.notice_repeated', {
        conversation_id: conversation.conversation_id, reason,
      });
      return false;
    }
    const replied = await this.safeReplyText(conversation, content);
    await this.store.update(conversation.conversation_id, {
      last_notice: { reason, content, at: this.now() },
    });
    return replied;
  }

  /** 把那张确认卡片改成"已入库"（规格 ⑥：必须有明确反馈，不能让她以为卡住了）。 */
  async patchPostedCard(conversation, event, { actual, overage, quantity, arrivalDate }) {
    try {
      await this.updateCard(event, arrivalPostedCard({
        batchNo: conversation.batch_no,
        actual,
        overage,
        quantity,
        arrivalDate,
      }), { stage: 'posted' });
    } catch (error) {
      // 卡片的 patch 失败不影响入库事实；群里的文字回执已经发出去了。
      logWarn('purchase.arrival.conversation.card_patch_failed', {
        conversation_id: conversation.conversation_id, error: error.message,
      });
    }
  }
}

module.exports = { ArrivalConversationService, conversationKey };
