const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
const { logInfo } = require('../utils/logger');

const positiveNumber = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
};

const operationId = (kind, sourceRecordId) =>
  `inventory_${kind}_${crypto.createHash('sha256').update(String(sourceRecordId)).digest('hex').slice(0, 20)}`;

class InventoryService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('InventoryService requires gateway');
    this.gateway = options.gateway;
    this.store =
      options.store ||
      new JsonTaskStore({
        dir: path.join(__dirname, '../../data/inventory_operations'),
        idField: 'operation_id',
      });
    this.queues = new Map();
    this.schemaValidation = null;
  }

  async ensureSchema() {
    if (typeof this.gateway.validateTables !== 'function') return;
    if (!this.schemaValidation) {
      this.schemaValidation = this.gateway.validateTables(['inventoryLedger', 'liveInventory']);
    }
    return this.schemaValidation;
  }

  runForStock(stockKey, work) {
    const previous = this.queues.get(stockKey) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(stockKey, next);
    const cleanup = () => {
      if (this.queues.get(stockKey) === next) this.queues.delete(stockKey);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  applySale(input) {
    return this.applyChange({
      ...input,
      kind: 'sale',
      sourceRecordId: input.salesDetailRecordId,
      quantityChange: -positiveNumber(input.quantity, '销售数量'),
    });
  }

  applyPurchase(input) {
    return this.applyChange({
      ...input,
      kind: 'purchase',
      sourceRecordId: input.purchaseInboundRecordId,
      quantityChange: positiveNumber(input.quantity, '采购入库数量'),
    });
  }

  async applyChange(input) {
    if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
    if (!input.sourceRecordId) throw new Error('库存变化缺少来源明细 record_id');
    const size = positiveNumber(input.size, '尺码');
    const stockKey = `${input.productRecordId}|${size}`;
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      await this.resumePending(stockKey);
      const id = operationId(input.kind, input.sourceRecordId);
      let operation = await this.store.get(id);
      if (!operation) {
        const existingLedger = await this.findLedger(input.kind, input.sourceRecordId);
        if (existingLedger) {
          throw new Error(`来源明细 ${input.sourceRecordId} 已有库存流水，但缺少可恢复任务，请人工核对实时库存`);
        }
        const live = await this.findLiveInventory(input.productRecordId, size);
        if (!live && input.quantityChange < 0) {
          throw new Error(`实时库存中找不到库存键 ${stockKey}，不能执行销售扣减`);
        }
        const currentQuantity = live ? this.liveQuantity(live) : 0;
        const targetQuantity = currentQuantity + Number(input.quantityChange);
        if (targetQuantity < 0) {
          throw new Error(`库存不足：${stockKey} 当前${currentQuantity}，本次变化${input.quantityChange}`);
        }
        operation = await this.store.create({
          operation_id: id,
          type: 'inventory_change',
          status: 'prepared',
          kind: input.kind,
          stock_key: stockKey,
          product_record_id: input.productRecordId,
          size,
          quantity_change: Number(input.quantityChange),
          source_record_id: input.sourceRecordId,
          occurred_at: Number(input.occurredAt || Date.now()),
          live_record_id: live?.record_id || '',
          current_quantity: currentQuantity,
          target_quantity: targetQuantity,
        });
      }
      return this.executeOperation(operation);
    });
  }

  async resumePending(stockKey) {
    const pending = (await this.store.list()).filter(
      (record) => record.type === 'inventory_change' && record.stock_key === stockKey && record.status !== 'completed'
    );
    for (const operation of pending.reverse()) await this.executeOperation(operation);
  }

  async executeOperation(operation) {
    if (operation.status === 'completed') return operation.result;
    let ledger = await this.findLedger(operation.kind, operation.source_record_id);
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id),
        size: operation.size,
        quantityChange: operation.quantity_change,
        salesDetail: operation.kind === 'sale' ? relation(operation.source_record_id) : undefined,
        purchaseInbound: operation.kind === 'purchase' ? relation(operation.source_record_id) : undefined,
        occurredAt: operation.occurred_at,
      });
      ledger = { record_id: created.recordId };
    }
    operation = await this.store.update(operation.operation_id, {
      status: 'ledger_created',
      ledger_record_id: ledger.record_id,
    });

    let liveRecordId = operation.live_record_id;
    if (liveRecordId) {
      await this.gateway.update('liveInventory', liveRecordId, {
        quantity: operation.target_quantity,
        updatedAt: operation.occurred_at,
      });
    } else {
      const created = await this.gateway.create('liveInventory', {
        product: relation(operation.product_record_id),
        size: operation.size,
        quantity: operation.target_quantity,
        updatedAt: operation.occurred_at,
      });
      liveRecordId = created.recordId;
    }

    const result = {
      stockKey: operation.stock_key,
      ledgerRecordId: ledger.record_id,
      liveRecordId,
      quantityChange: operation.quantity_change,
      quantity: operation.target_quantity,
    };
    await this.store.update(operation.operation_id, {
      status: 'completed',
      live_record_id: liveRecordId,
      result,
    });
    logInfo('inventory.change.applied', {
      operation_id: operation.operation_id,
      kind: operation.kind,
      stock_key: operation.stock_key,
      quantity_change: operation.quantity_change,
      target_quantity: operation.target_quantity,
      ledger_record_id: ledger.record_id,
      live_record_id: liveRecordId,
    });
    return result;
  }

  async findLedger(kind, sourceRecordId) {
    const table = this.gateway.table('inventoryLedger');
    const fieldName = table.fields[kind === 'sale' ? 'salesDetail' : 'purchaseInbound'];
    const records = await this.gateway.listAll('inventoryLedger');
    const matches = records.filter((record) => linkedRecordIds(record.fields?.[fieldName]).includes(sourceRecordId));
    if (matches.length > 1) throw new Error(`来源明细 ${sourceRecordId} 存在重复库存流水`);
    return matches[0] || null;
  }

  async findLiveInventory(productRecordId, size) {
    const table = this.gateway.table('liveInventory');
    const records = await this.gateway.listAll('liveInventory');
    const matches = records.filter(
      (record) =>
        linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId) &&
        Number(textValue(record.fields?.[table.fields.size])) === Number(size)
    );
    if (matches.length > 1) throw new Error(`实时库存存在重复库存键: ${productRecordId}|${size}`);
    return matches[0] || null;
  }

  liveQuantity(record) {
    const fieldName = this.gateway.table('liveInventory').fields.quantity;
    const quantity = Number(textValue(record.fields?.[fieldName]) || 0);
    if (!Number.isFinite(quantity)) throw new Error(`实时库存数量不是有效数字: ${record.record_id}`);
    return quantity;
  }
}

module.exports = { InventoryService, operationId };
