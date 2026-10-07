const crypto = require('node:crypto');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { person, relation } = require('./v1ReferenceResolver');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const {
  purchaseArrivalReconcileCard,
  purchaseArrivalReconcileStatusCard,
} = require('../utils/larkCards');
const {
  ARRIVAL_CONVERSATION_ACTIONS,
  ARRIVAL_BATCH_KINDS,
  resolveArrivalConversationConfig,
} = require('../config/arrivalConversation');
const { logError, logInfo, logWarn } = require('../utils/logger');

// 会话任务 id 只跟「哪一批」有关，不含时间：同一批单子（含她后来另开一个话题）
// 永远是同一条核对记录，重复投递/重启都不会各起一份。
// `arrival_reconcile_` 前缀让它和销售/采购申请的任务一眼可分。
const taskIdForBatch = (batchNo) =>
  `arrival_reconcile_${crypto.createHash('sha256').update(String(batchNo || '')).digest('hex').slice(0, 24)}`;

const TASK_TYPE = 'purchase_arrival_reconcile';

// 飞书 User 字段转换失败（open_id 不在应用可见范围内 / 不是这个租户的用户）。
// 只有这一种错误才会触发"去掉「验收人」重试一次"，别的错误一律照抛。
const USER_FIELD_CONV_PATTERN = /UserFieldConvFail|1254066/i;

// 回话模板：`{key}` 用值替换，值缺失时原样留着（不静默吞掉占位符）。
// 与 `services/salesThreadProgressService.js` 里的 `formatCopy` 同一套写法
//（同一件事不要有两种拼法；这里是本文件自己的小工具，不跨 service 依赖）。
const formatCopy = (template, values = {}) =>
  String(template || '').replace(/\{(\w+)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? whole : String(values[key])
  ));

// 一行明细在卡片/日志里的身份（货号+颜色+尺码）。
const rowLabel = (row) => `${textValue(row?.item_no) || '（未知货号）'}${textValue(row?.color) || ''} ${Number(row?.size)} 码`;

/**
 * 「采购到货：群话题对话式核对」（业务负责人 2026-10-06 定的口径）。
 *
 * 这个 service 只干**一件事**：把群话题里的自然对话，变成一次「到货核对」的会话状态
 * + 一次触发点。真正的入库能力**一点都没重写**——它调的是 PurchaseWebhookService 里
 * 保留下来的 `confirmArrival`（写「采购入库」→ InventoryService.applyPurchase）。
 *
 * 流程（每一步都对得上她的原话）：
 *   ① 话题里她说话 → 记进本地任务记录（**一张业务表都不写**）；
 *   ② 每条消息都让模型判一次：她说的差异是哪一类（完全一样 / 比申请多 / 比申请少）
 *      ＋她说完了没有（「完毕」之类，字眼不固定 → 靠模型理解，不做关键词匹配）；
 *   ③ ⭐ **收到到货反馈就直接处理**（2026-10-07 业务负责人口径：「用户一般一句话就能够
 *      说清楚这个事情，所以收到用户关于到货情况的反馈时，直接处理就可以」）：
 *      这句话里有可核对的内容（有差异，或她说了「都一样」）→ **直接**算计划 + 在**话题里**
 *      发卡片（是 / 否两个按钮）。**不再要求她先说一句「核对完毕」** ——
 *      `complete` 只剩诊断用途（见下面 `handleTopicMessageLocked` 的注释）。
 *      已经有一张卡片时她再补充/修正 → **重算并更新那一张**，不发第二张；
 *   ④ 点「是」→ 这是**唯一的入库点**：
 *        建「采购到货」一行（用户原话 + 验收人；**到货日交给飞书自动填，代码不写**）
 *        → 「采购入库」按**实际数**（= 申请数 ± 她说的差异）
 *        → 库存流水 / 实时库存跟着变（由 confirmArrival → inventory.applyPurchase 负责）；
 *   ⑤ 点「否」→ **零业务表写入**，只回一句「好，那先不入库」。
 *
 * ⚠️ 「单据信息」（= 采购申请表，以前的「采购申请」）**一个字都不动**：
 *   本类里没有任何对 purchaseRequest 的写路径；`confirmArrival` 里原先那一段
 *   回写入库状态的代码已按她的口径删除（见 purchaseWebhookService 的注释 + 测试里的断言）。
 *
 * ⚠️ 不做的事（她没有说，就不替她决定）：
 *   · 不改采购申请、不改报货表、不建货品（申请行本来就挂着已有货品）。
 *
 * ⭐ 「某一行算出来 `实际 = 0 双`」怎么办（业务负责人 **2026-10-07 当面纠正**，逐字：
 *   「**如果这个尺码算下来为 0，那么就不用入库啊！**」）：
 *   · `实际 = 0` 是**到货核实的正常结果**（供应商漏发一整双），**不是错误**；
 *     该行**不入库**（不写「采购入库」、不调 `inventory.applyPurchase`），
 *     **但绝不阻断整单** —— 其它 `实际 > 0` 的行照常入库；
 *   · 卡片上如实显示「申请 N 双 → 实际 0 双（这双没到）」（文案可配）；
 *   · **真正的「对不上明细」**（尺码/货号在单据里找不到、命中不唯一）仍走
 *     `plan_unmatched` + 一句让她重说的话 —— **两者不许混为一谈**；
 *   · `实际 < 0`（她说少的双数比申请数还多）**既不静默当 0、也不放行**：
 *     回一句"算出来是负数"让她重说（`replies.negative`，事件 `plan_negative`）。
 *   ⚠️ 差异**类型**仍然只有三类（一样 / 多 / 少）—— 她 2026-10-06 定的那个口径一个字没改；
 *     0 是**由「少」算出来的实际数量**，不是第四类差异。
 */
