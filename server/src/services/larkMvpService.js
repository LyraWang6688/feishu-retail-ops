const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const doubaoService = require('./doubaoService');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { updateInteractiveCard } = require('../infrastructure/interactiveCardFeedback');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1PostingService } = require('./v1PostingService');
const { createWorkbenchService } = require('./v1WorkbenchService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SecondDeliveryService } = require('./secondDeliveryService');
const { SampleReplacementService } = require('./sampleReplacementService');
const { PurchaseWebhookService } = require('./purchaseWebhookService');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { LiveInventoryIndex, buildLiveInventoryIndex } = require('./liveInventoryIndex');
const { tradeTypeCodeFromLabel, deliveryForTradeType } = require('../config/salesMovements');
const { isDataNotReady, withSalesReadRetry } = require('./salesReadRetry');
const { allocateSalesOrderNo } = require('./salesOrderNo');
const { resolveAccessory } = require('./accessoryMatchPolicy');
const { SaleLookupService } = require('./saleLookupService');
const { AfterSalesService } = require('./afterSalesService');
const { AfterSalesFlowService } = require('./afterSalesFlowService');
const { isLookupIntent, isAfterSalesIntent, normalizeMessageIntent } = require('../config/saleIntents');
const { isAfterSalesCardAction } = require('../config/afterSalesFlow');
const { isSalesCandidate, UNSUPPORTED_INTENT_REPLY } = require('../config/messageGate');
const { salesConfirmationCard, salesStatusCard, todaySalesCard, keepOnlyCardButton, SECOND_DELIVERY_ACTION } = require('../utils/larkCards');
const { extractSalesMessageText, isMentioned, stripMentionPlaceholders } = require('../utils/larkMessageText');
const { resolveAckReaction, resolveBotOpenId } = require('../config/groupPurchase');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');
// 「采购到货：群话题对话式核对」的编排（独立 service；本类只做接线）。
const { PurchaseArrivalConversationService } = require('./purchaseArrivalConversationService');
// 到货核对卡片上的两个动作名（与卡片渲染共用同一份常量，见 utils/larkCards）。
const { ARRIVAL_CONVERSATION_ACTIONS } = require('../config/arrivalConversation');
const { GroupPurchaseFlowService } = require('./groupPurchaseFlowService');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { recordUrl } = require('../utils/feishuLinks');

// 交付与否以草稿的交易类型为准：现货/未付当场交付，预付（只付定金、货没拿走）不交付。
// 只有旧数据才没有明确的交付状态（待确认或缺失），那时退回按钮语义——
// 旧卡片上的「确认已交付 / 确认未交付」是用户显式做出的选择。
const shouldDeliverFor = (task, action) => {
  const declared = task?.draft?.delivery_status;
  if (declared === '已交付' || declared === '未交付') return declared === '已交付';
  return action === 'confirm_sale_delivered';
};

const idFor = (prefix, value) =>
  `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20)}`;

const parseContent = (content) => {
  try {
    return JSON.parse(content || '{}');
  } catch (_error) {
    return {};
  }
};

const timestamp = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
};

const aggregateRecognizedItems = (items) => {
  const map = new Map();
  for (const item of items) {
    const key = [item.item_no, item.color, item.size].map((value) => String(value || '').trim()).join('|');
    if (!map.has(key)) map.set(key, { ...item, quantity: 0 });
    map.get(key).quantity += Number(item.quantity || 1);
  }
  return [...map.values()];
};

// 入口闸门：**含数字** 或 **含业务关键词** 的消息才送进 AI。
//
// 原来是"必须含数字"，会误伤"我要退货""查一下我买的鞋"这类明确诉求 —— 它们
// 被静默忽略，用户以为机器人坏了。关键词表在 config/messageGate（配置先行），
// 这里只做一行委托，加词不去改函数。
// 名字沿用 looksLikeSalesText：它是既有导出，改语义不改名字，避免动无关调用点。
const looksLikeSalesText = (text) => isSalesCandidate(text);

const shanghaiDay = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateLabel = `${values.year}-${values.month}-${values.day}`;
  const start = Date.parse(`${dateLabel}T00:00:00+08:00`);
  return { dateLabel, start, end: start + 24 * 60 * 60 * 1000 };
};

class LarkMvpService {
  constructor(options = {}) {
    if (options.client) this.client = options.client;
    else {
      const { appId, appSecret } = getLarkAgentCredentials();
      this.client = new lark.Client({ appId, appSecret, logger: larkLogger });
    }
    this.gateway = options.gateway || new V1BitableGateway({ client: this.client });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.recognizer = options.recognizer || doubaoService;
    this.posting = options.posting || new V1PostingService({ gateway: this.gateway, references: this.references });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    // 「第二次交付」：已入账的未付 / 预付单点「成交」→ 补收款 + 交付。
    // 刻意把上面那个 delivery 实例传进去：卡片这条路的交付与首次录单的交付
    // 共用同一个串行队列，两个入口不会各扣一次库存。
    this.secondDelivery = options.secondDelivery || new SecondDeliveryService({
      gateway: this.gateway, delivery: this.delivery,
    });
    this.purchaseWebhooks = options.purchaseWebhooks || new PurchaseWebhookService({
      client: this.client,
      gateway: this.gateway,
      references: this.references,
      recognizer: this.recognizer,
    });
    this.store =
      options.store ||
      new JsonTaskStore({ dir: path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id' });
    // 退换货第一期：查销售记录是**独立 service**，不把候选查询/卡片/上下文塞进本类。
    // 这里只注入"读网关 + 任务状态 + 发消息"三样依赖；网关会被 SaleLookupService
    // 再收窄成只读视图，从结构上保证这条链路写不了业务表。
    this.saleLookup = options.saleLookup || new SaleLookupService({
      gateway: this.gateway,
      store: this.store,
      replyCard: (messageId, card) => this.replyCard(messageId, card),
      sendCard: (openId, card) => this.sendCard(openId, card),
    });
    // 退换货第二期：售后**编排**（定位 → 组装方案 → 确认卡片 → 调执行器）也是独立 service。
    // 本类只留"意图 → 分派"的接线：
    //   · 定位复用第一期的只读 SaleLookupService（同上一个实例，共享任务状态）；
    //   · 写入复用第二期第一步的 AfterSalesService 执行器（幂等由它自己负责）；
    //   · 卡片渲染在 utils/larkCards，本类不拼卡片内容。
    // 执行器用自己的任务存储（data/after_sales_operations），所以这里不能把销售的任务存储传给它。
    this.afterSales = options.afterSales || new AfterSalesService({ gateway: this.gateway });
    this.afterSalesFlow = options.afterSalesFlow || new AfterSalesFlowService({
      gateway: this.gateway,
      store: this.store,
      lookup: this.saleLookup,
      executor: this.afterSales,
      references: this.references,
      sizeReferences: options.sizeReferences,
      replyCard: (messageId, card) => this.replyCard(messageId, card),
      sendCard: (openId, card) => this.sendCard(openId, card),
      sendText: (openId, message) => this.sendText(openId, message),
      updateCard: (task, event, card, metadata) => this.updateAfterSalesCard(task, event, card, metadata),
    });
    this.sampleReplacements = options.sampleReplacements || new SampleReplacementService({
      gateway: this.gateway, inventory: this.delivery.inventory, store: this.store, client: this.client,
      sendCard: (openId, card) => this.sendCard(openId, card),
      sendText: (openId, message) => this.sendText(openId, message),
      updateCard: (task, event, card, metadata) => this.updateSalesActionCard(task, event, card, metadata),
    });
    // 「确认状态」（用户那一维）的唯一写入口：名字与取值都在 config/salesStatusDimensions。
    // ⚠️ 它**只记她在卡片上点了什么**，不参与任何闸门判据（判据读的是「资金状态」）。
    this.salesStatus = options.salesStatus || new SalesStatusWriter({ gateway: this.gateway });
    this.intakeSchemaValidation = new Map();
    this.senderQueues = new Map();
    this.cardActionQueue = new KeyedSerialQueue();
    // ── 群聊（采购链路搬进群）────────────────────────────────────────────────
    // 「群消息 → 是哪一批采购单」的定位器。它自带本地任务存储
    // （data/purchase_group_messages），**不共用销售任务存储**：两件事的记录混在
    // 一个目录里，将来按任务翻盘时会互相干扰。
    this.purchaseBatchLocator = options.purchaseBatchLocator || new PurchaseBatchLocator({
      store: options.purchaseBatchLocatorStore,
    });
    // @ 判据用的机器人 open_id：**只从配置读，不写死**（见 config/groupPurchase）。
    // 启动时解析一次：解析结果只影响"这条群消息理不理"，不会影响私聊的既有行为。
    this.botOpenId = options.botOpenId ?? resolveBotOpenId();
    if (!this.botOpenId) {
      // 没配 = 群聊里判不出 @ 机器人。这时候**一条群消息都不处理**（宁可不响应，
      // 也不能把群里日常聊天当成指令），但必须留下能排查的线索。
      logWarn('lark.group.bot_open_id_missing', {
        env: 'LARK_BOT_OPEN_ID',
        hint: '未配置机器人 open_id，群聊消息不会进入采购流程（私聊不受影响）',
      });
    }
    // ── 到货核对（D）：「群话题对话式核对」──────────────────────────────────
    // 它只干一件事：把话题里的自然对话变成一次核对会话 + 一个触发点。
    // ⚠️ 会话任务与入库能力**共用采购那套存储与队列**（PurchaseWebhookService 的
    //   `store` / `confirmArrival`）——入库那一步就是从那个 store 读草稿的，
    //   共用一个才不会出现"会话在这边、草稿在那边"的两份状态。
    // ⚠️ 它**不复用**已退场的「拍照识别到货」任何东西（没有视觉模型、没有旧卡片动作）：
    //   那条链路删掉的字段/能力一个都不碰，这里只调保留下来的 confirmArrival。
    this.arrivalConversation = options.arrivalConversation || new PurchaseArrivalConversationService({
      gateway: this.gateway,
      // ⚠️ 会话任务必须和**入库那一步读草稿的存储**是同一个：生产路径上就是
      // PurchaseWebhookService 的 store。`|| this.store` 只是给"注入了采购服务桩"
      // 的单元测试兜底（那种桩不跑本链路），生产上永远走前面那一个。
      store: this.purchaseWebhooks.store || this.store,
      recognizer: this.recognizer,
      sizeReferences: this.purchaseWebhooks.getSizeReferences,
      confirmArrival: (taskId, task, operatorOpenId) =>
        this.purchaseWebhooks.confirmArrival(taskId, task, operatorOpenId),
      // 群里的反馈一律**回复那条消息**（卡片也回复进同一个话题）。
      replyText: (messageId, content) => this.replyText(messageId, content),
      replyCard: (messageId, card) => this.replyCard(messageId, card),
      updateCard: (messageId, card) => this.patchCardMessage(messageId, card),
    });
    this.groupPurchaseFlow = options.groupPurchaseFlow || new GroupPurchaseFlowService({
      locator: this.purchaseBatchLocator,
      // 群里的反馈一律**引用回复**那条消息：群聊没有"上一次对话"的概念，
      // 不复用私聊的 sendText（那会发出一条没有上下文的光秃秃消息）。
      replyText: (messageId, content) => this.replyText(messageId, content),
      // ── 到货核对（D）────────────────────────────────────────────────────
      // 定位到某一批之后，由它接管"记下来 → 判她说完了没有 → 发「是/否」卡片 →
      // 点「是」才入库"。它是**独立 service**：本类只做接线，不拼卡片、不写业务规则。
      // ⚠️ 会话任务和入库能力**共用采购那套存储与队列**（PurchaseWebhookService 的
      //   store / confirmArrival）——那边读草稿就是从那个 store 读的，共用一个才不会
      //   出现"会话在这边、草稿在那边"的两份状态。
      arrivalConversation: this.arrivalConversation,
    });
  }

  enqueueForSender(senderOpenId, work) {
    const previous = this.senderQueues.get(senderOpenId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.senderQueues.set(senderOpenId, next);
    const cleanup = () => {
      if (this.senderQueues.get(senderOpenId) === next) this.senderQueues.delete(senderOpenId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async ensureIntakeSchema(scope, tableKeys) {
    if (typeof this.gateway.validateTables !== 'function') return;
    if (!this.intakeSchemaValidation.has(scope)) {
      this.intakeSchemaValidation.set(scope, this.gateway.validateTables(tableKeys));
    }
    return this.intakeSchemaValidation.get(scope);
  }

  async sendText(openId, message) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: message }),
      },
    });
    if (response.code !== 0) throw new Error(`发送飞书消息失败: ${response.msg} (Code: ${response.code})`);
  }

