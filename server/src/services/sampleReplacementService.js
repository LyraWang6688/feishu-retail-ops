const crypto = require('node:crypto');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { updateInteractiveCard } = require('../infrastructure/interactiveCardFeedback');
const { InventoryService } = require('./inventoryService');
const { textValue } = require('./v1BitableGateway');
const { getLarkAgentCredentials } = require('../config/larkAgent');
// ⭐ 2026-10-28：`sampleReplacementStatusCard` / `sampleReplacementProcessingCard` 随**卡片按钮回调**
//   （`handleCardAction`，本轮删除）一起退场 —— 线上已经没有交互卡片了。
//   仍然保留的是「样品已售出 → 请补选」那张卡（`sampleReplacementCard`，工作台链路的提醒在用）。
const { sampleReplacementCard } = require('../utils/larkCards');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { correlationFields } = require('../utils/correlationFields');
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
  async applyPreChosen(replacements = [], { correlation } = {}) {
    const handled = new Set();
    for (const { salesDetailRecordId, productRecordId, size } of replacements) {
      if (!salesDetailRecordId || !productRecordId || !size) continue;
      // 关联键透传（只进日志）：补样品写的库存流水也在那条销售链上。
      await this.inventory.promoteToSample({ salesDetailRecordId, productRecordId, size }, { correlation });
      handled.add(salesDetailRecordId);
      logInfo('lark.sales.sample_replacement.applied', {
        sales_detail_record_id: salesDetailRecordId, product_record_id: productRecordId, size,
        ...correlationFields(correlation),
      });
    }
    return handled;
  }

  // ⛔ 2026-10-28：卡片按钮回调（`handleCardAction` / `handleCardActionUnlocked`）**整体删除** ——
  //   飞书不再有任何交互卡片（`routes/larkEvents.js` 的 `card.action.trigger` 已摘除，
  //   业务负责人：「现在没有群聊入口，也没有旧卡片」）。
  //   ⚠️ **保留**：①「样品已售出 → 请补选」这条**提醒**（`notifySampleReplacements`）；
  //     ② 工作台补样品那条写库路径（`applyPreChosen` → `InventoryService.promoteToSample`）。
  //   ⚠️ `publishCard` / `updateCard` 这两个**渲染/补发**端口保留（不认动作、只认任务与卡片），
  //     它们与"点按钮"这件事无关。
}

module.exports = { SampleReplacementService };