class PurchaseArrivalConversationService {
  constructor({
    gateway,
    store,
    recognizer,
    sizeReferences,
    confirmArrival,
    replyText,
    replyCard,
    updateCard,
    config,
    now,
  } = {}) {
    if (!gateway) throw new Error('PurchaseArrivalConversationService 需要 gateway');
    if (!store) throw new Error('PurchaseArrivalConversationService 需要 store');
    this.gateway = gateway;
    // ⚠️ 刻意**共用采购任务存储**（PurchaseWebhookService 的 store）：
    // `confirmArrival` 是从这个 store 里读草稿的，会话状态放别处就得复制一份过去。
    this.store = store;
    this.recognizer = recognizer;
    // 尺码解析（「尺码」是关联字段，要读回数字）。缺了它只是这条链路读不出明细——
    // 那一步会明确报错，不会静默按错尺码入库。
    this.getSizeReferences = sizeReferences || (() => {
      throw new Error('到货核对缺少尺码解析依赖（sizeReferences）');
    });
    this.confirmArrival = confirmArrival;
    // 群里的反馈一律**引用回复/回复卡片**（群聊没有"上一次对话"的概念）。
    // ⭐ ④ 两个端口都收第三个参数 `{ threadId }`：非空时由**飞书发送适配器**
    //    带 `reply_in_thread` 把这条反馈回到**那个话题**（本类不认识 reply_in_thread）。
    this.replyText = replyText || (async () => '');
    this.replyCard = replyCard || (async () => '');
    this.updateCard = updateCard || (async () => false);
    // 配置从配置模块取；传进来的（测试/多租户）按**字段**覆盖，不会把没覆盖的项变成 undefined。
    const defaults = resolveArrivalConversationConfig();
    this.config = config
      ? {
        ...defaults,
        ...config,
        card: { ...defaults.card, ...(config.card || {}) },
        replies: { ...defaults.replies, ...(config.replies || {}) },
        summary: { ...defaults.summary, ...(config.summary || {}) },
      }
      : defaults;
    this.now = now || (() => Date.now());
    // 同一批的核对串行：同一条话题里两条消息几乎同时到达时，
    // 不能让两边各读到旧 transcript 再互相覆盖（会把她说的话丢掉）。
    this.queue = new KeyedSerialQueue();
  }

  /**
   * 群话题里定位到某一批之后进来（调用方已判定"是哪一批"）。
   *
   * ⭐ 2026-10-07 起：**收到她的到货反馈就直接处理**（算计划 + 出卡片），
   *    不再要求她先说一句"核对完毕"（见 `handleTopicMessageLocked` 里的注释）。
   *
   * @param {{batch?: object, text: string, messageId: string, threadId?: string, senderOpenId?: string}} input
   * @returns {Promise<{handled: boolean, reason?: string, complete?: boolean, card?: boolean, card_updated?: boolean}>}
   *   `complete` 是**模型判断她有没有说完**（诊断用），**不是**"有没有处理"。
   */
  async handleTopicMessage({ batch, text, messageId, threadId = '', senderOpenId = '' } = {}) {
    if (!this.config.enabled) {
      logInfo('purchase.arrival.reconcile.disabled', { message_id: messageId, env: 'PURCHASE_ARRIVAL_CONVERSATION_ENABLED' });
      return { handled: false, reason: 'disabled' };
    }
    const batchNo = textValue(batch?.batch_no);
    if (!messageId || !batchNo) {
      logWarn('purchase.arrival.reconcile.skipped', {
        message_id: messageId || '', batch_no: batchNo, reason: 'missing_identity',
      });
      return { handled: false, reason: 'missing_identity' };
    }
    // 群里同一套话题既发**采购申请单**也发**采购退货单**。退货单不是到货核对的对象，
    // 所以先按映射里的批次类型挡住（旧映射没有 batch_kind 时按默认值"采购申请"处理，
    // 后面读明细时还有一道"退货行没有尺码"的数据闸门兜底）。
    const kind = textValue(batch?.batch_kind) || textValue(batch?.kind) || ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST;
    if (kind !== ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST) {
      logInfo('purchase.arrival.reconcile.skipped', {
        message_id: messageId, batch_no: batchNo, reason: 'batch_kind_not_purchase_request', kind,
      });
      return { handled: false, reason: 'batch_kind_not_purchase_request' };
    }
    const taskId = taskIdForBatch(batchNo);
    return this.queue.run(taskId, () => this.handleTopicMessageLocked({
      taskId, batch, batchNo, text, messageId, threadId, senderOpenId,
    }));
  }