  async sendCard(openId, card) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    if (response.code !== 0) throw new Error(`发送飞书卡片失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  /**
   * 执行确认卡片上已经选好的补样品。
   *
   * 模块边界：补样品这件事由 SampleReplacementService 负责，这里只把
   * "哪条明细、哪个货品、补哪个尺码"整理好交给它。
   */
  async applyChosenSampleReplacements(task, postingResult) {
    const replacements = (task.draft?.items || [])
      .map((item, index) => ({
        salesDetailRecordId: postingResult?.detailRecordIds?.[index] || '',
        productRecordId: item.product_record_id || '',
        size: item.sample_replacement_size || '',
      }))
      .filter((item) => item.salesDetailRecordId && item.productRecordId && item.size);
    if (!replacements.length) return new Set();
    return this.sampleReplacements.applyPreChosen(replacements);
  }

  async notifySampleReplacements(deliveryResult, operatorOpenId, options = {}) {
    return this.sampleReplacements.notifySampleReplacements(deliveryResult, operatorOpenId, options);
  }

  async sendTodaySales(openId, now = new Date()) {
    const { dateLabel } = shanghaiDay(now);
    const report = await createWorkbenchService(this.gateway).getTodaySales({ date: dateLabel });
    const rows = report.rows.map((row) => ({
      product: row.product_number || '未知编号', size: row.size, quantity: row.quantity,
      amount: row.receivable_amount, paymentMethod: row.payment_method,
    }));
    const totalQuantity = report.summary.quantity;
    const totalAmount = report.summary.paid_amount;
    await this.sendCard(openId, todaySalesCard({ dateLabel, rows, totalQuantity, totalAmount }));
    logInfo('lark.sales.today.sent', {
      operator_open_id: openId,
      date: dateLabel,
      detail_count: rows.length,
      total_quantity: totalQuantity,
      total_amount: totalAmount,
    });
    return { rows, totalQuantity, totalAmount };
  }

  async handleBotMenu(event) {
    const eventKey = event?.event_key || event?.event?.event_key;
    const openId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    if (!openId) throw new Error('机器人菜单事件缺少用户 open_id');
    if (eventKey !== 'query_today_sales') throw new Error(`不支持的机器人菜单事件: ${eventKey}`);
    return this.sendTodaySales(openId);
  }

  async replyText(messageId, message) {
    const response = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: message }) },
    });
    if (response.code !== 0) throw new Error(`回复飞书消息失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  async replyCard(messageId, card) {
    const response = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw new Error(`回复飞书卡片失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  /**
   * 把**已经发出去的那张卡片**改成新内容（例如「已入库」）。
   *
   * 与私聊那几张卡的 update 走的是同一套 SDK patch；区别只是这里拿的是
   * **明确的 message_id**（群话题里的卡片不是"某个销售草稿的卡"，没有 task 可以查）。
   * 卡片改不动（权限、消息被撤回）只记日志——业务事实早就落地了，不能因此判失败。
   */
  async patchCardMessage(messageId, card) {
    if (!messageId) return false;
    const patch = this.client.im?.v1?.message?.patch || this.client.im?.message?.patch;
    if (!patch) return false;
    const response = await patch.call(this.client.im?.v1?.message || this.client.im.message, {
      path: { message_id: String(messageId) },
      data: { content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw new Error(`更新飞书卡片失败: ${response.msg} (Code: ${response.code})`);
    return true;
  }

  async updateSalesActionCard(task, event, card, metadata = {}) {
    return updateInteractiveCard({ client: this.client, task, event, card,
      stage: metadata.stage, interactionId: metadata.interactionId,
      eventPrefix: task.type === 'sample_replacement' ? 'lark.sales.sample_card.update' : 'lark.sales.card.update' });
  }

  // 售后卡片的更新单独一个日志前缀：排查时能一眼分出"这是售后那张卡"。
  async updateAfterSalesCard(task, event, card, metadata = {}) {
    return updateInteractiveCard({ client: this.client, task, event, card,
      stage: metadata.stage, interactionId: metadata.interactionId,
      eventPrefix: 'lark.after_sales.card.update' });
  }

  async publishSalesResultCard(task, event, card, metadata = {}) {
    if (await this.updateSalesActionCard(task, event, card, metadata)) return true;
    try {
      const messageId = await this.sendCard(task.sender_open_id, card);
      if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
      logInfo('lark.sales.card.fallback.sent', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, card_message_id: messageId });
      return true;
    } catch (error) {
      logWarn('lark.sales.card.fallback.failed', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, error: error.message });
      return false;
    }
  }

  /**
   * 「收到了」的反馈。私聊和群聊**都要加表情**（表情是唯一不变的"已收到"信号）。
   *
   * 私聊额外回一句文字（现状不变）；群聊**不回文字**——群里一句"已收到，正在识别…"
   * 会刷屏，业务负责人明确说表情就够了。
   *
   * 表情类型从配置读（默认 OneSecond，真机验证过有效）：改表情不碰代码。
   * 表情加不上（缺权限、消息被撤回）只 warn：它只是信号，绝不能影响主流程。
   */
  async acknowledgeMessage(messageId, options = {}) {
    const includeTextReply = options.includeTextReply !== false;
    const emojiType = options.emojiType || resolveAckReaction();
    const pending = [
      this.client.im.messageReaction
        .create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emojiType } },
        })
        .then((response) => {
          if (response.code !== 0) {
            throw new Error(`添加飞书表情回复失败: ${response.msg} (Code: ${response.code})`);
          }
        }),
    ];
    if (includeTextReply) pending.push(this.replyText(messageId, '👀 已收到，正在识别销售信息，请稍候…'));
    const results = await Promise.allSettled(pending);
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logWarn('lark.sales.acknowledgement.failed', {
          message_id: messageId,
          // 索引 0 永远是表情；文字回复只有私聊才有，所以按是否请求了文字回复来标注。
          channel: index === 0 ? 'reaction' : 'reply',
          emoji_type: index === 0 ? emojiType : undefined,
          error: result.reason?.message || String(result.reason),
        });
      }
    });
    return { emojiType, textReplied: includeTextReply };
  }

  async acceptMessage(event) {
    const message = event?.message;
    const senderOpenId = event?.sender?.sender_id?.open_id;
    if (!message?.message_id || !senderOpenId) return { accepted: false, reason: 'missing_identity' };

    // ── 群聊：准入两条，**先看 thread_id**（业务负责人真机实测后改的规则）──────
    //   ① 话题里的消息（`thread_id` 有值）→ **都理，不要求 @机器人**。
    //      实测：她在话题里发「你好 小来财」没有 @（mentions=[]），事件照样推给我们；
    //      话题本身就是"这条是冲着机器人来的"的判据，再要求 @ 会把她说的话丢掉。
    //   ② 主群消息（`thread_id` 为空）→ 只在 `mentions` 含机器人 open_id 时才理。
    //      不 @ → **完全静默**：连日志之外的动作都没有，更没有任何远端调用
    //      （不发消息、不加表情、不读表）。群里所有人发的消息都会推给我们，
    //      这道闸门是拦它们的唯一一道。
    //
    // ⚠️ 必须**先判 `thread_id`**：话题里没 @ 的消息要在读 mentions 之前就放行，
    //    顺序反了会把它当成"主群没 @"丢掉——这正是她真机测出来的那个 bug。
    // ⚠️ 这里刻意**不复用**私聊的闸门（含数字/业务关键词）：群里"36 码还有吗"
    // 这种闲聊带着数字，用私聊闸门会被当成录单送进 AI。
    if (message.chat_type === 'group') {
      const threadId = String(message.thread_id || '').trim();
      if (!threadId) {
        // 主群消息：判据只有 @机器人。没配 LARK_BOT_OPEN_ID 就判不出 @，
        // 这时**一条主群消息都不处理**（宁可不响应，也不能把日常聊天当指令）。
        if (!this.botOpenId) {
          logWarn('lark.group.message.ignored', {
            message_id: message.message_id, reason: 'bot_open_id_unconfigured',
          });
          return { accepted: false, reason: 'group_bot_open_id_unconfigured' };
        }
        if (!isMentioned(message.mentions, this.botOpenId)) {
          logInfo('lark.group.message.ignored', {
            message_id: message.message_id, reason: 'not_mentioned', chat_id: message.chat_id,
          });
          return { accepted: false, reason: 'group_not_mentioned' };
        }
      }
      if (!['text', 'post'].includes(message.message_type)) {
        // 群聊准入通过（话题里、或主群里 @ 了）但发的是图片/文件：**静默忽略**，
        // 不解释、不回复。群里回一句"我只接收文字"同样会刷屏，而且这条链路今天
        // 只有采购定位，没有需要她立刻知道的失败。
        logInfo('lark.group.message.ignored', {
          message_id: message.message_id, reason: 'unsupported_message_type',
          message_type: message.message_type,
        });
        return { accepted: false, reason: 'group_unsupported_message_type' };
      }
      const groupText = extractSalesMessageText(message);
      if (!groupText) {
        logInfo('lark.group.message.ignored', { message_id: message.message_id, reason: 'empty_text' });
        return { accepted: false, reason: 'group_empty_text' };
      }
      logInfo('lark.group.message.accepted', {
        message_id: message.message_id, chat_id: message.chat_id,
        sender_open_id: senderOpenId, parent_id: message.parent_id,
        thread_id: threadId, // 空 = 主群（靠 @ 进来的）；有值 = 话题（免 @）
        via: threadId ? 'thread' : 'mention',
        text_length: groupText.length,
      });
      // 返回值统一带上 `accepted: true`（和私聊那条路同一个契约），
      // 另外附上定位结果（resolved/batchNo/…）供调用方与将来的 D 使用。
      const flowResult = await this.acceptGroupMessage({
        message, senderOpenId, originalText: groupText, threadId,
      });
      return { accepted: true, ...flowResult };
    }

    if (message.chat_type !== 'p2p') {
      logWarn('lark.mvp.message.ignored', { message_id: message.message_id, reason: 'not_p2p' });
      return { accepted: false, reason: 'not_p2p' };
    }

    if (!['text', 'post'].includes(message.message_type)) {
      await this.sendText(senderOpenId, '机器人当前只接收销售文字；采购请使用采购表单。');
      return { accepted: false, reason: 'unsupported_message_type' };
    }

    const originalText = extractSalesMessageText(message);
    if (!originalText) {
      await this.sendText(senderOpenId, '没有读到销售文字，请发送普通文字或带文字的富文本消息。');
      return { accepted: false, reason: 'empty_sales_text' };
    }
    logInfo('lark.sales.message.normalized', { message_id: message.message_id,
      message_type: message.message_type, sender_open_id: senderOpenId,
      text_length: originalText.length, line_count: originalText.split('\n').length });
    return this.acceptSalesText({ message, senderOpenId, originalText });
  }

  /**
   * 群聊入口。**准入由调用方判定**（话题免 @ / 主群 @），进来之后：
   *   · 剥掉 @ 占位符（`@_user_1`）再当正文；
   *   · 加「收到」表情（**不回文字**，群聊回文字会刷屏）；
   *   · 交给采购定位链路（C）——今天它只回答"是哪一批"，不写任何业务表。
   *
   * ⚠️ 群聊**绝不用私聊那套闸门**（含数字/业务关键词就收）：群里一句
   *   "这批鞋到了""36 码还有吗"都会被误触发。这里的准入判据只有上面那两条。
   */
  async acceptGroupMessage({ message, senderOpenId, originalText, threadId = '' }) {
    const text = stripMentionPlaceholders(originalText, message.mentions);
    if (!text) {
      // 只 @ 了机器人（或话题里空着一条）、一个字没说。回一句问清楚，不猜。
      logInfo('lark.group.message.empty_after_mention', { message_id: message.message_id });
      return this.groupPurchaseFlow.handleGroupPurchaseMessage({
        messageId: message.message_id,
        text: '',
        parentId: message.parent_id,
        threadId,
        senderOpenId,
      });
    }
    await this.acknowledgeMessage(message.message_id, { includeTextReply: false });
    return this.groupPurchaseFlow.handleGroupPurchaseMessage({
      messageId: message.message_id,
      text,
      parentId: message.parent_id,
      threadId,
      senderOpenId,
    });
  }

  async acceptSalesText({ message, senderOpenId, originalText }) {
    if (!looksLikeSalesText(originalText)) {
      logInfo('lark.message.ignored', {
        message_id: message.message_id,
        sender_open_id: senderOpenId,
        reason: 'not_sales_candidate',
        text_length: originalText.length,
      });
      return { accepted: false, reason: 'not_sales_candidate' };
    }
    const taskId = idFor('sale', message.message_id);
    if (await this.store.get(taskId)) return { accepted: false, reason: 'duplicate', taskId };
    const task = await this.store.create({
      task_id: taskId,
      type: 'sale',
      status: 'received',
      message_id: message.message_id,
      sender_open_id: senderOpenId,
      sent_at: timestamp(message.create_time),
      original_text: originalText,
    });
    logInfo('lark.sales.accepted', {
      task_id: taskId,
      message_id: message.message_id,
      sender_open_id: senderOpenId,
      text_length: originalText.length,
    });
    await this.acknowledgeMessage(message.message_id);
    setImmediate(() =>
      this.enqueueForSender(senderOpenId, () => this.processSalesTask(taskId)).catch((error) =>
        this.handleTaskFailure(taskId, error)
      )
    );
    return { accepted: true, type: 'sale', taskId: task.task_id };
  }


  /**
   * 「其他配品」清单。没配置这张表时返回空——那种部署下销售只支持鞋，
   * 配品说法会被当成未知货号处理，而不是报配置错误。
   */
  async listAccessories() {
    const table = this.gateway.table?.('accessory');
    if (!table?.tableId) return [];
    try {
      const records = await this.gateway.listAll('accessory');
      return records
        .map((record) => ({
          record_id: record.record_id,
          name: textValue(record.fields?.[table.fields.name]).trim(),
          // 「种类」是配品的品类（鞋油、腰带…），用户嘴里说的通常就是它。
          // 单选字段读回来是数组，textValue 会归一成「鞋油」这样的字符串。
          // 部署里没配这个字段映射（或某条没填）时留空：那种情况下只按名称匹配，
          // 与改动前的行为完全一致，不会因为缺分类就匹配失败。
          category: table.fields.category
            ? textValue(record.fields?.[table.fields.category]).trim()
            : '',
        }))
        .filter((item) => item.name);
    } catch (error) {
      logWarn('lark.sales.accessory.list_failed', { error: error.message });
      return [];
    }
  }

  /**
   * 卖这一双会不会动到样品？会的话，把"可以用哪些门盒补"一并算出来。
   *
   * 能提前算，是因为出卡片前已经读过实时库存：门盒几双、样品几双都是已知的。
   * 于是"卖样品要补哪个门盒"能在这张卡片上一次问完，不必事后另弹一张卡。
   *
   * 三种情况要分清：
   *   · 门盒够        → 不会动样品，什么都不用问
   *   · 门盒不够、样品够 → 会动样品，需要她选一个门盒来补（有候选项时）
   *   · 门盒样品都不够  → 这是"库存不足"，走没货那条路，不在这里处理
   */
  samplePlanFor({ productRecordId, stock, quantity = 1 }, liveInventory) {
    const none = { uses_sample: false, needs_sample_replacement: false, sample_replacement_options: [] };
    const needs = Number(quantity || 1);
    const doorBox = Number(stock?.doorBox || 0);
    const sample = Number(stock?.sample || 0);
    if (!productRecordId || doorBox >= needs || sample < needs) return none;
    const options = (liveInventory?.sampleReplacementCandidatesForProduct?.(productRecordId) || [])
      .filter((row) => row.doorBoxCount > 0);
    return {
      uses_sample: true,
      // 有候选项才需要她选；一个都没有时只在卡片上提示（另行调拨），不拦住确认。
      needs_sample_replacement: options.length > 0,
      sample_replacement_options: options,
    };
  }

  /**
   * 「货品信息」整表读一次，按记录 ID 建索引。
   *
   * 为什么不按需逐条读：录单时逐条读是**串行**的（一件商品一次请求），
   * 那份等待会直接加到"卡片出现"的时间上；整表读只有一个请求，而且能和
   * AI 解析、实时库存读取**三路并行**，读表时间藏在 AI 后面。
   * 这张表是**主数据**（货品资料，不像实时库存那样时时在变）。
   *
   * 表里没配 completeness 映射时返回 null —— 那种部署下不做这项检查。
   */
  async loadProductIndex() {
    const table = this.gateway.table?.('product');
    if (!table?.tableId || !table.fields?.completeness) return null;
    const readStartedAt = Date.now();
    const records = await this.gateway.listAll('product');
    const byId = new Map();
    // 同时按「货号」建索引：同一个货号会有多个颜色（每个颜色一条货品记录）。
    // 卖货时要把**这个货号下所有颜色**里资料不全的都提示出来——同款不同色通常
    // 一起上架，让她一次补齐，比每次卖一个颜色提醒一次省事。
    const byItemNo = new Map();
    // 配置写错（例如用了界面显示名而记录里是内部名）时，整表都读不到这个键。
    // 那种情况下不报错、只是永远不提示她补资料——最难查，所以单独留一条警告。
    let completenessSeen = 0;
    for (const record of records) {
      const fields = record?.fields || {};
      // 「信息是否齐备」是飞书公式：齐备时返回「齐备」，否则返回缺的字段名。
      // 不自己逐字段判断——单一数据源留在表里，她在飞书改公式这里自动跟着变。
      const completeness = textValue(fields[table.fields.completeness]).trim();
      const sampleImages = fields[table.fields.sampleImage];
      const itemNo = textValue(fields[table.fields.itemNo]).trim();
      const color = textValue(fields[table.fields.color]).trim();
      const info = {
        missing: completeness && completeness !== '齐备'
          ? completeness.split('、').map((name) => name.trim()).filter(Boolean)
          : [],
        // 「样例图」是附件字段，不在齐备公式里，单独看有没有图。
        missingSampleImage: !(Array.isArray(sampleImages) && sampleImages.length > 0),
        label: `${itemNo}${color}`,
      };
      if (fields[table.fields.completeness] !== undefined) completenessSeen += 1;
      byId.set(record.record_id, info);
      if (itemNo) {
        if (!byItemNo.has(itemNo)) byItemNo.set(itemNo, []);
        byItemNo.get(itemNo).push({ recordId: record.record_id, ...info });
      }
    }
    if (records.length && completenessSeen === 0) {
      logWarn('lark.sales.product_index.completeness_field_unreadable', {
        field: table.fields.completeness,
        hint: '字段名可能写成了界面显示名；记录 API 用的是内部名',
      });
    }
    logInfo('lark.sales.product_index.loaded', {
      record_count: records.length, item_count: byItemNo.size,
      // 这一段和 AI 解析、实时库存读取是并行的，所以这份耗时是"自己花了多久"，
      // 不是"让用户多等了多久"——排查时看它有没有盖过另外两路即可。
      duration_ms: Date.now() - readStartedAt,
    });
    return { tableId: table.tableId, byId, byItemNo };
  }

  /**
   * 从已读好的索引里算货品资料缺口 —— **纯计算，不再请求远端**。
   * 索引为 null（没配这项检查 / 读表失败）时返回空：宁可少一次提醒，也不能挡住录单。
   */
  productInfoGapsFromIndex(items, index) {
    if (!index) return [];
    const appToken = V1_BITABLE_SCHEMA.appToken;
    const gaps = [];
    const seen = new Set();
    // 按「货号」取——同一个货号可能有多个颜色，每个颜色一条货品记录。
    // 卖其中一双时，把这个货号下**所有颜色**里资料不全的都提示出来。
    for (const item of items || []) {
      const itemNo = String(item.item_no || '').trim();
      if (!itemNo) continue;
      // 优先用货号索引；没有货号索引时退回"只看这一件匹配到的记录"。
      const candidates = index.byItemNo?.get(itemNo)
        || (index.byId?.get(item.product_record_id)
          ? [{ recordId: item.product_record_id, ...index.byId.get(item.product_record_id) }] : []);
      for (const candidate of candidates) {
        if (seen.has(candidate.recordId)) continue;
        seen.add(candidate.recordId);
        if (!candidate.missing.length && !candidate.missingSampleImage) continue;
        gaps.push({
          record_id: candidate.recordId,
          label: candidate.label || item.item_no || '',
          missing: candidate.missing,
          missing_sample_image: candidate.missingSampleImage,
          url: recordUrl({ appToken, tableId: index.tableId, recordId: candidate.recordId }),
        });
      }
    }
    if (gaps.length) logInfo('lark.sales.product_info.gaps', { count: gaps.length });
    return gaps;
  }

  /**
   * 团购券目录：只取「在售」的券，按「售价 + 面值」匹配结算金额。
   *
   * 读不到就当没有券目录——她对券的说法会落到"未配置该券的结算金额，请补充"的追问上，
   * 而不是拿别的券顶替、写一个错的收款金额。
   */
  async listGroupBuyVouchers() {
    const table = this.gateway.table?.('groupBuyVoucher');
    if (!table?.tableId) return [];
    try {
      const records = await this.gateway.listAll('groupBuyVoucher');
      return records
        .map((record) => ({
          record_id: record.record_id,
          name: textValue(record.fields?.[table.fields.name]).trim(),
          status: textValue(record.fields?.[table.fields.status]).trim(),
          purchasePrice: Number(record.fields?.[table.fields.purchasePrice]),
          faceValue: Number(record.fields?.[table.fields.faceValue]),
          settlementAmount: Number(record.fields?.[table.fields.settlementAmount]),
        }))
        .filter((voucher) => voucher.status === '在售'
          && Number.isFinite(voucher.purchasePrice)
          && Number.isFinite(voucher.faceValue)
          && Number.isFinite(voucher.settlementAmount));
    } catch (error) {
      logWarn('lark.sales.group_buy_vouchers.list_failed', { error: error.message });
      return [];
    }
  }

  /**
   * 读一次「实时库存」，按 `货号 + 尺码` 建索引。
   *
   * 为什么以实时库存为准：它是"店里实际有什么"，「货品信息」只是"配置过什么"。
   * 销售卖的是实物，所以颜色、有没有货、是门盒还是样品，都该从这里回答；
   * 而且一张表读一次就够，不必每双鞋各查一遍货品资料。
   */
  async loadLiveInventoryIndex() {
    const table = this.gateway.table?.('liveInventory');
    if (!table?.tableId) return new LiveInventoryIndex({ records: [] });
    const startedAt = Date.now();
    const records = await this.gateway.listAll('liveInventory');
    const index = buildLiveInventoryIndex({ records, table });
    logInfo('lark.sales.live_inventory.loaded', {
      task_id: null,
      record_count: records.length,
      skipped_records: index.skippedRecords,
      duration_ms: Date.now() - startedAt,
    });
    return index;
  }

  /**
   * 读回销售主表里已有的销售单号，交给纯函数算下一个号。
   *
   * 只负责「读」：怎么算在 salesOrderNo.js（纯函数，可单测），怎么写在本类里
   * createSalesEntryWithOrderNo（唯一写入口）。三段分开，是为了让"序号怎么来的"
   * 能在单测里被穷举，而不是埋在 IO 里。
   */
  async listSalesOrderNos() {
    const field = this.gateway.table?.('salesEntry')?.fields?.orderNo;
    // 字段映射缺失时读不到号；此时返回空列表，后续写单号会因
    //「未配置语义字段: orderNo」直接报错，而不是静默写一个空号。
    if (!field) return [];
    const records = await withSalesReadRetry(
      () => this.gateway.listAll('salesEntry'), 'sales_order_no_list',
    );
    return records.map((record) => textValue(record.fields?.[field])).filter(Boolean);
  }

  /**
   * 创建销售主表记录，并在**同一处**生成 + 写入「销售单号」。
   *
   * 为什么集中在这一处：这是全仓库唯一创建销售主表记录的地方（退货/换货不建新单，
   * 它们沿用原销售单号）。单号只在这里生成一次，规则就不会散成两套；
   * 以后新增入口也必须走这里，否则又会回到"飞书不生成、代码也不生成"的空号状态。
   *
   * 为什么拿了号才建记录、撞号时改自己这条：createSalesEntryWithOrderNo 内部
   * 由 allocateSalesOrderNo 负责"读→算→写→写后复查"；真撞上并发时它会把号 +1 后
   * update 回**同一条**记录，不留下第二条记录，也不给退货/换货留下两个同号的"原单"。
   */
  async createSalesEntryWithOrderNo(task) {
    let created = null;
    const allocation = await allocateSalesOrderNo({
      readExistingNos: () => this.listSalesOrderNos(),
      writeOrderNo: async (orderNo) => {
        if (created) {
          await this.gateway.update('salesEntry', created.recordId, { orderNo });
          return;
        }
        created = await this.gateway.create('salesEntry', {
          originalText: task.original_text,
          sender: person(task.sender_open_id),
          parseStatus: '解析中',
          // 建单 = 还没轮到她做任何动作 → 「确认状态」= 未确认。
          // ⚠️ 旧「确认状态（旧）」从这次起**停写**（她确认过之后要删那一列）。
          userAction: WRITE.userAction.pending,
          orderNo,
        });
      },
      onCollision: ({ attempt, order_no: orderNo }) =>
        logWarn('sales.order_no.collision', { task_id: task.task_id, attempt, order_no: orderNo }),
    });
    logInfo('sales.order_no.generated', {
      task_id: task.task_id,
      sales_entry_record_id: created?.recordId,
      order_no: allocation.orderNo,
      sequence: allocation.sequence,
      // 当天已有单号的条数（只数「日期段 == 今天」的）：排查"这个号从哪来"时看它。
      today_count: allocation.todayCount,
      attempts: allocation.attempts,
    });
    return created;
  }

  async processSalesTask(taskId) {
    const startedAt = Date.now();
    logInfo('lark.sales.processing.started', { task_id: taskId });
    const task = await this.store.get(taskId);
    // 两张配置表都很小（配品十几条、在售券几条），先并行拿齐：
    // 配品清单交给 AI 是为了让它知道「39元腰带」这类说法不是鞋；
    // 券目录交给后端是为了按表里的平台结算款算钱，不再写死券种。
    const [accessories, vouchers] = await Promise.all([
      this.listAccessories(),
      this.listGroupBuyVouchers(),
    ]);
    // 交给 AI 的配品词表：名称 + 表里实际存在的「种类」。
    // 为什么要带上「种类」：用户嘴上说的是「鞋油」，而表里这条叫「15元鞋油」；
    // 只给名称，AI 可能认不出这是配品，后端新加的"按分类匹配"就永远轮不到。
    // 去重是因为「女士包」这类词既是名称又是分类。
    const accessoryVocabulary = [...new Set(
      accessories.flatMap((item) => [item.name, item.category]).filter(Boolean)
    )];
    // AI 解析是最慢的一段（十几秒），读实时库存和货品资料不依赖它的结果，所以三件事
    // **同时启动**：读表的时间藏在 AI 后面，不额外增加用户等待。
    //
    // 与改动前的区别只在"先 await 谁"：这里先只等 AI。查销售记录（退换货第一期）
    // 只需要 AI 判出的货号颜色 + 销售记录本身，不需要那两张表，所以一拿到意图就出卡片，
    // 不必陪着读完库存。销售链路仍然是三者并行，总耗时不变（都是 max(AI, 读表)）。
    const parsePromise = this.recognizer.parseSalesText(task.original_text, {
      taskId, accessoryNames: accessoryVocabulary, vouchers,
    });
    const liveInventoryPromise = this.loadLiveInventoryIndex();
    // 货品信息是主数据，整表读一次即可；读挂了也不影响录单，所以单独吞掉异常。
    const productIndexPromise = this.loadProductIndex().catch((error) => {
      logWarn('lark.sales.product_index.load_failed', { task_id: taskId, error: error.message });
      return null;
    });
    const parsed = await parsePromise;
    // 意图是「AI 输出」到「后端分支」的唯一契约，统一先收敛成注册表里的规范值：
    // 认不出来一律 unsupported，不会被误判成 sale 去写单（见 config/saleIntents）。
    const intent = normalizeMessageIntent(parsed.intent);

    // 查销售记录：只读 + 只展示，绝不写业务表（实现全在 SaleLookupService）。
    if (isLookupIntent(intent)) {
      // 这一次用不上的在途读取挂一个吞异常的 catch：不 await 它，但也不让它变成
      // unhandledRejection 把进程日志搞脏。
      liveInventoryPromise.catch(() => undefined);
      productIndexPromise.catch(() => undefined);
      // 把收敛后的 intent 一并传下去：SaleLookupService 只认规范值，不猜模型的措辞。
      const result = await this.saleLookup.handleQuery(task, { ...parsed, intent });
      // 第二期：把这次查到的候选按**人**记一份（跨消息、10 分钟有效），
      // 下一句「第 2 笔，退货」才定位得到（每条消息都是一个新任务）。
      // 这一步只是本地缓存，失败不影响查询结果，所以吞掉异常只记警告。
      await this.afterSalesFlow
        .rememberCandidates(task.sender_open_id, result?.candidates || [])
        .catch((error) => logWarn('after_sales.context.remember_failed', {
          task_id: taskId, error: error.message,
        }));
      return result;
    }
    // 退货 / 换货 / 赔货：真执行——先出确认卡片，她点确认后才调执行器
    // （编排全在 AfterSalesFlowService，本类只做这一行分派）。
    if (isAfterSalesIntent(intent)) {
      liveInventoryPromise.catch(() => undefined);
      productIndexPromise.catch(() => undefined);
      return this.afterSalesFlow.handle(task, { ...parsed, intent });
    }
    const [liveInventory, productIndex] = await Promise.all([liveInventoryPromise, productIndexPromise]);
    // 走到这里已经过了入口闸门（不含数字也不含业务关键词的消息更早被静默挡掉），
    // 只是 AI 认不出意图 —— 所以这里**可以**回一句引导语，把"能说什么"教给她。
    // ⚠️ 引导语只在这一档发；闸门没过的消息一律不回，不允许在这条链路上"兜底回复"。
    if (intent !== 'sale') {
      await this.store.update(taskId, { status: 'ignored', draft: parsed });
      logInfo('lark.sales.processing.ignored', {
        task_id: taskId,
        sender_open_id: task.sender_open_id,
        duration_ms: Date.now() - startedAt,
        reason: 'unsupported_intent',
        intent,
      });
      await this.sendText(task.sender_open_id, UNSUPPORTED_INTENT_REPLY);
      return;
    }

    await this.ensureIntakeSchema('sales_intake', ['salesEntry']);
    const created = await this.createSalesEntryWithOrderNo(task);
    const salesEntryRecordId = created?.recordId;
    if (!salesEntryRecordId) throw new Error('销售主表未返回 record_id');
    await this.store.update(taskId, { sales_entry_record_id: salesEntryRecordId, status: 'parsing' });

    const missingFields = [...(parsed.missing_fields || [])];
    // 缺货单独收集：这类问题只需要一句"请核实"，不需要"销售信息还缺…请补充后重新发送"
    // 那层流程说明——那层话对"这个尺码店里没有"这件事没有任何帮助。
    const shortageNotes = [];
    const items = [];
    for (const [index, item] of (parsed.items?.length ? parsed.items : [parsed]).entries()) {
      const itemQuantity = Number(item.quantity || 1);
      const quantityIssue = `第${index + 1}件请逐双列出成交金额；每条销售明细只能记录一双`;
      if (itemQuantity !== 1 && !missingFields.includes(quantityIssue)) missingFields.push(quantityIssue);
      if (item.kind === 'accessory') {
        // 配品先按「种类」找，找不到再退回按名称精确匹配（见 accessoryMatchPolicy）。
        // 为什么不能只按名称精确匹配：表里叫「15元鞋油」，用户说的是「鞋油」，
        // 精确匹配必然失败，于是"配品明明有，系统却说没有"。
        // 用**她说的价位**（tier_price）去对多档（腰带 9 档）里是哪一条记录：
        // 这个价位只用于定位记录，**不是成交金额**（119 的腰带收了 100，成交就是 100）。
        // 她说价位时模型放在 tier_price 里；只说了一个数（老形状）时退回 actual_amount，
        // 后者在解析层已被换成实收，所以优先 tier_price。
        const spoken = String(item.accessory_name || '').trim();
        const resolved = resolveAccessory({
          spoken, amount: item.tier_price || item.actual_amount, accessories,
        });
        if (!resolved.match) {
          missingFields.push(`第${index + 1}件：${resolved.issue}`);
        }
        items.push({ ...item, quantity: itemQuantity, accessory_record_id: resolved.match?.record_id || '' });
        continue;
      }
      // 鞋按「实时库存」匹配：颜色、有没有货、是门盒还是样品，都从"店里实际有什么"回答，
      // 而不是先看货品资料——货品资料只是"配置过什么"，卖的是实物。
      let productRecordId = '';
      let color = '';
      let colorOptions = null;
      let stock = null;
      let samplePlan = null;
      if (item.item_no && item.size) {
        const found = liveInventory.find({ itemNo: item.item_no, size: item.size });
        if (!found.colors.length) {
          // 缺货只回这一句：哪一双没有 + 这个货号现在有哪些码 + 请核实。
          // 不加"销售信息还缺…请补充后重新发送完整销售信息"那层流程说明——
          // 对她核实这件事没有任何帮助。
          const available = (found.otherSizes || [])
            .filter((entry) => Number(entry.total) > 0)
            .map((entry) => entry.size);
          const shortage = `库存里没有 ${item.item_no} ${item.size}码（${available.length
            ? `这个货号现在有 ${available.join('、')}码`
            : '这个货号现在一双都没有'}）`;
          shortageNotes.push(shortage);
          missingFields.push(shortage);
        } else if (found.colors.length === 1) {
          const [only] = found.colors;
          productRecordId = only.productRecordId;
          color = only.color;
          stock = { doorBox: only.doorBox, sample: only.sample, warehouse: only.warehouse };
          samplePlan = this.samplePlanFor({ productRecordId, stock, quantity: itemQuantity }, liveInventory);
        } else {
          // 这个货号在这个尺码上有多个颜色：不猜，把候选交给确认卡片让用户点。
          // 补样品方案按颜色预先算好——颜色定了才谈得上"用哪个门盒补"，
          // 预先算可以把这一次库存读取省下来。
          colorOptions = found.colors.map((entry) => {
            const optionStock = { doorBox: entry.doorBox, sample: entry.sample, warehouse: entry.warehouse };
            return {
              recordId: entry.productRecordId,
              color: entry.color,
              number: `${item.item_no}${entry.color}`,
              stock: optionStock,
              sample_plan: this.samplePlanFor(
                { productRecordId: entry.productRecordId, stock: optionStock, quantity: itemQuantity }, liveInventory,
              ),
            };
          });
        }
      }
      items.push({
        ...item,
        quantity: itemQuantity,
        product_record_id: productRecordId,
        color,
        // 展示用编号：货号 + 颜色——实时库存里就是用这两个要素定位一双鞋。
        product_number: productRecordId ? `${item.item_no}${color}` : '',
        ...(colorOptions ? { needs_color: true, color_options: colorOptions } : {}),
        ...(stock ? { stock } : {}),
        ...(samplePlan || {}),
      });
    }
    // 货品资料缺口：从**已经读好的**索引里算，不再请求远端。
    const productInfoGaps = this.productInfoGapsFromIndex(items, productIndex);

    const actualTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount || 0), 0) * 100) / 100;
    if (!parsed.voucher_policy_blocked && items.some((item) => !Number(item.actual_amount))) missingFields.push('请逐件说明成交金额');
    if (parsed.agreed_total && Math.abs(actualTotal - Number(parsed.agreed_total)) > 0.005) {
      missingFields.push('逐件成交金额合计与整单成交金额不一致');
    }
    if (!parsed.voucher_policy_blocked && Number(parsed.total_covered ?? parsed.total_paid ?? 0) > actualTotal) {
      missingFields.push('已收金额和待平台结算金额不能超过本单成交金额');
    }

    // 交易类型由 AI 从原话判断；**交付状态由注册表从交易类型推出来**，
    // 不再让用户在卡片上选。现货/未付当场交付，只有预付（只付定金、货没拿走）是未交付。
    const tradeTypeCode = tradeTypeCodeFromLabel(parsed.trade_type);
    const draft = {
      ...parsed,
      product_info_gaps: productInfoGaps,
      trade_type: parsed.trade_type,
      trade_type_code: tradeTypeCode,
      delivery_status: deliveryForTradeType(tradeTypeCode) || '已交付',
      product_number: items[0]?.product_number || '',
      items,
      missing_fields: missingFields,
    };
    // 交易类型落成关联「行为管理」的记录，便于以后筛选和对账。
    // 解析不到时记警告但**不阻塞入账**：它只是审计字段，业务事实（交付与收款）
    // 已经由 trade_type 决定，不该因为一个关联查不到就让门店录不进单。
    let tradeTypeRecordId = '';
    if (tradeTypeCode && typeof this.references.resolveSalesTradeType === 'function') {
      try {
        tradeTypeRecordId = (await this.references.resolveSalesTradeType(tradeTypeCode)).recordId;
      } catch (error) {
        logWarn('lark.sales.trade_type.resolve_failed', {
          task_id: taskId, code: tradeTypeCode, error: error.message,
        });
      }
    }
    await this.gateway.update('salesEntry', salesEntryRecordId, {
      parseStatus: draft.missing_fields?.length ? '需补充' : '解析成功',
      parseSummary: JSON.stringify(draft),
      failureReason: draft.missing_fields?.length ? draft.missing_fields.join('、') : '',
      ...(tradeTypeRecordId ? { tradeType: relation(tradeTypeRecordId) } : {}),
    });
    await this.store.update(taskId, {
      status: draft.missing_fields?.length ? 'needs_info' : 'ready_to_confirm',
      draft,
    });
    if (draft.missing_fields?.length) {
      // 这一单的问题**只有缺货**时，直接回一句短的；还夹杂别的问题（金额缺失等）时才用完整说明。
      const onlyShortage = shortageNotes.length > 0 && shortageNotes.length === draft.missing_fields.length;
      await this.sendText(task.sender_open_id, onlyShortage
        ? `${shortageNotes.join('、')}，请核实～`
        : `销售信息还缺：${draft.missing_fields.join('、')}。请补充后重新发送完整销售信息。`);
      return;
    }
    const cardStartedAt = Date.now();
    const cardMessageId = await this.replyCard(task.message_id, salesConfirmationCard(taskId, draft));
    logInfo('lark.sales.card.sent', {
      task_id: taskId, stage: 'confirmation',
      duration_ms: Date.now() - cardStartedAt,
      // 她感知到的"从发消息到看见卡片"就是这个数；单看它比看各段之和更准。
      since_message_ms: Date.now() - startedAt,
    });
    if (cardMessageId) await this.store.update(taskId, { card_message_id: cardMessageId });
    logInfo('lark.sales.processing.completed', {
      task_id: taskId,
      sales_entry_record_id: salesEntryRecordId,
      item_count: items.length,
      // 从"收到消息"到"卡片发出去"——用户实际等的时间。各段耗时之和可以比它大，
      // 因为并行的几段是重叠的；校准优化效果应该看这个数。
      user_wait_ms: Date.now() - startedAt,
      duration_ms: Date.now() - startedAt,
      result: 'awaiting_confirmation',
    });
  }

  async handleCardAction(event, context = {}) {
    const value = event?.action?.value || event?.event?.action?.value || {};
    const draftId = value.draft_id;
    const action = value.action;
    const operatorOpenId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    if (['choose_sample_replacement', 'refresh_sample_replacement'].includes(action)) {
      return this.sampleReplacements.handleCardAction(value, event, operatorOpenId, context);
    }
    // 「采购到货核对」卡片的「是 / 否」。
    // ⚠️ 位置有意放在这里（采购申请卡片分派**之前**、下面那句 `if (!draftId) throw` 之前）：
    //   这张卡片也带 draft_id（= 到货核对任务 id，不是销售草稿），落到下面那套销售逻辑里
    //   一定会报「卡片缺少草稿 ID」或更糟——把别人的草稿当成自己的。
    //   动作名与卡片渲染共用 config 里的同一份常量。
    if ([ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, ARRIVAL_CONVERSATION_ACTIONS.REJECT].includes(action)) {
      return this.arrivalConversation.handleCardAction(value, event, operatorOpenId);
    }
    const procurementResult = await this.purchaseWebhooks.handleCardAction(value, operatorOpenId, event);
    if (procurementResult) return procurementResult;
    // 「第二次交付」的「成交」按钮：收尾的是**已入账**的未付 / 预付单。
    // ⚠️ 位置有意放在这里——采购分派之后（它只认自己的动作名，我们的动作会返回 null）、
    // 下面那句 `if (!draftId) throw` 之前：这条链路绑的是销售主表 record_id，
    // 根本没有草稿，也没有草稿状态机，落在下面那套逻辑里一定抛「卡片缺少草稿 ID」。
    // 动作名用 larkCards 里那一个常量，卡片和分派不会各写一份而慢慢写歪。
    if (action === SECOND_DELIVERY_ACTION) {
      return this.handleSecondDeliveryAction(value, operatorOpenId, event);
    }
    if (!draftId) throw new Error('卡片缺少草稿 ID');
    // 售后卡片：确认 / 取消 / 选回库状态。和销售草稿共用同一个串行队列
    // （同一张卡片连点两次会被排成一前一后），执行器那一层再兜一次幂等。
    if (isAfterSalesCardAction(action)) {
      return this.cardActionQueue.run(draftId, () =>
        this.afterSalesFlow.handleCardAction(value, event, operatorOpenId, context));
    }
    return this.cardActionQueue.run(draftId, () => this.handleSalesOrLegacyCardAction(event, context));
  }

  /**
   * 「成交」：已入账的未付 / 预付单收尾（补收款 + 交付）。
   *
   * 这里只做三件事：把按钮带上来的「销售单号 + 收款方式」转给编排服务，
   * 把"点的是哪条群消息、哪天的卡"一起带下去（成交成功后要把那张卡的这一单变灰，
   * 见 SecondDeliveryService.markCardSettled），以及把结果说成她能看懂的一句话。
   * 写账、扣库存全在 SecondDeliveryService 里，本类不碰——那两件事都必须只有一处实现。
   */
  async handleSecondDeliveryAction(value, operatorOpenId, event = {}) {
    const result = await this.secondDelivery.confirm({
      salesEntryRecordId: value?.sales_entry_record_id,
      // 收款方式由按钮带上来的，缺了会让补收款明确报错，不在这里兜一个默认值。
      method: value?.method,
      operatorOpenId,
      // 卡片回调事件里的消息 id = 被点的那张卡；reminder_day 是发卡时写进按钮取值的。
      cardMessageId: event?.context?.open_message_id || event?.open_message_id || '',
      reminderDay: value?.reminder_day || '',
    });
    if (result.alreadyCompleted) {
      return { toast: { type: 'info', content: '这一单已经成交，无需重复处理' } };
    }
    const parts = [];
    if (result.collectedAmount > 0) parts.push(`补收款 ￥${result.collectedAmount}`);
    const deliveredCount = Number(result.delivery?.deliveredQuantity || 0);
    if (result.delivery && deliveredCount > 0) parts.push(`交付 ${deliveredCount} 双`);
    const failedCount = result.delivery?.failures?.length || 0;
    if (failedCount) {
      // 钱已经收下、货只交了一部分：如实说清，并指到工作台去处理，不能报成功。
      return { toast: { type: 'warning', content:
        `已成交：${parts.join('，')}；还有 ${failedCount} 双交付未完成，请到工作台待交付列表核对` } };
    }
    return { toast: { type: 'success', content: `已成交：${parts.join('，') || '无待处理项'}` } };
  }

  async handleSalesOrLegacyCardAction(event, context = {}) {
    const value = event?.action?.value || event?.event?.action?.value || {};
    const draftId = value.draft_id;
    const action = value.action;
    const operatorOpenId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    const task = await this.store.get(draftId);
    if (!task) throw new Error('确认草稿不存在或已过期');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由原始发送人确认该草稿');
    if (['posted', 'posted_delivery_pending', 'cancelled'].includes(task.status)) {
      if (task.type === 'sale') {
        const completed = task.status === 'posted';
        const card = salesStatusCard(task.draft,
          task.status === 'cancelled' ? '销售录单已取消' : completed ? '销售订单已入账' : '订单已入账，交付待核对',
          task.status === 'cancelled' ? '原草稿不会入账。' :
            `销售单号：${task.posting_result?.sourceNo || '请在销售主表核对'}；${completed
              ? shouldDeliverFor(task, task.posting_requested_action) ? '已交付并扣库存。' : '尚未交付，库存未扣减。'
              : '交付结果尚未确认，请到工作台核对。'}`,
          task.status === 'cancelled' ? 'blue' : completed ? 'green' : 'orange');
        await this.publishSalesResultCard(task, event, card,
          { stage: 'duplicate_terminal', interactionId: context.interactionId });
      }
      return { toast: { type: 'info', content: task.status === 'posted_delivery_pending'
        ? '订单已入账，交付结果请在工作台核对' : '该草稿已处理' } };
    }
    if (task.status === 'posting') return { toast: { type: 'info', content: '正在入账，请勿重复点击' } };
    if (task.status === 'awaiting_correction' && action !== 'cancel') {
      return { toast: { type: 'info', content: '该草稿正在等待修正，请重新发送完整销售信息' } };
    }
    const hasWrittenSaleRecords = task.type === 'sale' && (task.posting_records_written === true ||
      Object.values(task.posting_record_ids || {}).some((ids) => Array.isArray(ids) && ids.some(Boolean)));
    if (hasWrittenSaleRecords && ['cancel', 'modify_sale'].includes(action)) {
      return { toast: { type: 'warning', content: '这张销售单已有明细或收款，不能直接取消或修改；请先核对现有记录' } };
    }
    if (hasWrittenSaleRecords && ['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      task.posting_requested_action && action !== task.posting_requested_action) {
      return { toast: { type: 'warning', content: '请沿用原来的交付选择继续处理这张销售单' } };
    }

    if (action === 'cancel') {
      await this.store.update(draftId, { status: 'cancelled' });
      if (task.type === 'sale' && task.sales_entry_record_id) {
        await this.salesStatus.write(task.sales_entry_record_id, { userAction: WRITE.userAction.cancelled });
        await this.publishSalesResultCard(task, event, salesStatusCard(task.draft, '销售录单已取消', '原草稿不会入账。'),
          { stage: 'cancelled', interactionId: context.interactionId });
      }
      return { toast: { type: 'info', content: '已取消' } };
    }

    if (action === 'modify_sale' && task.type === 'sale') {
      await this.store.update(draftId, { status: 'awaiting_correction' });
      if (task.sales_entry_record_id) {
        await this.salesStatus.write(task.sales_entry_record_id, { userAction: WRITE.userAction.toModify });
      }
      await this.publishSalesResultCard(task, event, salesStatusCard(task.draft, '等待重新发送', '原草稿不会入账；请重新发送完整销售信息。', 'orange'),
        { stage: 'awaiting_correction', interactionId: context.interactionId });
      await this.sendText(operatorOpenId, '请重新发送一条完整、正确的销售信息；原草稿不会入账。').catch((error) =>
        logWarn('lark.sales.feedback.failed', { task_id: draftId, interaction_id: context.interactionId, error: error.message }));
      return { toast: { type: 'info', content: '请重新发送修正后的完整销售信息' } };
    }

    if (action === 'choose_sale_sample_replacement' && task.type === 'sale') {
      const itemIndex = Number(value.item_index);
      const items = (task.draft?.items || []).map((item) => ({ ...item }));
      const item = items[itemIndex];
      if (!item) throw new Error('找不到要补样品的明细');
      if (!item.needs_sample_replacement) throw new Error('这一双不需要补样品');
      const size = Number(value.size);
      const option = (item.sample_replacement_options || []).find((row) => Number(row.size) === size);
      if (!option) throw new Error('补样品的尺码不在候选里，请刷新卡片后重试');
      items[itemIndex] = { ...item, sample_replacement_size: size };
      const draft = { ...task.draft, items };
      await this.store.update(draftId, { draft, status: 'ready_to_confirm' });
      await this.publishSalesResultCard({ ...task, draft }, event, salesConfirmationCard(draftId, draft),
        { stage: 'sample_replacement_chosen', interactionId: context.interactionId });
      logInfo('lark.sales.sample_replacement.chosen', {
        task_id: draftId, item_index: itemIndex, size,
      });
      return { toast: { type: 'success', content: `第 ${itemIndex + 1} 双将用 ${size}码的门盒补样品` } };
    }

    if (action === 'choose_sale_color' && task.type === 'sale') {
      const itemIndex = Number(value.item_index);
      const items = (task.draft?.items || []).map((item) => ({ ...item }));
      const item = items[itemIndex];
      if (!item) throw new Error('找不到要设置颜色的明细');
      if (!value.record_id) throw new Error('卡片里缺少颜色记录 ID');
      // 用户在卡片上选定颜色：这一条明细的货品就此确定，不再需要选色。
      // 库存分布也跟着候选一起带过来——颜色定了，才知道这个颜色在店里有几双。
      const chosen = (item.color_options || []).find((option) => option.recordId === value.record_id);
      items[itemIndex] = {
        ...item,
        product_record_id: value.record_id,
        product_number: value.product_number || item.product_number || item.item_no || '',
        ...(chosen?.stock ? { stock: chosen.stock } : {}),
        // 颜色定了才知道"卖的是不是样品"：补样品方案随候选一起带过来。
        ...(chosen?.sample_plan || {}),
        needs_color: false,
        color_options: [],
      };
      const draft = { ...task.draft, items };
      await this.store.update(draftId, { draft, status: 'ready_to_confirm' });
      await this.publishSalesResultCard({ ...task, draft }, event, salesConfirmationCard(draftId, draft),
        { stage: 'color_chosen', interactionId: context.interactionId });
      logInfo('lark.sales.color.chosen', { task_id: draftId, item_index: itemIndex,
        product_record_id: value.record_id, color: value.color_name });
      return { toast: { type: 'success', content: `第 ${itemIndex + 1} 双的颜色已设为「${value.color_name || ''}」` } };
    }

    // 颜色是入账的必要信息：还有明细没选颜色就不许确认。卡片上会给出候选让用户点选。
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      (task.draft?.items || []).some((item) => item.needs_color)) {
      return { toast: { type: 'warning', content: '还有明细没选颜色，请先在卡片上选择颜色，再确认订单' } };
    }
    // 卖的是样品时同样要先选完"用哪个门盒补"，否则确认后还得再来一次。
    // 跟颜色用同一条规矩：卡片上的必选项没定，不入账。
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      (task.draft?.items || []).some((item) => item.needs_sample_replacement && !item.sample_replacement_size)) {
      return { toast: { type: 'warning', content: '这一单里有样品要补，请先在卡片上选补哪个门盒，再确认' } };
    }

    await this.store.update(draftId, { status: 'posting',
      ...(task.type === 'sale' ? { posting_requested_action: hasWrittenSaleRecords
        ? task.posting_requested_action || action : action } : {}) });
    try {
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
      // 交付与否由**交易类型**决定，不由用户点哪个按钮决定。
      // 卡片上只留一个「确认」；旧卡片上的 confirm_sale_delivered / _pending 仍然兼容。
      const shouldDeliver = shouldDeliverFor(task, action);
      const cardUpdated = await this.updateSalesActionCard(task, event,
        salesStatusCard(task.draft, '销售订单处理中', '已收到确认，正在写入销售记录和收款；请勿重复点击。'),
        { stage: 'processing', interactionId: context.interactionId });
      if (!cardUpdated) await this.sendText(operatorOpenId, '已收到确认，正在写入销售记录和收款，请稍候。').catch((error) =>
        logWarn('lark.sales.feedback.failed', { task_id: draftId, interaction_id: context.interactionId, error: error.message }));
      // ⭐ 她**点了「确认」**这件事本身要落表（今天完全没有这一笔）：
      //   「确认状态」= 已确认。放在入账**之前**写，是因为她点过是既成事实——
      //   后面入账成功与否由「资金状态」表达，不该把她的动作也一起抹掉。
      //   写失败只记警告（SalesStatusWriter 不抛），不能因为记进度挡住入账。
      await this.salesStatus.write(task.sales_entry_record_id, { userAction: WRITE.userAction.confirmed });
      const startedAt = Date.now();
      const result = await this.posting.postSale({
        salesEntryRecordId: task.sales_entry_record_id,
        knownRecordIds: task.posting_record_ids,
        knownFinancialComplete: task.posting_records_written === true,
        onRecordPersisted: async (kind, index, recordId) => {
          const current = await this.store.get(draftId);
          const ids = { ...(current?.posting_record_ids || {}) };
          const kindIds = [...(ids[kind] || [])];
          kindIds[index] = recordId;
          await this.store.update(draftId, { posting_record_ids: { ...ids, [kind]: kindIds } });
        },
        operatorOpenId,
        paymentMethod: task.draft.payment_method,
        totalPaid: task.draft.total_paid,
        // 她明说的欠款金额（没提欠就是空）：入账服务只有拿到它才会补未收款，
        // 所以这里必须原样透传，不能自己用"成交 − 已收"算一个出来。
        owed: task.draft.owed,
        payments: (task.draft.payments || []).map((payment) => ({
          amount: payment.amount, method: payment.method, status: payment.status, operatorOpenId,
        })),
        items: task.draft.items.map((item) => ({
          kind: item.kind,
          productRecordId: item.product_record_id,
          accessoryRecordId: item.accessory_record_id,
          itemNo: item.item_no,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
          actualAmount: item.actual_amount,
          gift: item.gift,
          giftDescription: item.gift_description,
        })),
      });
      await this.store.update(draftId, { status: 'posted_delivery_pending', posting_result: result });
      if (shouldDeliver) {
        try {
          const deliveryResult = await this.delivery.deliver({ salesEntryRecordId: task.sales_entry_record_id,
            detailRecordIds: result.detailRecordIds, paymentRecordIds: result.paymentRecordIds });
          // 卡片上已经选好"用哪个门盒补样品"的，在这里直接补掉，不再为它另发一张卡片。
          // 补失败不阻断入账：库存已经扣了，补样品失败只影响展示样品，交给工作台处理。
          const handledSampleDetails = await this.applyChosenSampleReplacements(task, result).catch((error) => {
            logWarn('lark.sales.sample_replacement.apply_failed', { task_id: draftId, error: error.message });
            return new Set();
          });
          await this.notifySampleReplacements(deliveryResult, operatorOpenId,
            { handledDetailIds: handledSampleDetails }).catch((error) =>
            logWarn('lark.sales.sample_notice.failed', { task_id: draftId, error: error.message }));
          if (deliveryResult.failures?.length) {
            await this.store.update(draftId, { delivery_failures: deliveryResult.failures });
            const failedLines = deliveryResult.failures.map((failure) => {
              const item = task.draft.items[failure.lineNumber - 1] || {};
              const label = `${item.product_number || `${item.item_no || '货品'}${item.color || ''}`}${failure.size}码`;
              return `第${failure.lineNumber}双 ${label}：${failure.error}`;
            }).join('；');
            await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
              deliveryResult.deliveredQuantity ? '订单已入账，部分交付' : '订单已入账，交付待处理',
              `销售单号：${result.sourceNo}。已交付 ${deliveryResult.deliveredQuantity}/${deliveryResult.totalQuantity} 双；未交付：${failedLines}。请到工作台待交付列表核对并处理。`, 'orange'),
            { stage: 'delivery_partial', interactionId: context.interactionId });
            logWarn('lark.sales.delivery.partial', { task_id: draftId, source_no: result.sourceNo,
              delivered_quantity: deliveryResult.deliveredQuantity, total_quantity: deliveryResult.totalQuantity,
              failed_detail_ids: deliveryResult.failures.map((failure) => failure.detailRecordId) });
            return { toast: { type: 'warning', content:
              `订单已入账，已交付 ${deliveryResult.deliveredQuantity}/${deliveryResult.totalQuantity} 双；其余待处理` } };
          }
        } catch (error) {
          await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
            '订单已入账，交付待处理', `销售单号：${result.sourceNo}。库存交付未完成：${error.message}。请在工作台待交付列表核对并处理。`, 'orange'),
          { stage: 'delivery_failed', interactionId: context.interactionId });
          logError('lark.sales.delivery.failed', { task_id: draftId, error: error.message });
          return { toast: { type: 'warning', content: '订单已入账，库存交付待处理' } };
        }
      }
      await this.store.update(draftId, { status: 'posted', posting_result: result });
      await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
        '销售订单已入账', `销售单号：${result.sourceNo}；${result.detailRecordIds?.length || 0} 条明细已写入。${shouldDeliver ? '已交付并扣库存。' : '尚未交付，库存未扣减。'}`, 'green'),
      { stage: 'posted', interactionId: context.interactionId });
      logInfo('lark.sales.posting.completed', {
        task_id: draftId,
        source_no: result.sourceNo,
        detail_count: result.detailRecordIds?.length || 0,
        duration_ms: Date.now() - startedAt,
        result: 'posted',
      });
      return {
        toast: {
          type: 'success',
          content: shouldDeliver ? '销售已确认并交付，库存已更新' : '销售已确认；预付单尚未交付，库存未扣减',
        },
      };
    }

    throw new Error(`不支持的卡片动作: ${action}`);
    } catch (error) {
      // Posting services are idempotent. Restore the draft so a corrected configuration or
      // transient Feishu failure can be retried from the same card instead of staying stuck.
      const waitingForSync = error.saleRecordsWritten === true || task.posting_records_written === true;
      await this.store
        .update(draftId, { status: 'ready_to_confirm', posting_error: error.message,
          posting_records_written: waitingForSync })
        .catch(() => undefined);
      if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
        const retryCard = salesConfirmationCard(draftId, task.draft);
        const reason = isDataNotReady(error) ? '飞书数据暂未就绪' : error.message;
        const current = await this.store.get(draftId);
        const hasWrittenRecords = waitingForSync || Object.values(current?.posting_record_ids || {})
          .some((ids) => Array.isArray(ids) && ids.some(Boolean));
        if (hasWrittenRecords) {
          // 重试卡片只留"继续处理这一单"那一个按钮。旧卡片上的交付动作名
          // （confirm_sale_delivered / _pending）现在统一对应新的「确认」。
          const requestedAction = current?.posting_requested_action || action;
          const retryAction = ['confirm_sale_delivered', 'confirm_sale_pending'].includes(requestedAction)
            ? 'confirm_sale' : requestedAction;
          // 卡片按钮已从 `action` 换成 `column_set`（移动端实测，见 larkCards.buttonColumns 的注释），
          // 所以不能再按 tag === 'action' 找按钮；收窄规则不变，交给 larkCards 里的结构遍历。
          keepOnlyCardButton(retryCard, retryAction);
        }
        retryCard.elements.splice(1, 0, { tag: 'note', elements: [
          { tag: 'plain_text', content: waitingForSync
            ? `销售明细和收款已记录，但进度同步尚未完成，库存未扣。${reason}；请稍后在原卡片重试，不要重新发送销售。`
            : `入账失败；可能已有部分记录，库存未扣。${reason}；请核对后在原卡片重试，不要重新发送销售。` },
        ] });
        await this.publishSalesResultCard(task, event, retryCard,
          { stage: 'retryable', interactionId: context.interactionId });
        logError('lark.sales.posting.retryable', { task_id: draftId,
          records_written: waitingForSync, error: error.message });
        return { toast: { type: 'warning', content: waitingForSync
          ? '销售记录已写入，进度待同步；库存未扣，请稍后在原卡片重试'
          : '销售尚未完成，请核对原卡片后重试；不要重新发送销售' } };
      }
      throw error;
    }
  }

  async handleTaskFailure(taskId, error) {
    const task = await this.store.get(taskId);
    if (task) {
      await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
      await this.sendText(task.sender_open_id, `处理失败：${error.message}`).catch(() => undefined);
    }
    logError('lark.mvp.task.failed', { task_id: taskId, error: error.message });
  }
}

module.exports = {
  LarkMvpService,
  aggregateRecognizedItems,
  idFor,
  looksLikeSalesText,
  parseContent,
};
