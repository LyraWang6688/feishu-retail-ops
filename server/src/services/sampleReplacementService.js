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

const taskIdFor = (salesDetailRecordId) =>
  `sample_${crypto.createHash('sha256').update(String(salesDetailRecordId)).digest('hex').slice(0, 20)}`;

class SampleReplacementService {
  constructor({ gateway, inventory, store, client, sendCard, sendText, updateCard } = {}) {
    if (!gateway) throw new Error('SampleReplacementService requires gateway');
    this.gateway = gateway;
    this.inventory = inventory || new InventoryService({ gateway });
    this.store = store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id',
    });
    this.cardActionQueue = new KeyedSerialQueue();
    if (!sendCard || !sendText || !updateCard) {
      if (!client) {
        const { appId, appSecret } = getLarkAgentCredentials();
        client = new lark.Client({ appId, appSecret });
      }
    }
    this.sendCard = sendCard || (async (openId, card) => {
      const response = await client.im.message.create({ params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) } });
      if (response.code !== 0) throw new Error(`发送飞书卡片失败: ${response.msg} (Code: ${response.code})`);
      return response.data?.message_id || '';
    });
    this.sendText = sendText || (async (openId, message) => {
      const response = await client.im.message.create({ params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: message }) } });
      if (response.code !== 0) throw new Error(`发送飞书消息失败: ${response.msg} (Code: ${response.code})`);
    });
    this.updateCard = updateCard || ((task, event, card, metadata = {}) => updateInteractiveCard({
      client, task, event, card, stage: metadata.stage, interactionId: metadata.interactionId,
      eventPrefix: 'lark.sales.sample_card.update',
    }));
  }

  async publishCard(task, event, card, metadata = {}) {
    if (await this.updateCard(task, event, card, metadata)) return true;
    try {
      const messageId = await this.sendCard(task.sender_open_id, card);
      if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
      logInfo('lark.sales.sample_card.fallback.sent', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, card_message_id: messageId });
      return true;
    } catch (error) {
      logWarn('lark.sales.sample_card.fallback.failed', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, error: error.message });
      return false;
    }
  }

  async notifySampleReplacements(deliveryResult, operatorOpenId) {
    if (!operatorOpenId) throw new Error('补选样品提醒缺少用户 open_id');
    for (const replacement of deliveryResult.sampleReplacements || []) {
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
      try {
        const cardMessageId = await this.sendCard(operatorOpenId,
          sampleReplacementCard(taskId, { productNumber, remainingSizes, lookupFailed }));
        await this.store.update(taskId, { card_message_id: cardMessageId, notice_sent: true });
      } catch (error) {
        logWarn('lark.sales.sample_notice.failed', { task_id: taskId, error: error.message });
        await this.sendText(operatorOpenId,
          `${productNumber} 的样品已售出，但补选卡片发送失败；销售库存已扣减，请联系管理员核对补选任务。`).catch(() => undefined);
      }
    }
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
    if (!processing) await this.sendText(operatorOpenId, '已收到补样品操作，正在处理，请稍候。').catch((error) =>
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