  async handleTopicMessageLocked({ taskId, batch, batchNo, text, messageId, threadId, senderOpenId }) {
    const { replies } = this.config;
    let task = await this.store.get(taskId);
    if (task?.status === 'posted') {
      // 已经入过库还继续说：**一个字都不写**，明确告诉她这批处理过了（不静默）。
      logInfo('purchase.arrival.reconcile.after_posted', { task_id: taskId, message_id: messageId });
      await this.safeReplyText(messageId, replies.afterPosted, { threadId });
      return { handled: true, reason: 'already_posted' };
    }
    if (!task) {
      task = await this.store.create({
        task_id: taskId,
        type: TASK_TYPE,
        status: 'collecting',
        batch_no: batchNo,
        batch_record_id: textValue(batch?.batch_record_id),
        thread_id: String(threadId || ''),
        chat_id: textValue(batch?.chat_id),
        transcript: [],
      });
      logInfo('purchase.arrival.reconcile.started', {
        task_id: taskId, batch_no: batchNo, message_id: messageId, thread_id: threadId || '',
      });
    }
    // 这张任务上**已经发出去的卡片**（她之前说过一句，卡片正在话题里等她确认）。
    // 有它 → 这一轮算完要**更新那一张**，而不是再发第二张（见下面发卡片那段）。
    const existingCardMessageId = String(task?.card_message_id || '').trim();
    const existing = Array.isArray(task.transcript) ? task.transcript : [];
    // 飞书会重投事件：同一条 message_id 只记一次，否则同一句话会被模型看两遍。
    if (existing.some((item) => String(item?.message_id || '') === String(messageId))) {
      return { handled: true, reason: 'duplicate_message' };
    }
    const transcript = [...existing, {
      message_id: String(messageId),
      text: String(text || ''),
      sender_open_id: String(senderOpenId || ''),
      at: new Date(this.now()).toISOString(),
    }];
    task = await this.store.update(taskId, {
      transcript,
      thread_id: String(threadId || task.thread_id || ''),
      chat_id: textValue(batch?.chat_id) || task.chat_id || '',
      sender_open_id: task.sender_open_id || String(senderOpenId || ''),
    });

    // ── 读这批的采购申请明细（只读）─────────────────────────────────────────
    const snapshot = await this.loadRequestRows(batch);
    if (!snapshot.ok) {
      // 读不到明细就不猜、也不回话（回一句"我认不出"会刷屏；日志是排查入口）。
      logWarn('purchase.arrival.reconcile.request_rows_unavailable', {
        task_id: taskId, batch_no: batchNo, reason: snapshot.reason,
      });
      return { handled: false, reason: snapshot.reason };
    }

    // ── 让模型判：说完了没有 + 差异是哪一类、多少 ─────────────────────────────
    let parsed;
    const transcriptTexts = transcript.map((item) => item.text);
    try {
      parsed = await this.recognizer.parseArrivalReconciliation({
        taskId,
        rows: snapshot.rows.map((row) => ({
          item_no: row.item_no, color: row.color, size: row.size, quantity: row.quantity,
        })),
        messages: this.trimTranscript(transcriptTexts),
      });
    } catch (error) {
      // 模型/网络抖一下不能影响业务：**不入库、不回错误刷屏**，她再说一遍还会走同一条路。
      logWarn('purchase.arrival.reconcile.parse_failed', { task_id: taskId, error: error.message });
      return { handled: true, reason: 'parse_failed' };
    }
    await this.store.update(taskId, {
      request_rows: snapshot.rows,
      request_ids: snapshot.requestIds,
      batch_record_id: snapshot.batchRecordId || task.batch_record_id || '',
      last_parse: { complete: parsed.complete, same: parsed.same, difference_count: parsed.differences.length },
    });
    // ⭐ 2026-10-07 业务负责人口径（逐字）：「**用户一般一句话就能够说清楚这个事情，
    //    所以收到用户关于到货情况的反馈时，直接处理就可以。**」
    //    ⇒ ⚠️ 这里**不再**因为 `complete === false` 就"只记录、不回话" ——
    //       原来那条 `purchase.arrival.reconcile.collecting` + 提前 return 已经删掉。
    //       `complete` 只说明"模型认为她有没有说完"，**不是"要不要处理"的闸门**。
    //    但"能核对"这件事仍然要有内容 —— 见下面的 `hasArrivalContent`：
    //      · `differences` 非空  → 她在说实际到货（多/少/某行一样）→ 直接算；
    //      · `same === true`     → 她说「都到了 / 跟单子一样」→ 也是到货反馈 → 直接算；
    //      · 两者都没有          → 这句话里**没有可核对的到货信息**（半句话，或话题里的闲聊）。
    logInfo('purchase.arrival.reconcile.processing', {
      task_id: taskId, batch_no: batchNo, message_count: transcript.length,
      // 诊断字段：模型当时判断她说完了没有 / 说没说"都一样"。**只作排查用**，不参与业务判断。
      parse_complete: Boolean(parsed.complete), parse_same: Boolean(parsed.same),
      difference_count: parsed.differences.length,
    });
    const hasArrivalContent = parsed.differences.length > 0 || parsed.same === true;
    if (!hasArrivalContent) {
      // ⚠️ 这句话里没有任何可核对的到货信息 → **不发卡片、不写任何业务表**。
      //    绝不能当成"全部到货"：那会让她一点「是」就按**申请数整单入库**。
      logInfo('purchase.arrival.reconcile.no_arrival_content', {
        task_id: taskId, batch_no: batchNo, message_count: transcript.length,
        parse_complete: Boolean(parsed.complete),
        note: '这句话里没有可核对的到货信息：不发卡片、不写业务表',
      });
      // `complete` 在这里**只**决定"要不要回一句"（纯体验，不是闸门）：
      //   · 她说完了却什么都没给出 → 回一句教她怎么说（否则她会以为机器人没反应）；
      //   · 她还在说（半句话）     → 静默（也可能就是闲聊，回话会刷屏）。
      if (parsed.complete === true && replies.noArrivalContent) {
        await this.safeReplyText(messageId, replies.noArrivalContent, { threadId });
      }
      return { handled: true, complete: Boolean(parsed.complete), reason: 'no_arrival_content' };
    }

    // ── 算实际到货 = 申请数 ± 她说的差异 ────────────────────────────────────
    const plan = this.buildPlan(snapshot.rows, parsed);
    if (!plan.ok) {
      // ⚠️ 两种"不算数"要分得清清楚楚（2026-10-07）：
      //   · `difference_unmatched` = **她说的货号/尺码对不上明细**（真 unmatched，原样保留）；
      //   · `actual_not_positive`  = 算出来**是负数**（数字对不上，不是没对上明细）。
      //   两者都不入库，但回话不同 —— 让她知道该改哪儿。
      const negative = plan.reason === 'actual_not_positive';
      logWarn(negative ? 'purchase.arrival.reconcile.plan_negative' : 'purchase.arrival.reconcile.plan_unmatched', {
        task_id: taskId, batch_no: batchNo, reason: plan.reason,
      });
      await this.safeReplyText(messageId, negative ? replies.negative : replies.unmatched, { threadId });
      return { handled: true, complete: true, plan_ok: false, reason: plan.reason };
    }
    // ⭐ `实际 = 0` 的行是**正常结果**（她 2026-10-07 拍板）：照常发卡片，
    //    只是这些行在卡片上写"这双没到"、点「是」时也不会入库。这里先记一条可排查的日志。
    const zeroRows = plan.rows.filter((row) => Number(row.actual) === 0);
    if (zeroRows.length) {
      logInfo('purchase.arrival.reconcile.plan_zero_actual', {
        task_id: taskId, batch_no: batchNo, zero_actual_count: zeroRows.length,
        request_row_count: plan.rows.length,
        rows: zeroRows.map((row) => ({
          item_no: row.item_no, color: row.color, size: row.size, quantity: row.quantity,
        })),
        note: '这些行实际 0 双：卡照样发、点「是」时不入库（不写库存流水），不阻断整单',
      });
    }

    // ── 发 / 更新卡片（是 / 否）──────────────────────────────────────────────
    const card = purchaseArrivalReconcileCard({
      taskId,
      batchNo,
      rows: plan.rows,
      differences: plan.differences,
      copy: this.config.card,
    });
    // ⭐ 2026-10-07：这张任务**已经有一张卡片**（她之前说过一句，卡片正在话题里等她确认）
    //    → **重算并更新那一张**，不再发第二张。
    //    为什么不能发第二张：话题里会出现两张**都能点**的卡片，她不知道该点哪张。
    //    更新之后她眼前那张始终是最新算出来的数量。
    let cardMessageId = '';
    let cardUpdated = false;
    if (existingCardMessageId) {
      cardUpdated = await this.safeUpdateCard(existingCardMessageId, card);
      if (cardUpdated) cardMessageId = existingCardMessageId;
    }
    if (!cardUpdated) {
      // 没有历史卡片（第一次算出来）**或**更新失败 → 发一张新的。
      // ⚠️ 更新失败也必须发新的：旧卡上是**过期数字**，让她点它就是让她确认错的数量。
      try {
        // ⭐ ④ 卡片回到**她说话的那个话题**（`{ threadId }` 一路传到飞书发送适配器，
        //    由它决定用不用 `reply_in_thread`）。主群 @ 进来（threadId 为空）时行为不变。
        cardMessageId = await this.replyCard(messageId, card, { threadId });
      } catch (error) {
        // 卡片发不出去：她再说一句就会重算重发（nothing was written）。
        logWarn('purchase.arrival.reconcile.card_send_failed', { task_id: taskId, error: error.message });
        return { handled: true, complete: Boolean(parsed.complete), card: false, reason: 'card_send_failed' };
      }
      if (existingCardMessageId) {
        logWarn('purchase.arrival.reconcile.card_update_fallback_sent', {
          task_id: taskId, stale_card_message_id: existingCardMessageId, new_card_message_id: cardMessageId,
          note: '旧卡更新失败，补发了一张新卡；两张卡指向同一个 taskId，点哪张都按最新计划入库',
        });
      }
    }
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update(taskId, {
      status: 'awaiting_confirmation',
      plan: plan.rows,
      differences: plan.differences,
      acceptance_text: transcriptTexts.join(this.config.acceptanceTextSeparator),
      request_rows: snapshot.rows,
      request_ids: snapshot.requestIds,
      batch_record_id: snapshot.batchRecordId || task.batch_record_id || '',
      card_message_id: cardMessageId,
      operator_open_id: String(senderOpenId || task.operator_open_id || ''),
      ...(cardUpdated ? { card_updated_at: nowIso } : { card_sent_at: nowIso }),
    });
    const cardLog = {
      task_id: taskId, batch_no: batchNo, card_message_id: cardMessageId,
      row_count: plan.rows.length, difference_count: plan.differences.length,
      // 0 双的行数（她 2026-10-07 起的正常情况）：卡片上写了「这双没到」。
      zero_actual_count: zeroRows.length,
      adjustment_total: plan.rows.reduce((sum, row) => sum + (row.actual - row.quantity), 0),
      // ⭐ `complete` 只作**诊断**（模型判断她说完了没有），不再是闸门。
      parse_complete: Boolean(parsed.complete),
      card_action: cardUpdated ? 'updated' : 'sent',
    };
    if (cardUpdated) {
      logInfo('purchase.arrival.reconcile.card_updated', cardLog);
      // 卡片是原地刷新的，不一定会让她注意到 —— 回一句让她知道"已经按新说的重算过了"。
      if (replies.updatedCard) await this.safeReplyText(messageId, replies.updatedCard, { threadId });
    } else {
      logInfo('purchase.arrival.reconcile.card_sent', cardLog);
    }
    return { handled: true, complete: Boolean(parsed.complete), card: true, card_updated: cardUpdated, taskId };
  }

