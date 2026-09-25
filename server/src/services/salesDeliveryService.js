const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { InventoryService } = require('./inventoryService');
const { logInfo } = require('../utils/logger');

class SalesDeliveryService {
  constructor({ gateway, inventory } = {}) {
    if (!gateway) throw new Error('SalesDeliveryService requires gateway');
    this.gateway = gateway;
    this.inventory = inventory || new InventoryService({ gateway });
    this.queue = Promise.resolve();
  }

  deliver(input) {
    const next = this.queue.then(() => this._deliver(input), () => this._deliver(input));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _deliver({ salesEntryRecordId, detailRecordIds, state = '门盒', occurredAt } = {}) {
    if (!salesEntryRecordId) throw new Error('交付缺少销售主表 record_id');
    if (!Array.isArray(detailRecordIds) || !detailRecordIds.length) throw new Error('请选择交付的销售明细');
    if (new Set(detailRecordIds).size !== detailRecordIds.length) throw new Error('交付明细不能重复');
    if (!['门盒', '样品', '仓库'].includes(state)) throw new Error('库存所属状态无效');
    await this.gateway.validateTables?.(['salesEntry', 'salesDetail', 'inventoryLedger', 'liveInventory']);
    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry) throw new Error('销售主表记录不存在');
    const entryFields = this.gateway.table('salesEntry').fields;
    if (textValue(entry.fields?.[entryFields.confirmStatus]) !== '已入账') throw new Error('销售订单尚未确认入账');
    const fields = this.gateway.table('salesDetail').fields;
    const details = (await this.gateway.listAll('salesDetail')).filter((record) =>
      linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId));
    const byId = new Map(details.map((record) => [record.record_id, record]));
    for (const id of detailRecordIds) {
      const detail = byId.get(id);
      if (!detail) throw new Error(`销售明细 ${id} 不属于此订单`);
      const quantity = Number(textValue(detail.fields?.[fields.quantity]));
      const delivered = Number(textValue(detail.fields?.[fields.deliveredQuantity]) || 0);
      if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(delivered) || delivered < 0 || delivered > quantity) {
        throw new Error(`销售明细 ${id} 的数量或交付数量无效`);
      }
      // MVP: one full delivery per detail. The stock operation is keyed by
      // detail ID, so retries cannot deduct the same detail a second time.
      if (delivered > 0 && delivered < quantity) throw new Error(`销售明细 ${id} 已部分交付，请人工核对`);
    }
    const results = [];
    for (const id of detailRecordIds) {
      const detail = byId.get(id);
      const quantity = Number(textValue(detail.fields?.[fields.quantity]));
      if (Number(textValue(detail.fields?.[fields.deliveredQuantity]) || 0) === quantity) {
        results.push({ detailRecordId: id, duplicate: true });
        continue;
      }
      const productIds = linkedRecordIds(detail.fields?.[fields.product]);
      if (productIds.length !== 1) throw new Error(`销售明细 ${id} 必须关联一个货品`);
      const inventoryResult = await this.inventory.applySale({
        salesDetailRecordId: id, productRecordId: productIds[0],
        size: Number(textValue(detail.fields?.[fields.size])), quantity, state,
        occurredAt: Number(occurredAt || Date.now()),
      });
      await this.gateway.update('salesDetail', id, { deliveredQuantity: quantity });
      detail.fields[fields.deliveredQuantity] = quantity;
      results.push({ detailRecordId: id, inventoryResult });
    }
    const deliveredTotal = details.reduce((sum, detail) =>
      sum + Number(textValue(detail.fields?.[fields.deliveredQuantity]) || 0), 0);
    const total = details.reduce((sum, detail) => sum + Number(textValue(detail.fields?.[fields.quantity]) || 0), 0);
    await this.gateway.update('salesEntry', salesEntryRecordId, {
      deliveredQuantity: deliveredTotal,
      fulfillmentStatus: deliveredTotal === total ? '已交付' : deliveredTotal > 0 ? '部分交付' : '未交付',
    });
    logInfo('sales.delivery.completed', { sales_entry_record_id: salesEntryRecordId,
      detail_count: results.length, delivered_quantity: deliveredTotal });
    return { salesEntryRecordId, results, deliveredQuantity: deliveredTotal, totalQuantity: total };
  }
}

module.exports = { SalesDeliveryService };
