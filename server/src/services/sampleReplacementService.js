const crypto = require('node:crypto');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { InventoryService } = require('./inventoryService');
const { textValue } = require('./v1BitableGateway');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { sampleReplacementCard, sampleReplacementStatusCard } = require('../utils/larkCards');
const { logError, logWarn } = require('../utils/logger');

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
    this.updateCard = updateCard || (async (task, event, card) => {
      const messageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id;
      if (!messageId) return false;
      try {
        const api = client.im?.v1?.message || client.im.message;
        if (!api?.patch) throw new Error('飞书客户端不支持更新消息卡片');
        const response = await api.patch({ path: { message_id: messageId },
          data: { content: JSON.stringify(card) } });
        if (response.code !== 0) throw new Error(`${response.msg} (Code: ${response.code})`);
        return true;
      } catch (error) {
        logWarn('lark.sales.sample_card.update.failed', { task_id: task.task_id, error: error.message });
        return false;
      }
    });
  }

  async notifySampleReplacements(deliveryResult, operatorOpenId) {
    if (!operatorOpenId) throw new Error('补选样品提醒缺少用户 open_id');
    for (const replacement of deliveryResult.sampleReplacements || []) {
      const taskId = taskIdFor(replacement.salesDetailRecordId);
      let task = await this.store.get(taskId);
      if (task?.status === 'completed') continue;
      const product = await this.gateway.get('product', replacement.productRecordId).catch(() => null);
      const productNumber = textValue(product?.fields?.[this.gateway.table('product').fields.number]) ||
        replacement.productRecordId;
      const remainingSizes = await this.inventory.sampleReplacementCandidates(replacement.productRecordId,
        { excludeRecordIds: replacement.consumedLiveRecordIds || [] });
      if (!task) {
        task = await this.store.create({ task_id: taskId, type: 'sample_replacement', status: 'pending',
          sender_open_id: operatorOpenId, sales_detail_record_id: replacement.salesDetailRecordId,
          product_record_id: replacement.productRecordId, product_number: productNumber,
          consumed_live_record_ids: replacement.consumedLiveRecordIds || [] });
      }
      if (task.card_message_id || task.notice_sent) continue;
      try {
        const cardMessageId = await this.sendCard(operatorOpenId,
          sampleReplacementCard(taskId, { productNumber, remainingSizes }));
        await this.store.update(taskId, { card_message_id: cardMessageId, notice_sent: true });
      } catch (error) {
        logWarn('lark.sales.sample_notice.failed', { task_id: taskId, error: error.message });
        await this.sendText(operatorOpenId,
          `${productNumber} 的样品已售出，但补选卡片发送失败；销售库存已扣减，请联系管理员核对补选任务。`).catch(() => undefined);
      }
    }
  }

  async handleCardAction(value, event, operatorOpenId) {
    const action = value?.action;
    if (!['choose_sample_replacement', 'refresh_sample_replacement'].includes(action)) return null;
    const draftId = value.draft_id;
    const task = await this.store.get(draftId);
    if (!task || task.type !== 'sample_replacement') throw new Error('补样品任务不存在');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由收到提醒的用户补选样品');
    if (task.status === 'completed') return { toast: { type: 'info', content: '该样品已补选' } };
    if (action === 'refresh_sample_replacement') {
      const remainingSizes = await this.inventory.sampleReplacementCandidates(task.product_record_id,
        { excludeRecordIds: task.consumed_live_record_ids || [] });
      await this.updateCard(task, event,
        sampleReplacementCard(draftId, { productNumber: task.product_number, remainingSizes }));
      return { toast: { type: 'info', content: '可选尺码已刷新' } };
    }
    const size = Number(value.size);
    if (!Number.isFinite(size) || size <= 0) throw new Error('补样品尺码无效');
    try {
      const result = await this.inventory.promoteToSample({
        salesDetailRecordId: task.sales_detail_record_id,
        productRecordId: task.product_record_id, size,
      });
      await this.store.update(draftId, { status: 'completed', result });
      await this.updateCard(task, event,
        sampleReplacementStatusCard(task.product_number, `${size}码已从门盒转为样品，库存总数不变。`));
      return { toast: { type: 'success', content: `${task.product_number} ${size}码已补作样品` } };
    } catch (error) {
      logError('lark.sales.sample_promotion.failed', { task_id: draftId, error: error.message });
      return { toast: { type: 'warning', content: `补选未完成：${error.message}` } };
    }
  }
}

module.exports = { SampleReplacementService };