  /**
   * 卡片动作入口。**只认这张卡片的两个动作名**，其余一律返回 null（交给别的链路）。
   *
   * @returns {Promise<{toast?: object}|null>}
   */
  async handleCardAction(value, event = {}, operatorOpenId = '') {
    const action = value?.action;
    if (![ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, ARRIVAL_CONVERSATION_ACTIONS.REJECT].includes(action)) return null;
    const taskId = String(value?.draft_id || '').trim();
    if (!taskId) throw new Error('到货核对卡片缺少任务 ID');
    return this.queue.run(taskId, () => (action === ARRIVAL_CONVERSATION_ACTIONS.CONFIRM
      ? this.confirmLocked(taskId, operatorOpenId, event)
      : this.rejectLocked(taskId, operatorOpenId, event)));
  }

  /**
   * 点「否」：**零业务表写入**，只回一句「好，那先不入库」（她 2026-10-06 定的最保守做法）。
   *
   * 刻意**不把状态定成终态**：她没说过"否完就不能改主意"。
   * 点了「否」之后再点「是」，仍然按"她的显式指令"入库（那时候入库点还是「是」）。
   */
  async rejectLocked(taskId, operatorOpenId, event = {}) {
    const task = await this.store.get(taskId);
    if (!task) return { toast: { type: 'error', content: '这条到货核对记录已经找不到了' } };
    if (task.status === 'posted') {
      return { toast: { type: 'info', content: this.config.replies.alreadyPosted } };
    }
    await this.store.update(taskId, {
      status: 'rejected',
      rejected_by: String(operatorOpenId || ''),
      rejected_at: new Date(this.now()).toISOString(),
    });
    logInfo('purchase.arrival.reconcile.rejected', {
      task_id: taskId, batch_no: task.batch_no || '', operator_open_id: operatorOpenId || '',
      // 这一处她**没有明说**"否"之后还能不能再点「是」；按最保守做：不改任何表、也不锁死。
      tables_written: 0,
    });
    const cardMessageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id || '';
    await this.safeReplyText(cardMessageId, this.config.replies.rejected);
    return { toast: { type: 'info', content: this.config.replies.rejected } };
  }

