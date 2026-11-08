'use strict';

/**
 * 补样品：只保留**工作台写库**那半。
 *
 * 群话题卡片入口已退场，补样品卡片不再发送。
 * 保留：
 *   · 把「样品已售出 → 请补选」落成本地待办（工作台订单列表读它）；
 *   · applyPreChosen → InventoryService.promoteToSample（工作台补样品写库）。
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { InventoryService } = require('./inventoryService');
const { textValue } = require('./v1BitableGateway');
const { logInfo } = require('../utils/logger');
const { correlationFields } = require('../utils/correlationFields');

const taskIdFor = (salesDetailRecordId) =>
  `sample_${crypto.createHash('sha256').update(String(salesDetailRecordId)).digest('hex').slice(0, 20)}`;

class SampleReplacementService {
  constructor({ gateway, inventory, store } = {}) {
    if (!gateway) throw new Error('SampleReplacementService requires gateway');
    this.gateway = gateway;
    this.inventory = inventory || new InventoryService({ gateway });
    this.store = store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id',
    });
  }

  async notifySampleReplacements(deliveryResult, operatorOpenId) {
    if (!operatorOpenId) throw new Error('补选样品提醒缺少用户 open_id');
    for (const replacement of deliveryResult.sampleReplacements || []) {
      const taskId = taskIdFor(replacement.salesDetailRecordId);
      const task = await this.store.get(taskId);
      if (task?.status === 'completed') continue;
      if (task) continue;
      const product = await this.gateway.get('product', replacement.productRecordId).catch(() => null);
      const productNumber = textValue(product?.fields?.[this.gateway.table('product').fields.number]) ||
        replacement.productRecordId;
      await this.store.create({
        task_id: taskId,
        type: 'sample_replacement',
        status: 'pending',
        sender_open_id: operatorOpenId,
        sales_detail_record_id: replacement.salesDetailRecordId,
        product_record_id: replacement.productRecordId,
        product_number: productNumber,
        consumed_live_record_ids: replacement.consumedLiveRecordIds || [],
      });
    }
  }

  async applyPreChosen(replacements = [], { correlation } = {}) {
    const handled = new Set();
    for (const { salesDetailRecordId, productRecordId, size } of replacements) {
      if (!salesDetailRecordId || !productRecordId || !size) continue;
      await this.inventory.promoteToSample({ salesDetailRecordId, productRecordId, size }, { correlation });
      handled.add(salesDetailRecordId);
      logInfo('lark.sales.sample_replacement.applied', {
        sales_detail_record_id: salesDetailRecordId, product_record_id: productRecordId, size,
        ...correlationFields(correlation),
      });
    }
    return handled;
  }
}

module.exports = { SampleReplacementService };
