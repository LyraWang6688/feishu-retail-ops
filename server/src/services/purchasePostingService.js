const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { InventoryService } = require('./inventoryService');
const { logError, logInfo } = require('../utils/logger');

class PurchasePostingService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    this.enabled = options.enablePurchaseInventory ?? process.env.ENABLE_PURCHASE_INVENTORY === 'true';
    this.queue = Promise.resolve();
  }

  post(input) {
    const next = this.queue.then(() => this._post(input), () => this._post(input));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _post(input) {
    await this.gateway.validateTables?.(['product', 'supplier', 'purchaseBatch', 'purchaseInbound']);
    const batchRecordId = input.batchRecordId;
    if (!batchRecordId) throw new Error('缺少采购到货批次 record_id');
    await this.gateway.update('purchaseBatch', batchRecordId, { confirmStatus: '入账中', failureReason: '' });
    try {
      if (!input.supplierRecordId) throw new Error('采购入库必须选择供应商');
      await this.gateway.update('purchaseBatch', batchRecordId, { supplier: relation(input.supplierRecordId) });
      if (!Array.isArray(input.items) || !input.items.length) throw new Error('至少需要一条采购入库明细');
      const resolved = [];
      for (const raw of input.items) {
        const product = await this.references.resolveProduct(raw);
        const size = Number(raw.size);
        const quantity = Number(raw.quantity);
        if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(quantity) || quantity <= 0) {
          throw new Error('采购尺码或数量无效');
        }
        resolved.push({ ...raw, productRecordId: product.recordId, size, quantity });
      }
      const fields = this.gateway.table('purchaseInbound').fields;
      const existing = (await this.gateway.listAll('purchaseInbound')).filter((record) =>
        linkedRecordIds(record.fields?.[fields.batch]).includes(batchRecordId));
      const used = new Set();
      const rows = resolved.map((item) => {
        const record = existing.find((candidate) => !used.has(candidate.record_id) &&
          linkedRecordIds(candidate.fields?.[fields.product]).includes(item.productRecordId) &&
          Number(textValue(candidate.fields?.[fields.size])) === item.size &&
          Number(textValue(candidate.fields?.[fields.quantity])) === item.quantity);
        if (record) used.add(record.record_id);
        return { item, recordId: record?.record_id || '' };
      });
      if (existing.some((record) => !used.has(record.record_id))) {
        throw new Error('采购到货批次已有与当前草稿不一致的入库明细，已停止自动重试');
      }
      const occurredAt = Number(input.occurredAt || Date.now());
      for (const row of rows) {
        if (row.recordId) continue;
        const created = await this.gateway.create('purchaseInbound', {
          size: row.item.size, quantity: row.item.quantity,
          operator: person(input.operatorOpenId), batch: relation(batchRecordId),
          supplierOrder: relation(row.item.supplierOrderRecordId),
          product: relation(row.item.productRecordId), inboundAt: occurredAt,
        });
        row.recordId = created.recordId;
      }
      const inventoryResults = [];
      if (this.enabled) {
        for (const row of rows) inventoryResults.push(await this.inventory.applyPurchase({
          purchaseInboundRecordId: row.recordId, productRecordId: row.item.productRecordId,
          size: row.item.size, quantity: row.item.quantity, occurredAt,
        }));
      }
      await this.gateway.update('purchaseBatch', batchRecordId, { confirmStatus: '已入账' });
      const batch = await this.gateway.get('purchaseBatch', batchRecordId);
      const sourceNo = textValue(batch?.fields?.[this.gateway.table('purchaseBatch').fields.batchNo]) || batchRecordId;
      logInfo('v1.purchase.posted', { batch_record_id: batchRecordId, item_count: rows.length,
        inventory_applied: this.enabled });
      return { sourceNo, inboundRecordIds: rows.map((row) => row.recordId), inventoryResults, inventoryApplied: this.enabled };
    } catch (error) {
      await this.gateway.update('purchaseBatch', batchRecordId, {
        confirmStatus: '入账失败', failureReason: error.message,
      }).catch(() => undefined);
      logError('v1.purchase.post_failed', { batch_record_id: batchRecordId, error: error.message });
      throw error;
    }
  }
}

module.exports = { PurchasePostingService };