  /**
   * 点「是」：**这才是入库点**。
   *
   * 顺序（不能换）：
   *   ① 「采购到货」新增一行（用户原话 + 验收人；**到货日交给飞书自动填**）；
   *   ② 把草稿写进任务（`draft.actual` 是按实际调整完的数量、`draft.requests` 是申请行）；
   *   ③ `confirmArrival` → 「采购入库」逐行写入 + `inventory.applyPurchase`
   *      （「库存流水」+「实时库存」由它负责，这里不另写一套）。
   *
   * 幂等：`task.status === 'posted'` 早退；`arrival_record_id` 落盘后复用；
   * 更里面的「采购入库」幂等由 `confirmArrival` 自己保证（inbound_created + 远端回查 + 串行队列）。
   */
  async confirmLocked(taskId, operatorOpenId, event = {}) {
    const { replies } = this.config;
    const task = await this.store.get(taskId);
    if (!task) return { toast: { type: 'error', content: '这条到货核对记录已经找不到了' } };
    if (task.status === 'posted') {
      // 重复点「是」（双击 / 飞书重投）：**不重复入库**，如实回执。
      logInfo('purchase.arrival.reconcile.confirm_duplicate', { task_id: taskId, operator_open_id: operatorOpenId || '' });
      return { toast: { type: 'info', content: replies.alreadyPosted } };
    }
    if (!Array.isArray(task.plan) || !task.plan.length || !task.acceptance_text
      || !task.request_ids?.length || !task.request_rows?.length) {
      return { toast: { type: 'info', content: replies.notConfirmedYet } };
    }
    let arrivalRecordId = String(task.arrival_record_id || '').trim();
    if (!arrivalRecordId) {
      try {
        arrivalRecordId = await this.createArrivalRecord(task, operatorOpenId);
      } catch (error) {
        logError('purchase.arrival.reconcile.arrival_create_failed', { task_id: taskId, error: error.message });
        return { toast: { type: 'error', content: `「采购到货」这一行没建成：${error.message}。请再点一次「是」` } };
      }
      // 立刻落盘：崩溃在"建完还没记住"之间时，重试靠它复用同一行，不会建出第二条到货记录。
      await this.store.update(taskId, { arrival_record_id: arrivalRecordId });
    }
    const requests = [];
    for (const requestId of task.request_ids) {
      const record = await this.gateway.get('purchaseRequest', requestId).catch(() => null);
      if (record) requests.push(record);
    }
    // ⚠️ 这里的形状就是 confirmArrival 一直在等的草稿形状：
    //    actual = 按实际调整完的明细（每行一条 货品+尺码+实际双数）
    //    requests = 申请行原样（只用来把「采购入库」的「采购申请」关联挂回去）
    //    pending_creation 空数组：到货的货品在建采购申请时就已经存在了，这里不建新品。
    // ⭐ 2026-10-07：`实际 = 0 双` 的行**到这里就被摘掉**，一张表都不写 ——
    //    不写「采购入库」、不调 inventory.applyPurchase（库存流水/实时库存都不动）。
    //    为什么在**建草稿这一步**摘（而不是塞给 confirmArrival 让它跳过）：
    //      · `PurchaseWebhookService.aggregateArrivalItems` 对 `quantity <= 0` **当场抛错**
    //        （那道闸门是给"数量无效"兜底的，不能放宽 —— 它同样拦着负数）；
    //      · 在源头摘掉，"没到"这个事实就只存在于**核对卡片 + 日志**里，
    //        下游入库能力完全不必认识"0 双"这个新概念（解耦：将来换入库实现也不受影响）。
    //    其它行（actual > 0）照常入库；全部是 0 时 postable 为空 —— 那是"一件都没到"，
    //    流程照样收尾（见 summary.postedNothingArrived），**不卡单**。
    const zeroRows = task.plan.filter((row) => Number(row.actual) === 0);
    const postableRows = task.plan.filter((row) => Number(row.actual) !== 0);
    const draft = {
      arrival_record_id: arrivalRecordId,
      batch_no: task.batch_no || '',
      operator_open_id: String(task.operator_open_id || operatorOpenId || ''),
      requests,
      actual: postableRows.map((row) => ({
        product_record_id: row.product_record_id,
        item_no: row.item_no,
        color: row.color,
        size: row.size,
        quantity: row.actual,
      })),
      pending_creation: [],
    };
    await this.store.update(taskId, { status: 'posting', draft, confirmed_by: String(operatorOpenId || '') });
    const latest = await this.store.get(taskId);
    try {
      await this.confirmArrival(taskId, latest, operatorOpenId);
    } catch (error) {
      // 入库中途失败：**不改状态**（停在 posting），她再点一次「是」会从断点继续。
      logError('purchase.arrival.reconcile.confirm_failed', { task_id: taskId, error: error.message });
      await this.safeReplyText(this.replyTarget(event, task), `入库没成功：${error.message}。请再点一次「是」`);
      return { toast: { type: 'error', content: `入库没成功：${error.message}` } };
    }
    await this.store.update(taskId, { status: 'posted', posted_at: new Date(this.now()).toISOString() });
    const total = draft.actual.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    // 回话模板（可配）：没有 0 行 → 与改动前逐字相同；有 0 行 → 说清"这些行没入库"；
    // 全是 0 行 → 不能写成"已入库 0 条"含糊过去，用专门那句。
    const summaryTemplate = zeroRows.length === 0
      ? this.config.summary.posted
      : (draft.actual.length === 0
        ? this.config.summary.postedNothingArrived
        : this.config.summary.postedWithZero);
    const summary = formatCopy(summaryTemplate, {
      rowCount: draft.actual.length,
      total,
      zeroCount: zeroRows.length,
      batchNo: task.batch_no || '（未知）',
    });
    // 明确反馈（群里回一句 + 卡片改成终态）。发不出去只记日志，业务事实已经落地。
    // ⚠️ 顺序：先落库（上面那一步）再回话——回话失败不能把已经入库的事实判成失败。
    await this.safeReplyText(this.replyTarget(event, task), summary);
    await this.safeUpdateCard(
      event?.context?.open_message_id || event?.open_message_id || task.card_message_id || '',
      purchaseArrivalReconcileStatusCard({ batchNo: task.batch_no || '', message: summary, template: 'green' }),
    );
    // ⭐ 正向证据：这些行**没有**入库（不是"看起来没写"，是把该写多少写进日志）。
    //    与 `purchase.arrival.reconcile.posted` 一起看，就能核清"0 双的行到底动没动库存"。
    if (zeroRows.length) {
      logInfo('purchase.arrival.reconcile.zero_actual_skipped', {
        task_id: taskId, batch_no: task.batch_no || '',
        zero_actual_count: zeroRows.length,
        rows: zeroRows.map((row) => ({
          item_no: row.item_no, color: row.color, size: row.size, quantity: row.quantity, actual: 0,
        })),
        inbound_rows_written: 0,
        inventory_apply_calls: 0,
        note: '实际 0 双的行：不入库、不写库存流水（业务负责人 2026-10-07 口径）',
      });
    }
    logInfo('purchase.arrival.reconcile.posted', {
      task_id: taskId, batch_no: task.batch_no || '', arrival_record_id: arrivalRecordId,
      // row_count = 这次核对**一共几行**（含没到的），posting 的口径看下面两个字段。
      row_count: task.plan.length,
      posted_row_count: draft.actual.length,
      skipped_zero_count: zeroRows.length,
      skipped_zero_rows: zeroRows.map(rowLabel),
      total_quantity: total,
      // 「单据信息」（采购申请表）在这条链路上**一个字都没写**——这是断言钉住的口径。
      purchase_request_writes: 0,
    });
    // ⚠️ 只回自己的 toast：`confirmArrival` 返回的 toast 是"给卡片点的人看的一句话"，
    //    和这里这句"按实际到货入库"是两回事，展开到前面会把它盖掉（踩过一次）。
    return { toast: { type: 'success', content: summary } };
  }

