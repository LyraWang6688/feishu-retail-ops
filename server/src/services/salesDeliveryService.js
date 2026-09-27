const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { InventoryService } = require('./inventoryService');
const { SalesProgressService } = require('./salesProgressService');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { withSalesReadRetry } = require('./salesReadRetry');
const { logError, logInfo } = require('../utils/logger');

class SalesDeliveryService {
  constructor({ gateway, inventory, progress } = {}) {
    if (!gateway) throw new Error('SalesDeliveryService requires gateway');
    this.gateway = gateway;
    this.inventory = inventory || new InventoryService({ gateway });
    this.progress = progress || new SalesProgressService({ gateway });
    this.queue = Promise.resolve();
  }

  deliver(input) {
    const next = this.queue.then(() => this._deliver(input), () => this._deliver(input));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _deliver({ salesEntryRecordId, detailRecordIds, paymentRecordIds = [], occurredAt } = {}) {
    if (!salesEntryRecordId) throw new Error('交付缺少销售主表 record_id');
    if (!Array.isArray(detailRecordIds) || !detailRecordIds.length) throw new Error('请选择交付的销售明细');
    if (new Set(detailRecordIds).size !== detailRecordIds.length) throw new Error('交付明细不能重复');
    await this.gateway.validateTables?.(['salesEntry', 'salesDetail', 'behavior', 'inventoryLedger', 'liveInventory']);
    const entry = await withSalesReadRetry(
      () => this.gateway.get('salesEntry', salesEntryRecordId), 'delivery_sale_entry',
    );
    if (!entry) throw new Error('销售主表记录不存在');
    const entryFields = this.gateway.table('salesEntry').fields;
    if (textValue(entry.fields?.[entryFields.confirmStatus]) !== '已入账') throw new Error('销售订单尚未确认入账');
    const fields = this.gateway.table('salesDetail').fields;
    const listedDetails = (await withSalesReadRetry(
      () => this.gateway.listAll('salesDetail'), 'delivery_detail_list',
    )).filter((record) =>
      linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId));
    const byId = new Map(listedDetails.map((record) => [record.record_id, record]));
    for (const id of detailRecordIds) {
      // The caller has exact IDs from creation. Do not depend on a freshly
      // created relation already appearing in Bitable's list response.
      const detail = await withSalesReadRetry(
        () => readSaleLinkedRecord(this.gateway, 'salesDetail', id,
          fields.salesEntry, salesEntryRecordId), 'delivery_detail_by_id',
      );
      byId.set(id, detail);
    }
    const results = [];
    const failures = [];
    for (const [index, id] of detailRecordIds.entries()) {
      const detail = byId.get(id);
      const quantity = 1;
      const size = Number(textValue(detail.fields?.[fields.size]));
      const productIds = linkedRecordIds(detail.fields?.[fields.product]);
      try {
        const status = textValue(detail.fields?.[fields.fulfillmentStatus]) || '未交付';
        if (!['未交付', '已交付'].includes(status)) throw new Error(`销售明细 ${id} 履约状态无效：${status}`);
        if (status === '已交付') {
          const inventoryResult = await this.inventory.getSaleResult?.(id);
          results.push({ detailRecordId: id, duplicate: true, inventoryResult });
          continue;
        }
        if (productIds.length !== 1) throw new Error(`销售明细 ${id} 必须关联一个货品`);
        const inventoryResult = await this.inventory.applySale({
          salesDetailRecordId: id, productRecordId: productIds[0],
          size, quantity, occurredAt: Number(occurredAt || Date.now()),
        });
        await this.gateway.update('salesDetail', id, { fulfillmentStatus: '已交付' });
        detail.fields[fields.fulfillmentStatus] = '已交付';
        results.push({ detailRecordId: id, inventoryResult });
      } catch (error) {
        failures.push({ detailRecordId: id, lineNumber: index + 1,
          productRecordId: productIds[0] || '', size, quantity, error: error.message });
        logError('sales.delivery.line.failed', { sales_entry_record_id: salesEntryRecordId,
          detail_record_id: id, line_number: index + 1, product_record_id: productIds[0],
          size, quantity, error: error.message });
      }
    }
    const details = [...byId.values()];
    const deliveredTotal = details.filter((detail) =>
      textValue(detail.fields?.[fields.fulfillmentStatus]) === '已交付').length;
    const total = details.length;
    const progress = await this.progress.sync(salesEntryRecordId, { detailRecordIds, paymentRecordIds });
    logInfo('sales.delivery.completed', { sales_entry_record_id: salesEntryRecordId,
      detail_count: results.length, failed_count: failures.length,
      delivered_quantity: deliveredTotal, fulfillment_status: progress.fulfillmentStatus });
    const sampleReplacements = results.filter((item) => item.inventoryResult?.sampleConsumedQuantity > 0)
      .map((item) => ({ salesDetailRecordId: item.detailRecordId,
        productRecordId: item.inventoryResult.productRecordId,
        sampleConsumedQuantity: item.inventoryResult.sampleConsumedQuantity,
        consumedLiveRecordIds: item.inventoryResult.consumedLiveRecordIds || [],
        remainingSizes: item.inventoryResult.remainingSizes || [] }));
    return { salesEntryRecordId, results, failures, deliveredQuantity: deliveredTotal,
      totalQuantity: total, fulfillmentStatus: progress.fulfillmentStatus, sampleReplacements };
  }
}

module.exports = { SalesDeliveryService };
