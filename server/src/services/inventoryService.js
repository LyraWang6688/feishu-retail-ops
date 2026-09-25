const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
const { logInfo } = require('../utils/logger');

const STOCK_BEHAVIORS = Object.freeze({
  sale: { name: '销售减少', direction: '减少' },
  purchase: { name: '采购增加', direction: '增加' },
});

const positiveNumber = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
};

const positiveInteger = (value, label) => {
  const number = positiveNumber(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label}必须是正整数`);
  return number;
};

const operationId = (kind, sourceRecordId) =>
  `inventory_${kind}_${crypto.createHash('sha256').update(String(sourceRecordId)).digest('hex').slice(0, 20)}`;
const samplePromotionId = (salesDetailRecordId) => operationId('sample', salesDetailRecordId);

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
      this.schemaValidation = this.gateway.validateTables(['behavior', 'inventoryLedger', 'liveInventory']);
    }
    return this.schemaValidation;
  }

  async resolveStockBehavior(kind) {
    const expected = STOCK_BEHAVIORS[kind];
    if (!expected) throw new Error(`不支持的库存来源：${kind}`);
    const fields = this.gateway.table('behavior').fields;
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.name]).trim() === expected.name);
    if (matches.length !== 1) throw new Error(`行为管理中“${expected.name}”必须且只能有一条记录`);
    const behavior = matches[0];
    const direction = textValue(behavior.fields?.[fields.stockDirection]).trim();
    if (direction !== expected.direction) {
      throw new Error(`请将行为管理“${expected.name}”的库存方向设置为“${expected.direction}”`);
    }
    if (behavior.fields?.[fields.enabled] !== true) {
      throw new Error(`请启用行为管理中的“${expected.name}”`);
    }
    return { recordId: behavior.record_id, direction };
  }

  async resolveSamplePromotionBehavior() {
    const fields = this.gateway.table('behavior').fields;
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.name]).trim() === '门盒转样品');
    if (matches.length !== 1) throw new Error('行为管理中“门盒转样品”必须且只能有一条记录');
    const behavior = matches[0];
    if (textValue(behavior.fields?.[fields.stockDirection]).trim() !== '不影响') {
      throw new Error('请将行为管理“门盒转样品”的库存方向设置为“不影响”');
    }
    if (behavior.fields?.[fields.enabled] !== true) throw new Error('请启用行为管理中的“门盒转样品”');
    return { recordId: behavior.record_id };
  }

  async validateStockBehaviors() {
    for (const kind of Object.keys(STOCK_BEHAVIORS)) await this.resolveStockBehavior(kind);
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
      // A sale always consumes door-box stock first, then a sample. Callers
      // must not bypass that policy by choosing a source state themselves.
      state: '门盒',
      sourceRecordId: input.salesDetailRecordId,
      quantity: positiveInteger(input.quantity, '销售数量'),
    });
  }

  async getSaleResult(salesDetailRecordId) {
    const operation = await this.store.get(operationId('sale', salesDetailRecordId));
    return operation?.status === 'completed' ? operation.result : null;
  }

  applyPurchase(input) {
    return this.applyChange({
      ...input,
      kind: 'purchase',
      state: input.state || '门盒',
      sourceRecordId: input.purchaseInboundRecordId,
      quantity: positiveInteger(input.quantity, '采购入库数量'),
    });
  }

  async applyChange(input) {
    if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
    if (!input.sourceRecordId) throw new Error('库存变化缺少来源明细 record_id');
    const size = positiveNumber(input.size, '尺码');
    const quantity = positiveInteger(input.quantity, '变动数量');
    const state = String(input.state || '门盒');
    if (!['门盒', '样品', '仓库'].includes(state)) throw new Error('库存所属状态无效');
    const stockKey = `${input.productRecordId}|${size}|${state}`;
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      await this.resumePending(stockKey);
      const id = operationId(input.kind, input.sourceRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if (operation.schema_version === 2 && (
          operation.kind !== input.kind || operation.product_record_id !== input.productRecordId ||
          operation.size !== size || operation.state !== state || operation.quantity !== quantity
        )) throw new Error(`来源明细 ${input.sourceRecordId} 的库存操作内容与首次提交不一致`);
      } else {
        const behavior = await this.resolveStockBehavior(input.kind);
        const existingLedger = await this.findLedger(input.kind, input.sourceRecordId, behavior.recordId);
        if (existingLedger) {
          throw new Error(`来源明细 ${input.sourceRecordId} 已有库存流水，但缺少可恢复任务，请人工核对实时库存`);
        }
        const delta = behavior.direction === '减少' ? -quantity : quantity;
        const allLiveRecords = await this.gateway.listAll('liveInventory');
        const states = input.kind === 'sale' ? ['门盒', '样品'] : [state];
        const liveRecords = states.flatMap((candidateState) =>
          this.findLiveInventoryIn(allLiveRecords, input.productRecordId, size, candidateState)
            .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id))));
        const currentQuantity = liveRecords.length;
        if (delta < 0 && currentQuantity < quantity) {
          throw new Error(`门盒和样品库存不足：${input.productRecordId} ${size}码，需 ${quantity} 双，现有 ${currentQuantity} 双`);
        }
        const selected = delta < 0 ? liveRecords.slice(0, quantity) : [];
        const stateField = this.gateway.table('liveInventory').fields.state;
        const sampleConsumed = selected.filter((record) =>
          textValue(record.fields?.[stateField]) === '样品').length;
        const targetQuantity = currentQuantity + delta;
        operation = await this.store.create({
          operation_id: id,
          type: 'inventory_change',
          schema_version: 2,
          status: 'prepared',
          kind: input.kind,
          stock_key: stockKey,
          product_record_id: input.productRecordId,
          size,
          state,
          quantity,
          direction: behavior.direction,
          behavior_record_id: behavior.recordId,
          source_record_id: input.sourceRecordId,
          occurred_at: Number(input.occurredAt || Date.now()),
          live_record_ids: selected.map((record) => record.record_id),
          sample_consumed_quantity: sampleConsumed,
          removed_live_record_ids: [],
          created_live_record_ids: [],
          current_quantity: currentQuantity,
          target_quantity: targetQuantity,
        });
      }
      return this.executeOperation(operation);
    });
  }

  async resumePending(stockKey) {
    const pending = (await this.store.list()).filter(
      (record) => ['inventory_change', 'sample_promotion'].includes(record.type) &&
        record.stock_key === stockKey && record.status !== 'completed'
    );
    for (const operation of pending.reverse()) {
      if (operation.type === 'sample_promotion') await this.executeSamplePromotion(operation);
      else await this.executeOperation(operation);
    }
  }

  async promoteToSample({ salesDetailRecordId, productRecordId, size } = {}) {
    if (!salesDetailRecordId || !productRecordId) throw new Error('补样品缺少销售明细或货品');
    const normalizedSize = positiveNumber(size, '尺码');
    const stockKey = `${productRecordId}|${normalizedSize}|门盒`;
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      await this.resumePending(stockKey);
      const id = samplePromotionId(salesDetailRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if (operation.product_record_id !== productRecordId || operation.size !== normalizedSize) {
          throw new Error('同一销售明细已选择其他补样品尺码，不能重复选择');
        }
      } else {
        const behavior = await this.resolveSamplePromotionBehavior();
        if (await this.findLedger('sale', salesDetailRecordId, behavior.recordId)) {
          throw new Error('补样品流水已存在但缺少可恢复任务，请人工核对');
        }
        const liveRecords = await this.findLiveInventory(productRecordId, normalizedSize, '门盒');
        liveRecords.sort((left, right) => String(left.record_id).localeCompare(String(right.record_id)));
        if (!liveRecords.length) throw new Error(`${normalizedSize}码已没有门盒库存，请重新选择`);
        operation = await this.store.create({
          operation_id: id, type: 'sample_promotion', status: 'prepared', stock_key: stockKey,
          source_record_id: salesDetailRecordId, product_record_id: productRecordId,
          size: normalizedSize, live_record_id: liveRecords[0].record_id,
          behavior_record_id: behavior.recordId,
        });
      }
      return this.executeSamplePromotion(operation);
    });
  }

  async executeSamplePromotion(operation) {
    if (operation.status === 'completed') return operation.result;
    let ledger = await this.findLedger('sale', operation.source_record_id, operation.behavior_record_id);
    const record = await this.gateway.get('liveInventory', operation.live_record_id);
    if (!record) throw new Error('待补样品的门盒库存记录不存在，请人工核对');
    const fields = this.gateway.table('liveInventory').fields;
    if (!linkedRecordIds(record.fields?.[fields.product]).includes(operation.product_record_id) ||
      Number(textValue(record.fields?.[fields.size])) !== operation.size) {
      throw new Error('待补样品的库存记录与货品或尺码不一致');
    }
    const state = textValue(record.fields?.[fields.state]);
    if (state !== '门盒' && !(ledger && state === '样品')) {
      throw new Error('待补样品的库存已不属于门盒，请人工核对');
    }
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id), size: operation.size,
        quantityChange: 0, behavior: relation(operation.behavior_record_id),
        salesDetail: relation(operation.source_record_id),
      });
      ledger = { record_id: created.recordId };
    }
    operation = await this.store.update(operation.operation_id, {
      status: 'ledger_created', ledger_record_id: ledger.record_id,
    });
    if (state === '门盒') await this.gateway.update('liveInventory', operation.live_record_id, { state: '样品' });
    const result = { liveRecordId: operation.live_record_id, ledgerRecordId: ledger.record_id,
      productRecordId: operation.product_record_id, size: operation.size };
    await this.store.update(operation.operation_id, { status: 'completed', result });
    logInfo('inventory.sample.promoted', { operation_id: operation.operation_id,
      live_record_id: operation.live_record_id, ledger_record_id: ledger.record_id, size: operation.size });
    return result;
  }

  async executeOperation(operation) {
    if (operation.status === 'completed') return operation.result;
    if (operation.schema_version !== 2) {
      throw new Error(`库存操作 ${operation.operation_id} 使用旧结构且尚未完成，请先人工核对，不能自动重试`);
    }
    let ledger = await this.findLedger(operation.kind, operation.source_record_id, operation.behavior_record_id);
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id),
        size: operation.size,
        quantityChange: operation.quantity,
        behavior: relation(operation.behavior_record_id),
        salesDetail: operation.kind === 'sale' ? relation(operation.source_record_id) : undefined,
        purchaseInbound: operation.kind === 'purchase' ? relation(operation.source_record_id) : undefined,
      });
      ledger = { record_id: created.recordId };
    }
    operation = await this.store.update(operation.operation_id, {
      status: 'ledger_created',
      ledger_record_id: ledger.record_id,
    });

    const liveRecordIds = operation.live_record_ids || [];
    const removedIds = operation.removed_live_record_ids || [];
    const createdIds = operation.created_live_record_ids || [];
    if (operation.direction === '减少') {
      for (const recordId of liveRecordIds) {
        if (removedIds.includes(recordId)) continue;
        // A list response may lag behind the selected record. Confirm the
        // exact record before deleting; never report a deduction based only
        // on its absence from a possibly stale list.
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record) throw new Error(`待扣减实时库存 ${recordId} 不存在，请人工核对`);
        await this.gateway.delete('liveInventory', recordId);
        removedIds.push(recordId);
        operation = await this.store.update(operation.operation_id, { removed_live_record_ids: removedIds });
      }
    } else {
      const expectedCreates = operation.quantity;
      while (createdIds.length < expectedCreates) {
        const created = await this.gateway.create('liveInventory', {
          product: relation(operation.product_record_id),
          size: operation.size,
          state: operation.state || '门盒',
        });
        createdIds.push(created.recordId);
        operation = await this.store.update(operation.operation_id, { created_live_record_ids: createdIds });
      }
    }

    const result = {
      stockKey: operation.stock_key,
      ledgerRecordId: ledger.record_id,
      liveRecordIds: operation.direction === '减少' ? removedIds : createdIds,
      movementQuantity: operation.quantity,
      direction: operation.direction,
      quantity: operation.target_quantity,
      sampleConsumedQuantity: operation.sample_consumed_quantity || 0,
      productRecordId: operation.product_record_id,
      consumedLiveRecordIds: operation.kind === 'sale' ? removedIds : [],
    };
    if (operation.kind === 'sale' && result.sampleConsumedQuantity) {
      result.remainingSizes = await this.sampleReplacementCandidates(operation.product_record_id,
        { excludeRecordIds: removedIds });
    }
    await this.store.update(operation.operation_id, {
      status: 'completed',
      result,
    });
    logInfo('inventory.change.applied', {
      operation_id: operation.operation_id,
      kind: operation.kind,
      stock_key: operation.stock_key,
      movement_quantity: operation.quantity,
      direction: operation.direction,
      target_quantity: operation.target_quantity,
      ledger_record_id: ledger.record_id,
      live_record_ids: result.liveRecordIds,
    });
    return result;
  }

  async findLedger(kind, sourceRecordId, behaviorRecordId) {
    const table = this.gateway.table('inventoryLedger');
    const fieldName = table.fields[kind === 'sale' ? 'salesDetail' : 'purchaseInbound'];
    const records = await this.gateway.listAll('inventoryLedger');
    const matches = records.filter((record) =>
      linkedRecordIds(record.fields?.[fieldName]).includes(sourceRecordId) &&
      (!behaviorRecordId || linkedRecordIds(record.fields?.[table.fields.behavior]).includes(behaviorRecordId)));
    if (matches.length > 1) throw new Error(`来源明细 ${sourceRecordId} 存在重复库存流水`);
    return matches[0] || null;
  }

  findLiveInventoryIn(records, productRecordId, size, state = '门盒') {
    const table = this.gateway.table('liveInventory');
    return records.filter(
      (record) =>
        linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId) &&
        Number(textValue(record.fields?.[table.fields.size])) === Number(size) &&
        textValue(record.fields?.[table.fields.state]) === state
    );
  }

  async findLiveInventory(productRecordId, size, state = '门盒') {
    return this.findLiveInventoryIn(await this.gateway.listAll('liveInventory'), productRecordId, size, state);
  }

  async sampleReplacementCandidates(productRecordId, { excludeRecordIds = [] } = {}) {
    const table = this.gateway.table('liveInventory');
    const bySize = new Map();
    const excluded = new Set(excludeRecordIds);
    for (const record of await this.gateway.listAll('liveInventory')) {
      if (excluded.has(record.record_id)) continue;
      if (!linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId)) continue;
      const size = Number(textValue(record.fields?.[table.fields.size]));
      const state = textValue(record.fields?.[table.fields.state]);
      if (!Number.isFinite(size) || !['门盒', '样品', '仓库'].includes(state)) continue;
      if (!bySize.has(size)) bySize.set(size, { size, doorBoxCount: 0, sampleCount: 0, warehouseCount: 0 });
      const counts = bySize.get(size);
      if (state === '门盒') counts.doorBoxCount += 1;
      if (state === '样品') counts.sampleCount += 1;
      if (state === '仓库') counts.warehouseCount += 1;
    }
    return [...bySize.values()].sort((left, right) => left.size - right.size);
  }
}

module.exports = { InventoryService, operationId };