  /**
   * 「采购到货」新增一行。
   *
   * ⚠️ **刻意不写「到货日」**：它在飞书里是「自动填写」的日期字段
   * （2026-10-06 用项目代码读生产真表核对过：`type: 5 / ui_type: DateTime / property.auto_fill: true`），
   * 新建记录时飞书自己按当天填。口径是「只有「收款时间」需要代码写，其余时间字段一律交给飞书自动生成」。
   *
   * 写进去的只有三样，一样都不多：
   *   · 「报货批次号」= 这一批（关联）；
   *   · 「验收原话」= 她在话题里说过的原话（多句按配置的连接符归集成一个文本）；
   *   · 「验收人」= 点「是」的那个人（**尽力而为**，见下）。
   * 刻意不写「确认状态」：入库那一步（confirmArrival）自己会把它改成「已确认」，
   * 两处都写早晚会写歪。
   *
   * ⚠️ 「验收人」为什么是尽力而为：她**没有要求**这个字段（是我加的留痕）。
   * 飞书的 User 字段对 open_id 很挑（不在应用可见范围内会直接
   * `UserFieldConvFail / 1254066` 让整条 create 失败），**不能让"我加的一个附加字段"
   * 把她真正要的入库挡住**。所以只在**确实是用户字段转换失败**时退一步重试一次
   * （去掉「验收人」），其它错误照旧往上抛、一个字都不写。
   * （真实 E2E 里就是被这一条抓出来的：测试 Base 用假 open_id 建记录时报 1254066。）
   */
  async createArrivalRecord(task, operatorOpenId) {
    // 先回查再创建：同一个批次 + 同一句原话 = 同一次核对。
    // 崩溃在"建完还没落盘"之间时，重试靠它复用同一行，不会建出第二条到货记录
    //（两条到货记录会让 confirmArrival 的"按到货记录回查"失效，进而写出两套入库行）。
    const existing = await this.findExistingArrival(task);
    if (existing) {
      logInfo('purchase.arrival.reconcile.arrival_reused', {
        task_id: task.task_id, arrival_record_id: existing, batch_no: task.batch_no || '',
      });
      return existing;
    }
    const baseValues = {
      batch: relation(String(task.batch_record_id || '').trim()),
      acceptanceText: String(task.acceptance_text || ''),
    };
    const operator = String(operatorOpenId || '').trim();
    let created;
    try {
      created = await this.gateway.create('purchaseArrival', { ...baseValues, inspector: person(operator) });
    } catch (error) {
      if (!USER_FIELD_CONV_PATTERN.test(String(error?.message || ''))) throw error;
      logWarn('purchase.arrival.reconcile.inspector_rejected', {
        task_id: task.task_id, reason: 'user_field_conversion_failed',
        hint: '「验收人」写不进去（open_id 不在应用可见范围内），去掉它重试一次；其余字段照写',
      });
      created = await this.gateway.create('purchaseArrival', baseValues);
    }
    const recordId = created?.recordId || '';
    if (!recordId) throw new Error('「采购到货」新建记录没有返回 record_id');
    logInfo('purchase.arrival.reconcile.arrival_created', {
      task_id: task.task_id, arrival_record_id: recordId, batch_no: task.batch_no || '',
      // 明写"没写到货日"：这是口径，也是将来别人改这段代码时的绊线。
      wrote_arrival_date: false,
    });
    return recordId;
  }

