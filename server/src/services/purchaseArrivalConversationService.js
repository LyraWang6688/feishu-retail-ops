const crypto = require('node:crypto');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
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
 *      已经有一张卡片时她再补充/修正（或换了话题）→ **在当前话题重发一张新卡**，
 *      旧卡**尽力作废**（收掉按钮）—— 见 `retirePreviousCard` 的注释（2026-10-07 晚改）；
 *   ④ 点「是」→ 这是**唯一的入库点**：
 *        「验收原话」写到**「报货批次」那一行** → **逐条加库存**（`inventory.applyPurchase`，
 *        「库存流水」/「实时库存」由它负责）→ 同一行的「确认状态」改成已确认；
 *        ⚠️ 2026-10-07 深夜起**不再写任何入库明细行**（「采购入库」表已被她整表删除），
 *        「到货状态 = 已到货」由本类的 `notifyBatchArrived` 在事后写；
 *   ⑤ 点「否」→ **零业务表写入**，只回一句「好，那先不入库」。
 *
 * ⚠️ 「报货信息」（= 采购申请表；表名沿革：原「采购申请」→「单据信息」→「具体信息」→「报货信息」）**一个字都不动**：
 *   本类里没有任何对 purchaseRequest 的写路径；`confirmArrival` 里原先那一段
 *   回写入库状态的代码已按她的口径删除（见 purchaseWebhookService 的注释 + 测试里的断言）。
 *
 * ⚠️ 不做的事（她没有说，就不替她决定）：
 *   · 不改采购申请、不改报货表、不建货品（申请行本来就挂着已有货品）。
 *
 * ⭐ 「某一行算出来 `实际 = 0 双`」怎么办（业务负责人 **2026-10-07 当面纠正**，逐字：
 *   「**如果这个尺码算下来为 0，那么就不用入库啊！**」）：
 *   · `实际 = 0` 是**到货核实的正常结果**（供应商漏发一整双），**不是错误**；
 *     该行**不入库**（不写任何入库明细、不调 `inventory.applyPurchase`），
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
    markBatchArrived,
    replyText,
    replyCard,
    updateCard,
    getMessageMeta,
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
    // ⭐ 到货核对确认成功之后，把「报货批次」那一行的到货状态改成「已到货」。
    // 注入而不是自己 new：谁维护"报货批次"那一行是**别人的职责**
    //（`PurchaseOrderBatchService`），本类只负责在**正确的时机**叫它一声。
    // ⚠️ 默认空实现 = 什么都不做（单测/别的调用方不关心这条链路时行为与改动前一模一样）。
    // 🔴 它**必须永不抛**：入库事实已经落地，批次状态只是投影。
    this.markBatchArrived = markBatchArrived || (async () => ({ updated: false, reason: 'not_wired' }));
    // 群里的反馈一律**引用回复/回复卡片**（群聊没有"上一次对话"的概念）。
    // ⭐ ④ 两个端口都收第三个参数 `{ threadId }`：非空时由**飞书发送适配器**
    //    带 `reply_in_thread` 把这条反馈回到**那个话题**（本类不认识 reply_in_thread）。
    this.replyText = replyText || (async () => '');
    this.replyCard = replyCard || (async () => '');
    this.updateCard = updateCard || (async () => false);
    // ⭐⭐ 2026-10-07 晚（真机 23:37「日志说卡片已更新，她那边一张卡都没有」）：
    //    **更新一张已经存在的消息之前，先读一眼它到底是什么** ——
    //    `im.v1.message.get` 的 `msg_type` / `deleted` / `thread_id` / `updated`。
    //    为什么非要有这一步：`im.v1.message.patch` 的**唯一成功判据是 `code === 0`**
    //    （官方文档：该接口"仅支持更新卡片（消息类型为 `interactive`）"，
    //     可它的错误码表里**没有**"目标不是卡片"这一条）⇒ 对一条文字 / 图片消息，
    //    patch 完全可能回 `code 0` 却什么都没改，旧代码据此记成 `card_updated`。
    //    ⚠️ 默认"读不到"（`not_wired`）= **不更新**：宁可不做，也不做一件看不见的事。
    //    ⚠️ 它只是**证据与闸门**，**不参与任何业务判据**（读不到也绝不影响入库/发卡）。
    this.getMessageMeta = getMessageMeta || (async () => ({ ok: false, reason: 'not_wired' }));
    // 配置从配置模块取；传进来的（测试/多租户）按**字段**覆盖，不会把没覆盖的项变成 undefined。
    const defaults = resolveArrivalConversationConfig();
    this.config = config
      ? {
        ...defaults,
        ...config,
        card: {
          ...defaults.card,
          ...(config.card || {}),
          // ⚠️ `form`（表单那块：输入框 / 提交按钮 / 降级文案）必须**嵌套合并**：
          //    只浅合并 `card` 的话，调用方覆盖 `card.form.submitLabel` 一项就会把
          //    `fieldName` / `required` / 降级文案…整块变成 undefined（改一项、坏一片）。
          form: { ...defaults.card.form, ...((config.card || {}).form || {}) },
        },
        replies: { ...defaults.replies, ...(config.replies || {}) },
        summary: { ...defaults.summary, ...(config.summary || {}) },
      }
      : defaults;
    this.now = now || (() => Date.now());
    // 同一批的核对串行：同一条话题里两条消息几乎同时到达时，
    // 不能让两边各读到旧 transcript 再互相覆盖（会把她说的话丢掉）。
    this.queue = new KeyedSerialQueue();
  }

  /** 这一批的报货批次号（任务上冻结的那个；没有就空串 —— 空串时不去改任何批次行）。 */
  taskBatchNo(task, draft = {}) {
    return String(task?.batch_no || draft?.batch_no || '').trim();
  }

  /**
   * 叫一声"这一批到货了"，并把所有失败吞成 warn。
   *
   * 🔴 **本方法永不抛**：到这一步「库存流水」+「实时库存」都已经写完了，
   *    批次状态写不回去只是"她那张表上没显示已到货"，绝不能把入库成功判成失败。
   *
   * ⚠️ 方法名与注入依赖名（`this.markBatchArrived`）**必须不同**：
   *    同名的话构造函数里那个实例属性会**静默覆盖**原型方法（AGENTS.md 记过这个坑）。
   */
  async notifyBatchArrived(batchNo, { correlation = {} } = {}) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) {
      logInfo('purchase.arrival.reconcile.batch_arrival_skipped', { reason: 'no_batch_no' });
      return { updated: false, reason: 'no_batch_no' };
    }
    try {
      return await this.markBatchArrived(wanted, { correlation });
    } catch (error) {
      logWarn('purchase.arrival.reconcile.batch_arrival_failed', {
        batch_no: wanted, error: error.message,
        hint: '入库已经成功；只是「报货批次」的到货状态没改成已到货（不影响库存与单据）',
      });
      return { updated: false, reason: 'failed', error: error.message };
    }
  }

  /**
   * 群话题里定位到某一批之后进来（调用方已判定"是哪一批"）。
   *
   * ⭐ 2026-10-07 起：**收到她的到货反馈就直接处理**（算计划 + 出卡片），
   *    不再要求她先说一句"核对完毕"（见 `handleTopicMessageLocked` 里的注释）。
   *
   * @param {{batch?: object, text: string, messageId: string, threadId?: string, senderOpenId?: string}} input
   * @returns {Promise<{handled: boolean, reason?: string, complete?: boolean, card?: boolean, card_message_id?: string}>}
   *   `complete` 是**模型判断她有没有说完**（诊断用），**不是**"有没有处理"。
   *   `card` = 卡片发出去了没有；`card_message_id` = 飞书给的那条卡片消息 id（排查入口）。
   *   ⚠️ 2026-10-07 晚：`card_updated` **已经删掉** —— 出口只剩 `card_sent` 一个
   *   （"更新已有那张"这条路正是真机 23:37「日志说更新了、她什么都看不到」的来源）。
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

  /**
   * 话题那条**锁定管道**：一条"她说的到货反馈"从记原话 → 调模型 → 算计划 → 发卡片，
   * **整条链路只有这一份实现**。
   *
   * ⭐⭐ 2026-10-08（表单提交那条路的关键）：卡片表单提交**也走这个方法**，
   *    只是把 `messageId` 传成**被提交的那张卡片的消息 id**、`text` 传成
   *    `form_value.actual_arrival` 的文字 —— 于是"提交"与"在话题里说同一句"
   *    **喂给模型的原话、算出来的计划、发出去的卡片逐字一致**（用例钉住）。
   *    这就是需求里那句「把 form_value 的文字当作她在话题里说的那句话」的落地，
   *    **没有第二套解析**。
   *
   * @param {string} [callerHandledCardId] ⭐ 调用方**自己会收掉**的那张卡片
   *   （表单提交路径 = 她提交的那张卡：提交成功后由调用方 patch 成「已提交」终态）。
   *   命中它时这里**跳过作废**，免得同一张卡被 patch 两次（一次"已作废"、一次"已提交"）。
   *   ⚠️ **不传时行为与改动前逐字不变**（话题那条路走的就是默认值）。
   */
  async handleTopicMessageLocked({
    taskId, batch, batchNo, text, messageId, threadId, senderOpenId, callerHandledCardId = '',
  }) {
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
    // 这张任务上**已经发出去的那张卡片**（她之前说过一句，卡片在某个话题里等她确认）。
    // ⚠️ 它可能是**另一个话题**里那张、甚至根本不是卡片 ⇒ 只用来**尽力作废**，
    //   **不再**用来当"这一轮要更新哪张"的判据（见下面发卡片那段）。
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

    // ── 发卡片（是 / 否）────────────────────────────────────────────────────
    // ⭐⭐ 2026-10-07 晚（真机 23:37：日志说「卡片已更新」，她那边**一张卡都没有**）：
    //    「有核对内容」的出口**一律是"在她说这句话的那个话题里发一张新卡"**（`card_sent`）。
    //
    //    为什么不再"更新已有那张"（改动前那条路正是真机事故的来源）：
    //      · 卡片 id 记在**批次级**的会话任务上（同一批**含她另开一个话题**永远是同一条记录，
    //        见 `taskIdForBatch`），而"她看不看得见"是**话题级**的 ⇒
    //        更新可能落到**另一个话题**那张卡上：`code = 0` 一切正常，她在本话题里什么都看不到；
    //      · `im.v1.message.patch` 的成功判据**只有 `code === 0`**（官方文档：该接口
    //        "仅支持更新卡片（消息类型为 interactive）"，可错误码表里**没有**
    //        "目标不是卡片"这一条）⇒ 对一条文字/图片消息它完全可能回 0 却什么都没改。
    //    ⇒ **可见性不再依赖"猜她在看哪张卡"**：每次都把卡发到**她刚说的那条消息下面**，
    //      这一步的成功判据是"飞书回了 message_id"（回空 = 发没发出去说不清 = 判失败）。
    //    旧卡由 `retirePreviousCard` **尽力作废**（先读一眼确认它真是卡片、改完再读一眼校验），
    //    作废成功/跳过/失败都记日志 —— 但它**不参与**"卡片发出去没有"这件事。
    const card = purchaseArrivalReconcileCard({
      taskId,
      batchNo,
      rows: plan.rows,
      differences: plan.differences,
      copy: this.config.card,
    });
    let cardMessageId = '';
    try {
      // ⭐ ④ 卡片回到**她说话的那个话题**（`{ threadId }` 一路传到飞书发送适配器，
      //    由它决定用不用 `reply_in_thread`）。主群 @ 进来（threadId 为空）时行为不变。
      cardMessageId = await this.replyCard(messageId, card, { threadId });
    } catch (error) {
      // 卡片发不出去：她再说一句就会重算重发（nothing was written）。
      logWarn('purchase.arrival.reconcile.card_send_failed', { task_id: taskId, error: error.message });
      return { handled: true, complete: Boolean(parsed.complete), card: false, reason: 'card_send_failed' };
    }
    if (!cardMessageId) {
      // `code === 0` 但没回带 message_id = "发没发出去说不清"。**不许**当成发成功
      //（记一个空 id，下一轮会再发一张，可她这一轮可能一张都没看到 —— 那正是这次要消灭的现象）。
      logWarn('purchase.arrival.reconcile.card_send_failed', {
        task_id: taskId, error: 'replyCard 没有回带 message_id（发没发出去无法确认）',
      });
      return { handled: true, complete: Boolean(parsed.complete), card: false, reason: 'card_send_failed' };
    }
    // ⭐ 可验证证据：**读一眼刚发出去的那条消息**（`im.v1.message.get`）——
    //    日志从此能直接回答"卡片到底发出去没有、message_id 是什么、是不是 interactive、
    //    落在哪个话题"。⚠️ 它只是**证据**：读不到（缺权限/网络）也只记 `unavailable`，
    //    绝不因为"读不到"就把发卡判成失败（发送本身已经 `code = 0`）。
    const evidence = await this.cardEvidence(cardMessageId, threadId);
    // 旧卡（若有）**尽力作废**：把按钮收掉，免得话题里同时留着两张都能点的卡。
    // ⚠️ 2026-10-08：`callerHandledCardId` 命中时**跳过** —— 那张卡由**调用方**收成
    //    「已提交」终态（表单提交那条路，见 `handleFormSubmitLocked`）。
    //    否则同一张卡会被 patch 两次（先"已作废"、再"已提交"），白白多一次远端调用。
    const supersede = existingCardMessageId
      && existingCardMessageId === String(callerHandledCardId || '').trim()
      ? { attempted: false, result: 'none', reason: 'handled_by_caller' }
      : await this.retirePreviousCard(existingCardMessageId, {
        taskId, batchNo, newCardMessageId: cardMessageId,
      });
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update(taskId, {
      status: 'awaiting_confirmation',
      plan: plan.rows,
      differences: plan.differences,
      acceptance_text: transcriptTexts.join(this.config.acceptanceTextSeparator),
      request_rows: snapshot.rows,
      request_ids: snapshot.requestIds,
      batch_record_id: snapshot.batchRecordId || task.batch_record_id || '',
      // 记**最新**那张卡；`card_thread_id` = 它长在哪个话题里（排查"她说的话题与卡片所在话题
      // 一不一致"时一眼可见 —— 真机 2026-10-07 23:37 那种事故正是这件事没人看得见）。
      card_message_id: cardMessageId,
      card_thread_id: String(threadId || ''),
      operator_open_id: String(senderOpenId || task.operator_open_id || ''),
      card_sent_at: nowIso,
    });
    logInfo('purchase.arrival.reconcile.card_sent', {
      task_id: taskId, batch_no: batchNo, card_message_id: cardMessageId,
      row_count: plan.rows.length, difference_count: plan.differences.length,
      // 0 双的行数（她 2026-10-07 起的正常情况）：卡片上写了「这双没到」。
      zero_actual_count: zeroRows.length,
      adjustment_total: plan.rows.reduce((sum, row) => sum + (row.actual - row.quantity), 0),
      // ⭐ `complete` 只作**诊断**（模型判断她说完了没有），不再是闸门。
      parse_complete: Boolean(parsed.complete),
      // ⭐ 出口只剩这一个（旧的 `card_updated` 已随这次改动删掉，见方法头注释）。
      card_action: 'sent',
      // ⭐⭐ 可验证四件套：请求的类型 · 读回来的**事实**类型 · 是否被撤回 · 落在哪个话题
      //    （外加"与她这次说话的话题一不一致"）。`card_msg_type_source: 'unavailable'`
      //    = 没读成（缺权限/网络），此时飞书已经回了 message_id，卡片照样是发出去了的。
      card_requested_msg_type: 'interactive',
      card_msg_type: evidence.msgType,
      card_msg_type_source: evidence.source,
      card_msg_type_reason: evidence.reason,
      card_deleted: evidence.deleted,
      card_thread_id: evidence.threadId,
      card_thread_match: evidence.threadMatch,
      thread_id: String(threadId || ''),
      // 旧卡的去向（她换话题 / 补充一句时，上一张卡会被作废）：
      superseded_card_message_id: String(existingCardMessageId || ''),
      supersede_attempted: supersede.attempted,
      supersede_result: supersede.result,
      supersede_reason: supersede.reason,
    });
    // ⭐ 她补充/修正过（或换了话题）→ 回一句，说明**哪张卡才是准的**。
    //    🔴 文案**不许再说"上面那张卡片已经更新"**：新出口是**重发一张**，
    //    说"更新了"会让她去找那张（可能根本不存在的）旧卡 —— 真机 2026-10-07 23:37
    //    那句回话正是这么把她带偏的。文案在配置里（`replies.recalculatedCard`，可置空）。
    if (existingCardMessageId && replies.recalculatedCard) {
      await this.safeReplyText(messageId, replies.recalculatedCard, { threadId });
    }
    return {
      handled: true, complete: Boolean(parsed.complete), card: true,
      card_message_id: cardMessageId, taskId,
    };
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
   * ⭐⭐ 卡片表单的**提交入口**（业务负责人 2026-10-07 深夜定的口径，逐字）：
   *   「等到货之后，**请在卡片里填写实际到货情况**……**用户填写内容之后，再点击提交**。
   *    以这个来作为**触发后续的到货验收**」
   *
   * 分工（这里的职责边界要看清）：
   *   · **本方法只管三件事**：取出 `form_value` 里那一项文字 → 空值兜底 → 丢进同一批的串行队列；
   *   · **真正的"到货验收"一点都没重写**：非空时原样交给 `handleFormSubmitLocked`，
   *     而它转手就把这句话当成"她在话题里说的那句话"喂给 `handleTopicMessageLocked`
   *     ⇒ 解析 / 差异比对 / 出卡片**与在话题里说一模一样**（用例逐字钉住）。
   *
   * 🔴 空提交（`form_value` 里没有那一项 / 只有空白）：**明确提示 + 一个字都不写**
   *   （不记原话、不调模型、不发卡片、不写任何业务表），并把表单与提醒一起留在她那张卡上。
   *   ⚠️ 官方 `required` 只是**前端**闸门（未填则前端提示、不发起回传）⇒ 服务端必须自己兜一层。
   *   ⚠️ **"明确提示"落在卡片上**（`card.submitMissingNote`），不是靠返回的 toast ——
   *      卡片动作那条路由的**同步响应是固定的「已收到，正在处理」**，service 返回的 toast
   *      只进 `lark.card.handled` 日志（这也是 `visibleFailure` 早就"patch 卡 + 回文字"的原因）。
   *
   * @param {object} value 提交按钮的 `value`（`{action, draft_id}`）
   * @param {object} formValue 回调里的 `form_value`（官方：表单项 name → 值）
   * @param {object} event 整个卡片回调事件（取被提交的那张卡 id、操作人）
   * @param {string} operatorOpenId 操作人 open_id
   * @returns {Promise<{toast?: object}>}
   */
  async handleCardFormSubmit(value, formValue, event = {}, operatorOpenId = '') {
    const taskId = String(value?.draft_id || '').trim();
    if (!taskId) throw new Error('到货核对卡片缺少任务 ID');
    const fieldName = this.config.card.form.fieldName;
    const raw = formValue && typeof formValue === 'object' ? formValue[fieldName] : undefined;
    // ⚠️ 只在**两端**去空白（`trim`）：她填的正文原样保留（多行里的换行也保留）。
    const text = String(raw ?? '').trim();
    const cardMessageId = String(event?.context?.open_message_id || event?.open_message_id || '').trim();
    if (!this.config.enabled) {
      // 与"在话题里说"**同一个开关**（`PURCHASE_ARRIVAL_CONVERSATION_ENABLED`）：
      // 关掉就是整条到货核对不处理。⚠️ 卡片动作必须回一个响应，所以如实回一句。
      logInfo('purchase.arrival.reconcile.disabled', {
        message_id: cardMessageId, env: 'PURCHASE_ARRIVAL_CONVERSATION_ENABLED', source: 'form_submit',
      });
      return { toast: { type: 'info', content: this.config.replies.disabled } };
    }
    if (!text) {
      logWarn('purchase.arrival.reconcile.submit_empty', {
        task_id: taskId, card_message_id: cardMessageId, field: fieldName,
        note: '空提交：明确提示 + 不记原话 / 不调模型 / 不发卡片 / 不写任何业务表',
      });
      // ⚠️ 也走**同一批的串行队列**：这是一次"重渲染那张卡"的远端动作，
      //    跟同一批正在跑的核对排在一起，才不会把刚发出去的新卡又叠上旧表单。
      //    ⚠️ 它**不写任何业务表、不动本地任务**（`reopenFormAfterEmptySubmit` 只 patch 卡片）。
      return this.queue.run(taskId, async () => {
        await this.reopenFormAfterEmptySubmit(taskId, cardMessageId);
        // ⚠️ 这句 toast 在她那边**看不见**（卡片动作路由的同步响应固定是「已收到，正在处理」，
        //    见 `routes/larkEvents.js` 的 `card.action.trigger`；service 返回的 toast 只进
        //    `lark.card.handled` 日志）。所以**她真正看得见的那句提示在卡片上**
        //    （`card.submitMissingNote`，由 `reopenFormAfterEmptySubmit` 写进卡片）。
        //    这里照样如实返回，是为了日志口径与既有各条链路的形状一致。
        return { toast: { type: 'error', content: this.config.replies.submitMissing } };
      });
    }
    logInfo('purchase.arrival.reconcile.submit_received', {
      task_id: taskId, card_message_id: cardMessageId, field: fieldName,
      text_length: text.length, operator_open_id: operatorOpenId || '',
    });
    return this.queue.run(taskId, () => this.handleFormSubmitLocked({
      taskId, text, cardMessageId, event, operatorOpenId,
    }));
  }

  /**
   * 提交（非空）在**队列里**的执行体：把这句话**原样**喂给话题那条锁定管道。
   *
   * 三个出口都对得上她的口径：
   *   · 任务丢了 → 走既有 `visibleFailure`（patch 她那张卡 + 回一句）；
   *   · 已经入库过 → 不重复入库、如实回执（与"在话题里又说了一句"同一句 `afterPosted`）；
   *   · 其余 → `handleTopicMessageLocked`（**唯一**那条解析/出卡实现）。
   *     真的算出结果并出了新卡 ⇒ **顺手把她提交的那张卡收成「已提交」终态**
   *     （表单收掉 ⇒ 点不了第二次，这正是"避免重复提交"）。
   *     ⚠️ 没算出结果时**不 patch**：没有到货内容 / 解析失败 / 对不上明细 —— 卡片保持可编辑，
   *        她可以改一句再提交（或照旧在话题里说）。把没算成说成"已提交"就是谎报。
   */
  async handleFormSubmitLocked({ taskId, text, cardMessageId, event, operatorOpenId }) {
    const { replies } = this.config;
    const task = await this.store.get(taskId);
    if (!task) {
      logWarn('purchase.arrival.reconcile.submit_task_missing', { task_id: taskId, card_message_id: cardMessageId });
      return this.visibleFailure({
        tier: 'task_missing', taskId, operator: operatorOpenId, event, task,
        copy: replies.taskMissing, logEvent: 'purchase.arrival.reconcile.submit_task_missing',
      });
    }
    if (task.status === 'posted') {
      // 已经入过库：**一个字都不写**，如实告诉她（与话题那条路同一句话、同一个判据）。
      logInfo('purchase.arrival.reconcile.submit_after_posted', {
        task_id: taskId, card_message_id: cardMessageId, operator_open_id: operatorOpenId || '',
      });
      await this.safeReplyText(cardMessageId, replies.afterPosted, this.threadOptions(task));
      return { toast: { type: 'info', content: replies.afterPosted }, handled: true, reason: 'already_posted' };
    }
    const result = await this.handleTopicMessageLocked({
      taskId,
      // ⭐ "是哪一批"从**本地会话任务**上还原（提交没有定位器给的 batch 对象）。
      batch: this.batchFromTask(task),
      batchNo: String(task.batch_no || ''),
      // ⭐ 她填的那段文字 = "她在话题里说的那句话"。逐字一致就靠这一行。
      text,
      // ⭐ 身份用**被提交的那张卡片**的消息 id：飞书重投同一次提交时，
      //    管道里那道"同一条消息只记一次"的闸门会把它挡成 `duplicate_message`（幂等）。
      messageId: cardMessageId || `form_submit:${taskId}`,
      // 她是在**话题**里收到这张卡的 ⇒ 回话/新卡都落回**同一条话题**。
      threadId: String(task.thread_id || ''),
      senderOpenId: operatorOpenId,
      // 这张卡由**下面**收成「已提交」终态，管道别再拿它当"旧卡"作废一遍。
      callerHandledCardId: cardMessageId,
    });
    if (result.reason === 'duplicate_message') {
      // 飞书重投 / 她连点两次提交：不重复核对、不重复发卡、不重复入库。
      logInfo('purchase.arrival.reconcile.submit_duplicate', { task_id: taskId, card_message_id: cardMessageId });
      return { toast: { type: 'info', content: replies.submitDuplicate }, ...result };
    }
    logInfo('purchase.arrival.reconcile.form_submitted', {
      task_id: taskId, card_message_id: cardMessageId,
      outcome: result.reason || 'processed', card: Boolean(result.card),
      text_length: String(text || '').length,
    });
    if (result.card === true) {
      const patched = await this.safeUpdateCard(cardMessageId, purchaseArrivalReconcileStatusCard({
        batchNo: task.batch_no || '',
        message: this.config.card.submittedMessage,
        template: 'grey',
        title: this.config.card.submittedTitle,
      }), { task, taskId });
      logInfo('purchase.arrival.reconcile.submit_card_closed', {
        task_id: taskId, card_message_id: cardMessageId, card_patched: patched,
        note: '提交成功那一次的结果卡在话题里；她提交的这张收成「已提交」终态，避免重复提交',
      });
    }
    // ⚠️ 出口形状：`toast` 给卡片点击方看（路由只读它），
    //    其余字段（`card` / `reason` / `card_message_id`）是**排查与用例**要的证据，原样带出去。
    // ⚠️ 回执**分两句**：真的出了新卡才说"卡片发在你下面"；没算出结果时如实说
    //    （说错方向会让她去找一张根本不存在的卡 —— 真机 2026-10-07 23:37 就是这么被带偏的）。
    const toastCopy = result.card === true ? replies.submitReceived : replies.submitReceivedNoCard;
    return { toast: { type: 'info', content: toastCopy }, ...result };
  }

  /**
   * 从**本地会话任务**上还原"是哪一批"（表单提交路径没有定位器给的 batch 对象）。
   *
   * ⚠️ 只还原任务上**真的记着**的东西：
   *   · `request_ids` 优先取任务上的（发卡那一轮 `loadRequestRows` 存的）；
   *     没有才回落到 `request_rows[].request_record_id`；
   *   · **两个都没有就返回空数组** ⇒ `loadRequestRows` 照旧 `no_request_ids`
   *     （**不发卡、不写表**）—— **绝不猜"最近一笔"**（AGENTS.md 那条纪律）。
   */
  batchFromTask(task) {
    const rows = Array.isArray(task?.request_rows) ? task.request_rows : [];
    const stored = Array.isArray(task?.request_ids) && task.request_ids.length
      ? task.request_ids
      : rows.map((row) => row.request_record_id);
    return {
      batch_no: textValue(task?.batch_no),
      batch_record_id: textValue(task?.batch_record_id),
      chat_id: textValue(task?.chat_id),
      // 到货核对只对采购申请单开（退货批次在入口就被挡掉了，见 `handleTopicMessage`）。
      batch_kind: ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
      request_ids: [...new Set(stored.map((id) => String(id || '').trim()).filter(Boolean))],
    };
  }

  /**
   * 空提交之后**尽力**把表单留在她那张卡上（外加一句"没收到内容"的提醒）。
   *
   * 🔴 它**不写任何业务表、不动本地任务**，只是重新渲染一张卡 —— 所以"零写库"这条不变。
   * ⚠️ 任务上没有算好的计划（还没有行）就不重渲染：**宁可不做，也不渲染一张空卡**。
   */
  async reopenFormAfterEmptySubmit(taskId, cardMessageId) {
    if (!cardMessageId) return false;
    let task = null;
    try {
      task = await this.store.get(taskId);
    } catch (error) {
      logWarn('purchase.arrival.reconcile.submit_empty_reopen_skipped', {
        task_id: taskId, card_message_id: cardMessageId, reason: 'task_unreadable', error: error.message,
      });
      return false;
    }
    if (!task || !Array.isArray(task.plan) || !task.plan.length) {
      logInfo('purchase.arrival.reconcile.submit_empty_reopen_skipped', {
        task_id: taskId, card_message_id: cardMessageId, reason: task ? 'no_plan' : 'task_missing',
      });
      return false;
    }
    const reopened = await this.safeUpdateCard(cardMessageId, purchaseArrivalReconcileCard({
      taskId, batchNo: task.batch_no || '', rows: task.plan, differences: task.differences || [],
      copy: this.config.card, formNote: this.config.card.submitMissingNote,
    }), { task, taskId });
    logInfo('purchase.arrival.reconcile.submit_empty_reopened', {
      task_id: taskId, card_message_id: cardMessageId, card_patched: reopened,
    });
    return reopened;
  }

  /**
   * 点「否」：**零业务表写入**，把那张卡 patch 成终态，再回一句「好，那先不入库」。
   *
   * ⭐ 2026-10-08（业务负责人逐条批准）：**点「否」也 patch 卡面**。
   *   改前这里只 `safeReplyText`（卡片原样不动）—— 这正是"点了没反应"的同一个根因：
   *   她点完只看得到一句话，那张卡上还是「是 / 否」两个按钮。
   *   ⚠️ **有意接受的行为变化**：终态卡收掉按钮 ⇒ 点过「否」之后在**这张卡上**点不了「是」了；
   *      要改主意，在话题里再说一句实际到货（会按最新那句话重出一张新卡）。
   *      `confirmLocked` 里那条"rejected 之后仍可按显式指令入库"的服务端语义**一个字没改**
   *      （飞书重投 / 旧卡回调照样能走通，只是卡面上不再给按钮）。
   *
   * ⚠️ 顺序：**patch 在前、回话在后**（她要的是"原地更新卡片"，回话只是兜底）。
   *   回话复用既有的 `replies.rejected`，**不重复发第二句**。
   *
   * 刻意**不把状态定成终态**：她没说过"否完就不能改主意"。
   * 点了「否」之后再点「是」，仍然按"她的显式指令"入库（那时候入库点还是「是」）。
   */
  async rejectLocked(taskId, operatorOpenId, event = {}) {
    const task = await this.store.get(taskId);
    if (!task) {
      return this.visibleFailure({
        tier: 'task_missing', taskId, operator: operatorOpenId, event, task,
        copy: this.config.replies.taskMissing, logEvent: 'purchase.arrival.reconcile.task_missing',
      });
    }
    if (task.status === 'posted') {
      // 已经入库了再点「否」：**不重复入库、也不改状态**，把那张卡**如实改成绿色终态**
      // （以前这里只弹 toast，她再点一次还是"看不见任何变化"）。
      // ⚠️ 卡片**不改内容方向**：已入库就是已入库，不因为她又点了个「否」而改成别的。
      return this.visibleAlreadyPosted({
        tier: 'reject_after_posted', taskId, operator: operatorOpenId, event, task,
      });
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
    // ① patch 卡面（终态、收掉按钮）—— 她点的地方**看得见**。
    const cardPatched = await this.safeUpdateCard(cardMessageId, purchaseArrivalReconcileStatusCard({
      batchNo: task.batch_no || '',
      message: this.config.replies.rejected,
      template: 'grey',
      title: this.config.card.rejectedTitle,
    }), { task, taskId });
    logInfo('purchase.arrival.reconcile.reject_notice', {
      task_id: taskId, card_message_id: cardMessageId, card_patched: cardPatched,
      note: '点「否」= 零业务表写入，但卡面必须原地变（改前只回一句、卡片不动）',
    });
    // ② 兜底回话：复用既有的 `replies.rejected` —— 只发这一句，不重复。
    await this.safeReplyText(cardMessageId, this.config.replies.rejected, this.threadOptions(task));
    return { toast: { type: 'info', content: this.config.replies.rejected } };
  }

  /**
   * 点「是」：**这才是入库点**。
   *
   * 顺序（不能换）：
   *   ① 把草稿写进任务（`draft.actual` 是按实际调整完的数量、`draft.requests` 是申请行）；
   *   ② `confirmArrival` → **「验收原话」写到「报货批次」那一行** → **逐条 `inventory.applyPurchase`**
   *      （「库存流水」+「实时库存」由它负责，这里不另写一套）
   *      → 批次行的「确认状态」改成已确认。
   *
   * ⭐ 2026-10-07 晚（到货落点大改）：这里**不再建「到货验收」那一行**（表已被业务负责人删除）。
   *    「验收原话」「确认状态」由 `confirmArrival` 写进**「报货批次」那一行**；
   *    本类因此**不再写任何业务表**（批次行的维护归 `PurchaseOrderBatchService`）。
   * ⭐⭐ 2026-10-07 深夜：「采购入库」表也被她**整表删除** ⇒ `confirmArrival` 里
   *    **不再写任何入库明细行**，只更新批次行 + 逐条加库存（口径逐字见那份方法的注释）。
   *
   * 幂等：`task.status === 'posted'` 早退；
   * 更里面的「加库存 / 批次行」幂等由 `confirmArrival` 自己保证
   *（`draft.inventory_applied` 落盘 ＋ 库存自己按真实来源标识去重 ＋ 串行队列；
   *  「验收原话」写的是同一个文本值）。
   */
  async confirmLocked(taskId, operatorOpenId, event = {}) {
    const { replies } = this.config;
    const task = await this.store.get(taskId);
    if (!task) {
      // ⭐ 2026-10-07：以前这里**只弹 toast**，她在话题里看不见任何东西 → 现在 patch 卡片 + 回文字。
      return this.visibleFailure({
        tier: 'task_missing', taskId, operator: operatorOpenId, event, task,
        copy: replies.taskMissing, logEvent: 'purchase.arrival.reconcile.task_missing',
      });
    }
    if (task.status === 'posted') {
      // 重复点「是」（双击 / 飞书重投）：**不重复入库**，如实回执。
      // ⭐ 2026-10-07：顺手把那张卡**再 patch 一次成绿色终态** —— 正常路径上它已经是终态，
      //    这一次是幂等的重试；万一上一次 patch 没改成，她这一次点击就能看见结果。
      logInfo('purchase.arrival.reconcile.confirm_duplicate', { task_id: taskId, operator_open_id: operatorOpenId || '' });
      return this.visibleAlreadyPosted({
        tier: 'confirm_duplicate', taskId, operator: operatorOpenId, event, task,
      });
    }
    if (!Array.isArray(task.plan) || !task.plan.length || !task.acceptance_text
      || !task.request_ids?.length || !task.request_rows?.length) {
      // 她说的话我们还没算出结果 → 同样不能只弹 toast（那是"点了没反应"的另一种样子）。
      return this.visibleFailure({
        tier: 'not_confirmed_yet', taskId, operator: operatorOpenId, event, task,
        copy: replies.notConfirmedYet, logEvent: 'purchase.arrival.reconcile.not_confirmed_yet',
        toastType: 'info',
      });
    }
    // ⭐ 2026-10-07 晚：这里原先会**新建「到货验收」一行**并落盘 `arrival_record_id`。
    //    那张表已被业务负责人删除，落点改到「报货批次」那一行 ⇒ 这一步整段删除：
    //      · 批次记录 id 本来就在任务上（`task.batch_record_id`，发图时从采购申请行读到的，
    //        见 `loadRequestRows` / `readBatchRecordId`）——不需要第二个 id 来定位那一行；
    //      · 拿不到它时，`confirmArrival` 里的 `writeAcceptance` 会按**批次号**回查，
    //        所以这里不再有"先建行再记住 id"的幂等窗口。
    const requests = [];
    for (const requestId of task.request_ids) {
      const record = await this.gateway.get('purchaseRequest', requestId).catch(() => null);
      if (record) requests.push(record);
    }
    // ⚠️ 这里的形状就是 confirmArrival 一直在等的草稿形状：
    //    actual = 按实际调整完的明细（每行一条 货品+尺码+实际双数）
    //    requests = 申请行原样（⚠️ 2026-10-07 深夜起**不再**用来挂「采购入库」的「采购申请」——
    //              那张表已被整表删除；仍然照传，因为到货核对卡片/建档还要用它的形状）
    //    pending_creation 空数组：到货的货品在建采购申请时就已经存在了，这里不建新品。
    // ⭐ 2026-10-07：`实际 = 0 双` 的行**到这里就被摘掉**，一张表都不写 ——
    //    不写任何入库明细、不调 inventory.applyPurchase（库存流水/实时库存都不动）。
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
      // ⭐ 到货信息的落点（2026-10-07 晚）：**报货批次的那一行**。
      //    `batch_record_id` 是发图时从采购申请行的「报货批次号」关联上读到的（可能为空——
      //    空时 `confirmArrival.writeAcceptance` 会按 `batch_no` 回查）。
      batch_record_id: String(task.batch_record_id || '').trim(),
      batch_no: task.batch_no || '',
      // 「验收原话」随草稿传给 confirmArrival —— 由它写进批次行（本类不写业务表）。
      acceptance_text: String(task.acceptance_text || ''),
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
      // ⚠️ 错误原文**一个字都不吞**：日志（下面 `logError` 的 `error`）与**她要看到的那句话**
      //    （`{error}` 插值）里都带着它。返回的 toast 仍然是 `error`（不许把失败写成成功）。
      logError('purchase.arrival.reconcile.confirm_failed', { task_id: taskId, error: error.message });
      // ⭐ 2026-10-07：失败**必须在她点的那张卡片上看得见**（以前只有一行不带 `threadId` 的回话，
      //    她连着两次反馈「卡片点击后没有任何反应」）。
      return this.visibleFailure({
        tier: 'inbound_failed', taskId, operator: operatorOpenId, event, task, error,
        copy: formatCopy(this.config.replies.inboundFailed, { error: error.message }),
        logEvent: 'purchase.arrival.reconcile.confirm_failed',
      });
    }
    await this.store.update(taskId, { status: 'posted', posted_at: new Date(this.now()).toISOString() });
    // ⭐ 到货事实落地之后 → 把「报货批次」那一行的到货状态改成「已到货」
    //（业务负责人 2026-10-07：「**当用户在话题群里说了到货之后，状态应该改成「已到货」**」）。
    // ⚠️ 位置**必须在入库之后**：入库是事实，批次状态是它的投影 —— 反过来的话，
    //    写状态成功、入库失败，她会看到"已到货"而库存里没有这批货。
    // ⚠️ 它是**增强**：失败只记 warn，**绝不**把已经入库成功的一单判成失败
    //    （与"附件写回失败不阻塞主流程"同一条纪律）。
    await this.notifyBatchArrived(this.taskBatchNo(task, draft), { correlation: { task_id: taskId } });
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
    // 明确反馈：**先把卡片改成终态，再在群里回一句结果**（业务负责人 2026-10-08：
    // 她要的是"原地更新卡片"，回话只是兜底 ⇒ 顺序 patch 在前、回话在后）。
    // 发不出去只记日志，业务事实已经落地。
    // ⚠️ 2026-10-07：回话补 `threadId` —— 她是在**群话题**里操作的，回复必须落回那条话题
    //    （少了它就发到主群洪流里，她一样"看不到"）。
    const cardMessageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id || '';
    const cardPatched = await this.safeUpdateCard(
      cardMessageId,
      purchaseArrivalReconcileStatusCard({ batchNo: task.batch_no || '', message: summary, template: 'green' }),
      // 下面紧接着就回这句结果（同一句话），所以这里不再叠一句"卡片没刷新成功"。
      { task, taskId, replyOnFailure: false },
    );
    await this.safeReplyText(this.replyTarget(event, task), summary, this.threadOptions(task));
    // ⭐ 正向证据：成功之后**卡片到底改没改成**也留痕（改不动时她那边的现象就是"点了没反应"）。
    logInfo('purchase.arrival.reconcile.success_notice', {
      task_id: taskId, card_message_id: cardMessageId, card_patched: cardPatched,
    });
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
      task_id: taskId, batch_no: task.batch_no || '',
      // ⭐ 2026-10-07 晚：键从 `arrival_record_id`（「到货验收」那条记录）换成
      //    `batch_record_id`（到货信息现在的落点 = 「报货批次」那一行）。
      batch_record_id: draft.batch_record_id || '',
      // row_count = 这次核对**一共几行**（含没到的），posting 的口径看下面两个字段。
      row_count: task.plan.length,
      posted_row_count: draft.actual.length,
      skipped_zero_count: zeroRows.length,
      skipped_zero_rows: zeroRows.map(rowLabel),
      total_quantity: total,
      // 「报货信息」（采购申请表）在这条链路上**一个字都没写**——这是断言钉住的口径。
      purchase_request_writes: 0,
      // ⭐ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ 这次确认**没有**任何入库明细行；
      //    库存照加，写的就是上面 summary 里那个实际数。
      inbound_rows_written: 0,
    });
    // ⚠️ 只回自己的 toast：`confirmArrival` 返回的 toast 是"给卡片点的人看的一句话"，
    //    和这里这句"按实际到货入库"是两回事，展开到前面会把它盖掉（踩过一次）。
    return { toast: { type: 'success', content: summary } };
  }

  // ── 已删除（2026-10-07 晚）：`createArrivalRecord` / `findExistingArrival` ──────────
  //
  // 两个方法都在往**已被业务负责人删除的**「到货验收」表里建行 / 回查：
  //   · `createArrivalRecord`：写「报货批次号」+「验收原话」+「验收人」，并做
  //     "同批次 + 同原话先回查再创建"的幂等；
  //   · `findExistingArrival`：上面那个回查。
  // 落点搬到「报货批次」那一行之后：
  //   · 落点是**更新**已有的那一行，不是新建 ⇒ 不再有"重复建行"这回事，
  //     幂等也由"写同一个值"天然保证（`PurchaseOrderBatchService.writeAcceptance`）；
  //   · 「验收人」在真表上是**创建人**（自动字段）⇒ 代码不写（原来那次
  //     `UserFieldConvFail` 退一步重试的补丁随之删除，连同 `person` / `relation` 依赖）；
  //   · 批次行的维护归 `PurchaseOrderBatchService`（本类一个业务表都不写）。

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
   * 回复这条消息时要带的话题上下文。
   *
   * ⭐ 2026-10-07（她第二次说「卡片点击后没有任何反应」）：**卡片点击没有 `thread_id`**，
   *    但对话任务上记着它是从哪个话题起的（`task.thread_id`，见 handleTopicMessageLocked）。
   *    把它交给飞书发送适配器 → 带 `reply_in_thread` → 回复落回**她正在看的那个话题**。
   *    任务上没有话题（主群 @ 进来的）→ 空对象，行为与改动前逐字相同。
   */
  threadOptions(task) {
    const threadId = textValue(task?.thread_id);
    return threadId ? { threadId } : {};
  }

  /**
   * 🔴 **失败的可见反馈**（业务负责人 2026-10-07 连着两次：「卡片点击后也是没有任何反应」）。
   *
   * 以前失败的出口是「一行日志 + 一句不带 `threadId` 的回话 + 一个一闪而过的 toast」，
   * 卡片**原样不动** ⇒ 她的结论就是"点了没反应"。现在两条腿一起走：
   *   ① **把那张卡片 patch 成终态**（红色，标题 `card.failedTitle`）—— 就在她点的地方，跑不掉；
   *   ② **回一句同样的话**（带 `threadId`，落回本话题）—— 卡片改不动时的兜底。
   * 两者都失败也不隐藏：各记一条 `*_failed` 警告 + 下面这条 `failure_notice` 里如实写
   * `card_patched` / `replied`，排查时能直接看出"她到底看没看到"。
   *
   * ⚠️ 这里**只负责"让她看见"**：错误原文原样带上（调用方用 `{error}` 插值），
   *    **绝不**吞掉、**绝不**把失败说成成功；返回的 toast 仍是 `error`（除非调用方显式指定
   *    为非错误的 `toastType`，例如"还没算出结果"）。
   */
  async visibleFailure({
    tier, taskId, operator = '', event = {}, task = null, copy,
    logEvent = '', error = null, toastType = 'error', template = 'red',
  } = {}) {
    // "还没算出结果"不是错误，只是要她再说一句：卡片用橙色，别把中性状态说成失败。
    const headerTemplate = tier === 'not_confirmed_yet' ? 'orange' : template;
    const messageId = this.replyTarget(event, task);
    const cardPatched = await this.safeUpdateCard(messageId, purchaseArrivalReconcileStatusCard({
      batchNo: task?.batch_no || '',
      message: copy,
      template: headerTemplate,
      title: this.config.card.failedTitle,
      // ⚠️ 下面紧接着就用**同一句**回话（失败本来就要回到话题里）⇒ 这里不再叠一句
      //    "卡片没刷新成功"，免得她一次点击收到两句。
    }), { task, taskId, replyOnFailure: false });
    const replied = await this.safeReplyText(messageId, copy, this.threadOptions(task));
    // ⭐ 正向证据：她"应该看到"的东西与"实际发出去"的东西都写下来。
    //    ⚠️ 与调用方那条 error 级日志（如 `purchase.arrival.reconcile.confirm_failed`）**并存**，
    //    不是替换 —— 错误原文仍然在 error 日志里。
    logInfo('purchase.arrival.reconcile.failure_notice', {
      tier,
      task_id: taskId,
      operator_open_id: operator || '',
      card_message_id: messageId,
      card_patched: cardPatched,
      replied,
      log_event: logEvent,
      error: error ? error.message : '',
      // 业务事实：失败**不写**入库、状态停在可重试的位置（由调用方保证）。
      tables_written: 0,
    });
    return { toast: { type: toastType, content: copy } };
  }

  /**
   * 「这一批已经入过库了」的可见终态（重复点「是」/ 已入库之后又点「否」）。
   *
   * 与 `visibleFailure` 的区别：这不是失败，卡片用**绿色**；也**不回文字**
   *（她只是重复点了一次，不必再刷一条消息），只把卡片**幂等地**再改成终态 ——
   * 上一次 patch 万一没成功，这一次点击就能看见。
   */
  async visibleAlreadyPosted({ tier, taskId, operator = '', event = {}, task = null } = {}) {
    const copy = this.config.replies.alreadyPosted;
    const messageId = this.replyTarget(event, task);
    const cardPatched = await this.safeUpdateCard(messageId, purchaseArrivalReconcileStatusCard({
      batchNo: task?.batch_no || '',
      message: copy,
      template: 'green',
    }), { task, taskId });
    logInfo('purchase.arrival.reconcile.success_notice', {
      tier, task_id: taskId, operator_open_id: operator || '',
      card_message_id: messageId, card_patched: cardPatched, replied: false,
    });
    return { toast: { type: 'info', content: copy } };
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

  /**
   * 读一眼**一条已经存在的消息**到底是什么（只读，`im.v1.message.get`）。
   *
   * 🔴 这个方法的唯一职责是回答"我能不能安全地 patch 它"：
   *   `im.v1.message.patch` 官方文档写着"**仅支持更新卡片（消息类型为 `interactive`）**"，
   *   可错误码表里**没有**"目标不是卡片"这一条（只有 230001 参数错 / 230011 已撤回 /
   *   230031 超 14 天 / 230110 已删除 / 230027 无权限…）⇒ 对一条文字消息它可能回
   *   `code 0` 却什么都没改。**判据必须落在"读一次事实"上，不能靠猜。**
   *
   * ⚠️ **本方法永不抛**：读不到（缺权限 / 网络 / 没接线）一律返 `{ ok: false, reason }`，
   *    由调用方决定"拿不准就不动手"。
   *
   * @returns {Promise<{ok: boolean, reason?: string, error?: string,
   *   msgType?: string, deleted?: boolean, updated?: boolean, threadId?: string}>}
   */
  async readMessageMeta(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return { ok: false, reason: 'no_message_id' };
    try {
      const meta = await this.getMessageMeta(id);
      if (!meta || meta.ok === false) {
        return { ok: false, reason: (meta && meta.reason) || 'unavailable', error: (meta && meta.error) || '' };
      }
      return {
        ok: true,
        msgType: String(meta.msgType || ''),
        deleted: Boolean(meta.deleted),
        // ⚠️ `updated` 只作**证据**（刚 patch 完能不能立刻读到它变 true 没在真机验过），
        //    不作任何业务判据 —— 见 `docs/arrival-card-visibility-2026-10-07.md` 第 10 节。
        updated: meta.updated === true,
        threadId: String(meta.threadId || ''),
      };
    } catch (error) {
      return { ok: false, reason: 'call_failed', error: error.message };
    }
  }

  /**
   * ⭐ **刚发出去的那张卡片**的客观证据（只读一次 `im.v1.message.get`）。
   *
   * 要回答的就是她那句「话题里根本没有卡片」：日志里从此有
   * `card_message_id`（发的是哪条）· `card_msg_type`（**读回来的事实**是不是 `interactive`）·
   * `card_deleted`（有没有被撤回）· `card_thread_id` / `card_thread_match`
   *（卡片落的话题 = 她这次说话的话题吗 —— 真机那次事故一眼就能看出来）。
   *
   * ⚠️ 读不到也**不判失败**：飞书已经回了 `message_id`（`code = 0`），卡片就是发出去了的；
   *    这里只如实记 `card_msg_type_source: 'unavailable'` + 原因，**不猜**。
   */
  async cardEvidence(cardMessageId, threadId) {
    const meta = await this.readMessageMeta(cardMessageId);
    if (!meta.ok) {
      return {
        msgType: '', source: 'unavailable', reason: meta.reason,
        deleted: null, threadId: '', threadMatch: null,
      };
    }
    const wanted = String(threadId || '');
    return {
      msgType: meta.msgType,
      source: 'message_get',
      reason: '',
      deleted: meta.deleted,
      threadId: meta.threadId,
      // `false` = 卡片落到了**别的话题**；`null` = 有一边没给到话题 id（判不了，不猜）。
      threadMatch: wanted && meta.threadId ? meta.threadId === wanted : null,
    };
  }

  /**
   * 把**上一张核对卡片**尽力作废（按钮收掉、写明"用最新那张"）。
   *
   * ⭐⭐ 为什么必须先读一眼再动它（2026-10-07 真机事故的正面答案）：
   *   改前是**无条件** patch `task.card_message_id` 指向的那条消息 —— 它可能
   *   ① 是一条**文字/图片消息**（patch 回 `code 0` 却什么都没改，日志却记成 `card_updated`）；
   *   ② 是**另一个话题**里那张卡（她那边照样什么都看不到）。
   *   ⇒ 这里三道闸门：**先读一眼确认 `msg_type === 'interactive'` 且未被撤回** →
   *     patch → **再读一眼校验**（`updated`）。读不到就**不动手**（宁可不做）。
   *
   * ⚠️ 它**永远不参与**"卡片发出去没有"这件事：新卡在这之前就已经发出去了
   *   （见 `handleTopicMessageLocked` 的发卡那一段）⇒ 作废失败只是"话题里多留一张旧卡"，
   *   记 `card_supersede_failed` 即可，**绝不影响**她这一轮的交付物。
   *
   * @returns {Promise<{attempted: boolean, result: 'ok'|'skipped'|'failed'|'none', reason?: string}>}
   */
  async retirePreviousCard(previousCardMessageId, { taskId = '', batchNo = '', newCardMessageId = '' } = {}) {
    const id = String(previousCardMessageId || '').trim();
    if (!id) return { attempted: false, result: 'none', reason: 'no_previous_card' };
    if (id === String(newCardMessageId || '').trim()) {
      return { attempted: false, result: 'none', reason: 'same_message' };
    }
    // ① 闸门：只在目标**确实是卡片**时才动手。
    const meta = await this.readMessageMeta(id);
    if (!meta.ok) {
      logWarn('purchase.arrival.reconcile.card_supersede_skipped', {
        task_id: taskId, card_message_id: id, reason: meta.reason, error: meta.error || '',
        note: '读不到那条消息是什么（缺权限/网络）⇒ 拿不准就不动它；新卡已经发出去了',
      });
      return { attempted: false, result: 'skipped', reason: meta.reason };
    }
    if (meta.msgType !== 'interactive') {
      // 🔴 **真机 2026-10-07 23:37 的根因就在这一行**：那条消息根本不是卡片，
      //    旧代码却对它 patch、还记成 `card_updated` ⇒ 她那边自然什么都看不到。
      //    现在：一个字都不改它，把**它真实的类型**写进日志（这就是排查要靠的那条证据）。
      logWarn('purchase.arrival.reconcile.card_supersede_skipped', {
        task_id: taskId, card_message_id: id, reason: 'target_not_interactive',
        target_msg_type: meta.msgType, target_thread_id: meta.threadId || '',
        note: '目标不是卡片（patch 对非卡片可能回 code 0 却什么都不改）⇒ 不 patch 它；新卡已经发出去了',
      });
      return { attempted: false, result: 'skipped', reason: 'target_not_interactive' };
    }
    if (meta.deleted) {
      logWarn('purchase.arrival.reconcile.card_supersede_skipped', {
        task_id: taskId, card_message_id: id, reason: 'target_deleted',
        note: '那张卡已经被撤回 ⇒ 没什么可改的；新卡已经发出去了',
      });
      return { attempted: false, result: 'skipped', reason: 'target_deleted' };
    }
    // ② 动手：把它改成"已作废"的终态（按钮收掉、指向最新那张）。
    // ⚠️ `replyOnFailure: false`：这里的失败**不该**往话题里插一句"卡片没刷新成功" ——
    //    新卡已经发出去了、她看到的那张是好的；真正的失败证据是下面的 `card_supersede_failed`。
    const updated = await this.safeUpdateCard(id, purchaseArrivalReconcileStatusCard({
      batchNo,
      message: this.config.card.supersededMessage,
      template: 'grey',
      title: this.config.card.supersededTitle,
    }), { taskId, replyOnFailure: false });
    if (!updated) {
      logWarn('purchase.arrival.reconcile.card_supersede_failed', {
        task_id: taskId, card_message_id: id, new_card_message_id: newCardMessageId,
        note: '旧卡没改成终态：话题里可能同时留着两张可点的卡（两张指向同一个 taskId，点哪张都按最新计划入库）',
      });
      return { attempted: true, result: 'failed', reason: 'update_failed' };
    }
    // ③ 校验更新结果：再读一眼（只作证据，不作业务判据）。
    const after = await this.readMessageMeta(id);
    logInfo('purchase.arrival.reconcile.card_superseded', {
      task_id: taskId, batch_no: batchNo,
      card_message_id: id, new_card_message_id: newCardMessageId,
      // `false` = 改是改了（`code 0`），但**读回来的 `updated` 不是 true**：
      // 说明"改没改成"这件事靠 `code 0` 判不了 —— 正是这次要留下的证据。
      update_verified: after.ok ? after.updated === true : false,
      update_verify_reason: after.ok ? '' : after.reason,
    });
    return { attempted: true, result: 'ok', verified: after.ok ? after.updated === true : null };
  }

  /**
   * 更新一张**已经存在的**卡片；**失败必须看得见**（业务负责人 2026-10-08 逐条批准）。
   *
   * 改前：失败只 `logWarn` + 返 `false` —— 她那边的现象就是"点了一点反应都没有"
   *（卡片没动、也没有任何文字），日志里却只有一行 warn。
   * 现在两条腿一起走：
   *   ① **warn 留痕**（保留原有的 `card_update_failed`，把"适配器返回假值"与"抛错"都写上）；
   *   ② **往那条话题回一句人话**（`replies.cardUpdateFailed`，可置空）——
   *      文案说清"卡片没刷新成功，以这条话为准 / 重新说一句我重出卡"。
   *      ⚠️ 这句回话**自己失败也不许抛**（`safeReplyText` 内部已吞并记 `reply_failed`），
   *         这里**不再套第二层兜底**。
   *
   * @param {object} [options] `{ task, taskId, threadId, replyOnFailure }`
   *   · `task` / `taskId`：拿 `task.thread_id` 把兜底那句回到**同一条话题**（拿不到就不带）；
   *   · `replyOnFailure: false`：调用方**自己紧接着就会回话**（或回话会误导）⇒ 不叠这句。
   */
  async safeUpdateCard(messageId, card, options = {}) {
    if (!messageId) return false;
    let updated = false;
    try {
      updated = await this.updateCard(messageId, card);
      // ⚠️ 适配器**不抛错但返回假值**也是"没改成"（例如 `client.im.v1.message.patch` 不存在），
      //    一样要留痕 —— 否则排查时只看到"卡片没变"，不知道为什么。
      if (!updated) {
        logWarn('purchase.arrival.reconcile.card_update_failed', {
          message_id: messageId, error: 'updateCard 返回了假值（卡片没改成功）',
        });
      }
    } catch (error) {
      logWarn('purchase.arrival.reconcile.card_update_failed', { message_id: messageId, error: error.message });
      updated = false;
    }
    if (!updated) await this.notifyCardUpdateFailed(messageId, options);
    return updated;
  }

  /**
   * 卡片没刷新成功时，往那条话题回一句人话（**本身永不抛**）。
   *
   * ⚠️ 它是 `safeUpdateCard` 的兜底，**不反向调用 `safeUpdateCard`**（否则就是无限兜底）。
   * ⚠️ 文案在 config（`replies.cardUpdateFailed`）；置空 = 只留 warn、不回话。
   */
  async notifyCardUpdateFailed(messageId, options = {}) {
    const copy = options.replyOnFailure === false ? '' : this.config.replies.cardUpdateFailed;
    if (!copy) return false;
    const task = options.task || await this.loadTaskQuietly(options.taskId);
    const thread = options.threadId ? { threadId: String(options.threadId) } : this.threadOptions(task);
    const replied = await this.safeReplyText(messageId, copy, thread);
    logWarn('purchase.arrival.reconcile.card_update_failed_notice', {
      message_id: messageId,
      task_id: options.taskId || task?.task_id || '',
      replied,
      note: '卡片没刷新的兜底回话（这句本身失败也只记日志，绝不抛）',
    });
    return replied;
  }

  /** 读一眼任务拿 `thread_id` 用；读不到（没接线 / 记录没了）返 null，**不抛**。 */
  async loadTaskQuietly(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return null;
    try {
      return await this.store.get(id);
    } catch (error) {
      logWarn('purchase.arrival.reconcile.task_read_failed', {
        task_id: id, error: error.message, note: '只为拿 thread_id；读不到就不带话题',
      });
      return null;
    }
  }
}

module.exports = { PurchaseArrivalConversationService, taskIdForBatch, TASK_TYPE };
