const crypto = require('node:crypto');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { updateInteractiveCard } = require('../infrastructure/interactiveCardFeedback');
const { InventoryService } = require('./inventoryService');
const { textValue } = require('./v1BitableGateway');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { sampleReplacementCard, sampleReplacementStatusCard, sampleReplacementProcessingCard } = require('../utils/larkCards');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { larkLogger } = require('../utils/larkLogger');
const { skipNoGroupContext } = require('../utils/privateChatSend');
// 🔴 2026-10-07「私聊链路移除」：本 service 里**一行主动私聊都没有了**——
// 原来那两个"回落 `task.sender_open_id`"的缺省出口已整体删除（见构造函数里的注释）。

const taskIdFor = (salesDetailRecordId) =>
  `sample_${crypto.createHash('sha256').update(String(salesDetailRecordId)).digest('hex').slice(0, 20)}`;

class SampleReplacementService {
  constructor({ gateway, inventory, store, client, updateCard,
    sendCardToTask, sendTextToTask } = {}) {
    if (!gateway) throw new Error('SampleReplacementService requires gateway');
    this.gateway = gateway;
    this.inventory = inventory || new InventoryService({ gateway });
    this.store = store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id',
    });
    this.cardActionQueue = new KeyedSerialQueue();
    if (!updateCard && !client) {
      const { appId, appSecret } = getLarkAgentCredentials();
      client = new lark.Client({ appId, appSecret, logger: larkLogger });
    }
    this.updateCard = updateCard || ((task, event, card, metadata = {}) => updateInteractiveCard({
      client, task, event, card, stage: metadata.stage, interactionId: metadata.interactionId,
      eventPrefix: 'lark.sales.sample_card.update',
    }));
    // ── ⭐ 渠道感知的出口（"把私聊专属的切出来"这一步）────────────────────────
    // 目标形态（业务负责人 2026-10-06：「后续就不走私聊了，你私聊的要切除出来」）：
    //   任务带渠道上下文时，由**注入方**（`larkMvpService` 的适配器）决定回到哪个群话题；
    //   没有群上下文 → 走这里的**缺省分支**。
    //
    // ⚠️ 边界：本 service **不认识** `reply_in_thread` / `chat_id` 这些飞书语义——
    //    飞书语义只留在 `larkMvpService` 的适配器里；这里只交"这是哪个任务"。
    //
    // 🔴 2026-10-07「私聊链路移除」：本 service 里**一行主动私聊都没有了** ——
    //    原来那两个"缺省回落 `task.sender_open_id`"的分支（以及底层的
    //    `sendCard` / `sendText` 两个 open_id 发送器）已**整体删除**。
    //    业务负责人拍板的 ⓐ 就是「代码里一行私聊都不留」，见
    //    docs/private-chat-removal-decision-2026-10-07.md。
    //    没有群上下文 → **没有去处**：只记一条日志、返 `null`（调用方据此不记 `notice_sent`），
    //    一个远端调用都不做。
    //    ⚠️ 日志与返回值走**全仓唯一**的那份实现（`utils/privateChatSend`）：
    //      所有缺省出口的 skip 形状只有一份定义，避免"某个 service 又偷偷长出一条私聊路"。
    //    ⚠️ 为什么这两个**缺省**端口也要自己判一次（`larkMvpService` 那侧也判）：
    //      `routes/workbench.js` 是**自己 new** 这个 service 的（触发方没有群上下文），
    //      它用的是这两个缺省端口，**不经过** `larkMvpService` 的适配器。
    this.sendCardToTask = sendCardToTask || (async (task) => skipNoGroupContext('card', task));
    this.sendTextToTask = sendTextToTask || (async (task) => skipNoGroupContext('text', task));
  }

  async publishCard(task, event, card, metadata = {}) {
    if (await this.updateCard(task, event, card, metadata)) return true;
    try {
      // ⭐ 兜底也走**任务感知**的出口：卡片改不动时补发的那张卡，跟着任务去它该去的地方
      //   （群任务 → 那个话题；**没有群上下文** → 没有去处，出口返 `null`）。
      const messageId = await this.sendCardToTask(task, card);
      if (!messageId) {
        // 出口明确说"这条不发"（没有群上下文）→ **如实记**，别报"已补发"：
        // 报成功会让排查的人以为卡片发出去了（静默失效最难查）。
        logWarn('lark.sales.sample_card.fallback.skipped', { task_id: task.task_id,
          interaction_id: metadata.interactionId, stage: metadata.stage, reason: 'no_destination' });
        return false;
      }
      await this.store.update(task.task_id, { card_message_id: messageId });
      logInfo('lark.sales.sample_card.fallback.sent', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, card_message_id: messageId });
      return true;
    } catch (error) {
      logWarn('lark.sales.sample_card.fallback.failed', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, error: error.message });
      return false;
    }
  }

  /**
   * 「样品已售出 → 请补选」提醒。
   *
   * `channelTask`（**渠道感知入参**，可选）= **触发这次交付的那条任务**：
   *   · 群销售 → 传那条销售任务 → 卡片回到**那个话题**（走注入的 `sendCardToTask`）；
   *   · 工作台触发（`routes/workbench.js` 那条路）→ 没有群上下文 →
   *     出口**没有去处**：只记一条 `lark.private_chat.send_skipped`、返 `null`，一个远端调用都不做。
   *     ⚠️ 这是**有意的行为变化**（改动前是静默发私聊）—— 业务负责人 2026-10-07 拍板
   *     「代码里一行私聊都不留」，见 docs/private-chat-removal-decision-2026-10-07.md。
   *
   * ⚠️ `operatorOpenId` 是"**本次操作的人**"（工作台那条路根本没有 `channelTask`），
   *    **不拿它去当收件人**：本 service 里已经没有"发给某个 open_id"这种能力了。
   */
  async notifySampleReplacements(deliveryResult, operatorOpenId,
    { handledDetailIds = new Set(), channelTask = null } = {}) {
    if (!operatorOpenId) throw new Error('补选样品提醒缺少用户 open_id');
    for (const replacement of deliveryResult.sampleReplacements || []) {
      // 已经在确认卡片上选好并补掉的，不再发第二张卡片。
      if (handledDetailIds.has(replacement.salesDetailRecordId)) continue;
      const taskId = taskIdFor(replacement.salesDetailRecordId);
      let task = await this.store.get(taskId);
      if (task?.status === 'completed') continue;
      if (task?.card_message_id || task?.notice_sent) continue;
      const product = await this.gateway.get('product', replacement.productRecordId).catch(() => null);
      const productNumber = textValue(product?.fields?.[this.gateway.table('product').fields.number]) ||
        replacement.productRecordId;
      if (!task) {
        task = await this.store.create({ task_id: taskId, type: 'sample_replacement', status: 'pending',
          sender_open_id: operatorOpenId, sales_detail_record_id: replacement.salesDetailRecordId,
          product_record_id: replacement.productRecordId, product_number: productNumber,
          consumed_live_record_ids: replacement.consumedLiveRecordIds || [] });
      }
      let remainingSizes = [];
      let lookupFailed = false;
      try {
        remainingSizes = await this.inventory.sampleReplacementCandidates(replacement.productRecordId,
          { excludeRecordIds: replacement.consumedLiveRecordIds || [] });
      } catch (error) {
        lookupFailed = true;
        logWarn('lark.sales.sample_candidates.failed', { task_id: taskId, error: error.message });
      }
      // ⭐ 发到哪儿：有群上下文就走**那条任务**（出口据此回到它的话题）；
      //   没有群上下文（例：工作台触发）就用本任务 —— 而本任务也没有群字段时，
      //   出口**没有去处**：只记一条 `lark.private_chat.send_skipped`、返 `null`。
      //   ⚠️ 群那条必须把**销售任务**交出去、而不是补样品任务：出口会顺手记
      //   「话题 ↔ 销售」的本地路由映射，映射的 key 是**她那句话的 message_id**、
      //   值里带**那笔销售的 record_id** —— 拿补样品任务去记会把那条映射冲成空。
      const sendTarget = channelTask || task;
      try {
        const cardMessageId = await this.sendCardToTask(sendTarget,
          sampleReplacementCard(taskId, { productNumber, remainingSizes, lookupFailed }));
        // `null` = 出口**明确说"这条不发"**（没有群上下文）→ 不记 `notice_sent`：
        // 没发出去就不算发过，将来有了渠道还能再发一次。
        if (cardMessageId === null) continue;
        await this.store.update(taskId, { card_message_id: cardMessageId, notice_sent: true });
      } catch (error) {
        logWarn('lark.sales.sample_notice.failed', { task_id: taskId, error: error.message });
        await this.sendTextToTask(sendTarget,
          `${productNumber} 的样品已售出，但补选卡片发送失败；销售库存已扣减，请联系管理员核对补选任务。`).catch(() => undefined);
      }
    }
  }

  /**
   * 用户在确认卡片上已经选好"用哪个门盒补样品"时，直接在这里执行，
   * 不再另发一张补选卡片——她点一次确认就够了。
   *
   * 返回已处理的销售明细 ID，调用方据此跳过对应的补选提醒。
   */
  async applyPreChosen(replacements = []) {
    const handled = new Set();
    for (const { salesDetailRecordId, productRecordId, size } of replacements) {
      if (!salesDetailRecordId || !productRecordId || !size) continue;
      await this.inventory.promoteToSample({ salesDetailRecordId, productRecordId, size });
      handled.add(salesDetailRecordId);
      logInfo('lark.sales.sample_replacement.applied', {
        sales_detail_record_id: salesDetailRecordId, product_record_id: productRecordId, size,
      });
    }
    return handled;
  }

  async handleCardAction(value, event, operatorOpenId, context = {}) {
    const action = value?.action;
    if (!['choose_sample_replacement', 'refresh_sample_replacement'].includes(action)) return null;
    const draftId = value.draft_id;
    if (!draftId) throw new Error('补样品卡片缺少任务 ID');
    return this.cardActionQueue.run(draftId, () => this.handleCardActionUnlocked(value, event, operatorOpenId, context));
  }

  async handleCardActionUnlocked(value, event, operatorOpenId, context = {}) {
    const action = value.action;
    const draftId = value.draft_id;
    const task = await this.store.get(draftId);
    if (!task || task.type !== 'sample_replacement') throw new Error('补样品任务不存在');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由收到提醒的用户补选样品');
    if (task.status === 'completed') {
      await this.publishCard(task, event, sampleReplacementStatusCard(task.product_number,
        `${task.result?.size || '所选尺码'}已补作样品，库存总数不变。`),
      { stage: 'duplicate_terminal', interactionId: context.interactionId });
      return { toast: { type: 'info', content: '该样品已补选' } };
    }
    const size = action === 'choose_sample_replacement' ? Number(value.size) : null;
    if (action === 'choose_sample_replacement' && (!Number.isFinite(size) || size <= 0)) {
      throw new Error('补样品尺码无效');
    }
    const processing = await this.updateCard(task, event, sampleReplacementProcessingCard(task.product_number,
      action === 'refresh_sample_replacement' ? '正在刷新可选尺码，请稍候。' : '已收到选择，正在调整库存状态，请勿重复点击。'),
    { stage: 'processing', interactionId: context.interactionId });
    // 走到这里 `task.sender_open_id === operatorOpenId`（上面「只能由收到提醒的用户补选样品」
    // 那道鉴权保证了），
    // 所以换成**任务感知**的出口是逐字等价的 —— 但方向从"发给这个 open_id"变成
    // "发到这个任务该去的地方"（将来群任务就回它的话题）。
    if (!processing) await this.sendTextToTask(task, '已收到补样品操作，正在处理，请稍候。').catch((error) =>
      logWarn('lark.sales.sample_feedback.failed', { task_id: draftId,
        interaction_id: context.interactionId, error: error.message }));
    if (action === 'refresh_sample_replacement') {
      try {
        const remainingSizes = await this.inventory.sampleReplacementCandidates(task.product_record_id,
          { excludeRecordIds: task.consumed_live_record_ids || [] });
        const published = await this.publishCard(task, event,
          sampleReplacementCard(draftId, { productNumber: task.product_number, remainingSizes }),
        { stage: 'refreshed', interactionId: context.interactionId });
        return { toast: { type: published ? 'info' : 'warning', content: published
          ? '可选尺码已刷新' : '尺码已查询，但卡片更新失败，请稍后重试' } };
      } catch (error) {
        logWarn('lark.sales.sample_refresh.failed', { task_id: draftId,
          interaction_id: context.interactionId, error: error.message });
        const retryCard = sampleReplacementCard(draftId, { productNumber: task.product_number, lookupFailed: true });
        retryCard.elements.unshift({ tag: 'note', elements: [{ tag: 'plain_text',
          content: `刷新尺码失败：${error.message}。请点击刷新重试。` }] });
        await this.publishCard(task, event, retryCard,
          { stage: 'refresh_retryable', interactionId: context.interactionId });
        return { toast: { type: 'warning', content: `刷新尺码失败：${error.message}` } };
      }
    }
    try {
      const result = await this.inventory.promoteToSample({
        salesDetailRecordId: task.sales_detail_record_id,
        productRecordId: task.product_record_id, size,
      });
      await this.store.update(draftId, { status: 'completed', result });
      await this.publishCard(task, event,
        sampleReplacementStatusCard(task.product_number, `${size}码已从门盒转为样品，库存总数不变。`),
      { stage: 'completed', interactionId: context.interactionId });
      return { toast: { type: 'success', content: `${task.product_number} ${size}码已补作样品` } };
    } catch (error) {
      logError('lark.sales.sample_promotion.failed', { task_id: draftId, error: error.message });
      let lookupFailed = false;
      const remainingSizes = await this.inventory.sampleReplacementCandidates(task.product_record_id,
        { excludeRecordIds: task.consumed_live_record_ids || [] }).catch(() => {
          lookupFailed = true;
          return [];
        });
      const retryCard = sampleReplacementCard(draftId,
        { productNumber: task.product_number, remainingSizes, lookupFailed });
      retryCard.elements.unshift({ tag: 'note', elements: [{ tag: 'plain_text',
        content: `补选未完成：${error.message}。请核对后重试。` }] });
      await this.publishCard(task, event, retryCard,
        { stage: 'retryable', interactionId: context.interactionId });
      return { toast: { type: 'warning', content: `补选未完成：${error.message}` } };
    }
  }
}

module.exports = { SampleReplacementService };