  /** 回查同批次 + 同原话的到货记录（本地任务丢盘时的幂等兜底）。 */
  async findExistingArrival(task) {
    const batchRecordId = String(task.batch_record_id || '').trim();
    const acceptanceText = String(task.acceptance_text || '');
    if (!batchRecordId || !acceptanceText) return '';
    const table = this.gateway.table('purchaseArrival');
    const records = await this.gateway.listAll('purchaseArrival').catch(() => []);
    for (const record of records) {
      if (!linkedRecordIds(record.fields?.[table.fields.batch]).includes(batchRecordId)) continue;
      if (textValue(record.fields?.[table.fields.acceptanceText]) === acceptanceText) return record.record_id;
    }
    return '';
  }

  /**
   * 把她说的话算成"实际到货"。
   *
   * 三类差异（业务负责人 2026-10-06 定的，**只有这三类**）：
   *   · 完全一样（`same: true`）→ 实际 = 申请数；
   *   · 比申请多 → 实际 = 申请数 + 她说的双数；
   *   · 比申请少 → 实际 = 申请数 − 她说的双数。
   *
   * ⭐ `实际 = 0`（业务负责人 **2026-10-07 当面纠正**，逐字：
   *   「**如果这个尺码算下来为 0，那么就不用入库啊！**」）：
   *   **放行**——它是"少"这条差异算出来的**正常结果**（供应商漏发一整双）。
   *   该行由调用方在入库那一步摘掉（不入库、不写库存流水），**不阻断整单**。
   *
   * ⚠️ 仍然拦住的是**负数**（她说少的双数比这行申请数还多）：
   *   那不是事实、只可能是口误/听错，**既不放行、也不静默夹成 0**（夹成 0 等于替她编
   *   一行"没到"）；reason 维持 `actual_not_positive`（既有断言钉住这个取值），
   *   回话由调用方换成"算出来是负数"那一句（见 `replies.negative`）。
   *
   * @returns {{ok: true, rows: Array, differences: Array} | {ok: false, reason: string}}
   */
  buildPlan(rows, parsed) {
    const actualById = new Map(rows.map((row) => [row.request_record_id, row.quantity]));
    if (parsed.same) {
      return { ok: true, rows: rows.map((row) => ({ ...row, actual: row.quantity })), differences: [] };
    }
    const differences = [];
    for (const diff of parsed.differences || []) {
      // 命中行：尺码必须匹配；货号/颜色她说了就必须也对上。
      // 命中不唯一（或一条都没命中）→ 整单不入库：宁可让她再说一遍，也不能把差异记到别的行上。
      const matches = rows.filter((row) => Number(row.size) === Number(diff.size)
        && (!diff.item_no || String(row.item_no) === String(diff.item_no))
        && (!diff.color || String(row.color) === String(diff.color)));
      if (matches.length !== 1) return { ok: false, reason: 'difference_unmatched' };
      const row = matches[0];
      const delta = diff.type === 'more' ? diff.quantity : diff.type === 'less' ? -diff.quantity : 0;
      actualById.set(row.request_record_id, actualById.get(row.request_record_id) + delta);
      differences.push({
        item_no: row.item_no, color: row.color, size: row.size,
        type: diff.type, quantity: diff.quantity, request_record_id: row.request_record_id,
      });
    }
    const plan = rows.map((row) => ({ ...row, actual: actualById.get(row.request_record_id) }));
    // ⚠️ 只拦"算不出来 / 负数"：`actual === 0` 是**允许**的（2026-10-07 口径）。
    if (plan.some((row) => !Number.isSafeInteger(row.actual) || row.actual < 0)) {
      return { ok: false, reason: 'actual_not_positive' };
    }
    return { ok: true, rows: plan, differences };
  }

  /**
   * 读这批的采购申请明细（**只读**）。
   *
   * 从哪来：群消息映射记录里的 `request_ids`（发采购单进群时记的），
   * 每条申请行再读出「编号」「尺码」「数量」，并按货品记录补上「货号」「颜色」
   *（模型要能看到货号和颜色，才能把"少了两双 38"对到具体一行上）。
   *
   * ⚠️ 采购退货单也在同一张表里，但**退货行没有尺码**——这里直接判不可核对，
   * 所以即使批次类型标记缺失，也不会把退货话题当成到货核对。
   */
  async loadRequestRows(batch) {
    const requestIds = [...new Set((batch?.request_ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!requestIds.length) return { ok: false, reason: 'no_request_ids' };
    if (requestIds.length > this.config.maxRequestRows) return { ok: false, reason: 'too_many_request_rows' };
    const requestTable = this.gateway.table('purchaseRequest');
    const raw = [];
    for (const recordId of requestIds) {
      const record = await this.gateway.get('purchaseRequest', recordId).catch(() => null);
      if (record) raw.push(record);
    }
    if (!raw.length) return { ok: false, reason: 'request_rows_unreadable' };
    const rows = [];
    for (const record of raw) {
      const productRecordId = linkedRecordIds(record.fields?.[requestTable.fields.product])[0] || '';
      if (!productRecordId) return { ok: false, reason: 'request_row_without_product' };
      let size = null;
      try {
        size = (await this.getSizeReferences().resolveLinkedCell(record.fields?.[requestTable.fields.size]))?.size ?? null;
      } catch (error) {
        return { ok: false, reason: 'request_row_without_size' };
      }
      if (!Number.isSafeInteger(Number(size)) || Number(size) <= 0) return { ok: false, reason: 'request_row_without_size' };
      const quantity = Number(textValue(record.fields?.[requestTable.fields.quantity]));
      if (!Number.isSafeInteger(quantity) || quantity <= 0) return { ok: false, reason: 'request_row_bad_quantity' };
      rows.push({
        request_record_id: record.record_id,
        product_record_id: productRecordId,
        size: Number(size),
        quantity,
        item_no: '',
        color: '',
      });
    }
    const productTable = this.gateway.table('product');
    const productCache = new Map();
    for (const row of rows) {
      if (!productCache.has(row.product_record_id)) {
        const record = await this.gateway.get('product', row.product_record_id).catch(() => null);
        productCache.set(row.product_record_id, {
          item_no: textValue(record?.fields?.[productTable.fields.itemNo]),
          color: textValue(record?.fields?.[productTable.fields.color]),
        });
      }
      const product = productCache.get(row.product_record_id);
      row.item_no = product.item_no;
      row.color = product.color;
    }
    return {
      ok: true,
      rows,
      requestIds: rows.map((row) => row.request_record_id),
      batchRecordId: this.readBatchRecordId(raw, requestTable),
    };
  }

  /** 「报货批次号」关联：从申请行上读；读不到就返回空串（本次不挂批次关联，但不影响入库）。 */
  readBatchRecordId(rawRequests, requestTable) {
    for (const record of rawRequests) {
      const linked = linkedRecordIds(record.fields?.[requestTable.fields.batchNo])[0];
      if (linked) return linked;
    }
    return '';
  }

  /** 交给模型的原话：超长只截断投喂，本地记录原样保留（配置先行：阈值在 config 里）。 */
  trimTranscript(messages) {
    const joined = messages.join('\n');
    if (joined.length <= this.config.maxTranscriptChars) return messages;
    return [joined.slice(-this.config.maxTranscriptChars)];
  }

  replyTarget(event, task) {
    return event?.context?.open_message_id || event?.open_message_id || task?.card_message_id || '';
  }

  /**
   * 回一句话到那条消息。
   * ⭐ ④ `options.threadId` 非空 = 这条消息在**话题**里 → 让飞书发送适配器带
   * `reply_in_thread` 把它回到**同一个话题**（采购单/图是发群的，后续对话也必须回话题）。
   * 不传 / 为空（主群 @ 进来）时与改动前逐字相同。
   */
  async safeReplyText(messageId, content, options = {}) {
    if (!messageId || !content) return false;
    try {
      await this.replyText(messageId, content, options);
      return true;
    } catch (error) {
      // 回不出去（缺权限、消息被撤回）绝不能把业务判失败：日志留痕，业务事实已经落地。
      logWarn('purchase.arrival.reconcile.reply_failed', { message_id: messageId, error: error.message });
      return false;
    }
  }

  async safeUpdateCard(messageId, card) {
    if (!messageId) return false;
    try {
      const updated = await this.updateCard(messageId, card);
      // ⚠️ 适配器**不抛错但返回假值**也是"没改成"（例如 `client.im.v1.message.patch` 不存在），
      //    一样要留痕 —— 否则排查时只看到"卡片没变"，不知道为什么。
      if (!updated) {
        logWarn('purchase.arrival.reconcile.card_update_failed', {
          message_id: messageId, error: 'updateCard 返回了假值（卡片没改成功）',
        });
      }
      return updated;
    } catch (error) {
      logWarn('purchase.arrival.reconcile.card_update_failed', { message_id: messageId, error: error.message });
      return false;
    }
  }
}

module.exports = { PurchaseArrivalConversationService, taskIdForBatch, TASK_TYPE };
