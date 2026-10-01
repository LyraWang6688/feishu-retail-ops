const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { linkedRecordIds, singleLinked, textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
const { SizeReferenceService, normalizeSize } = require('./sizeReferenceService');
const { OPERATION_ITEM_KEY_FIELD, createOnceByKey, validateIdempotencyKeyFields } = require('../infrastructure/idempotencyKey');
const { logInfo, logWarn } = require('../utils/logger');

// 库存动作注册表。键 = 飞书「行为管理」表里的「行为编码」。
//
// 分工：行为表负责业务侧（哪条启用、库存方向、资金方向），这里只声明引擎语义。
// 中文名可以随时改，改了代码不受影响；编码是契约，改名要表和代码同步。
// 新增动作 = 表里补一条行为 + 这里加一条声明，不需要再改任何分支逻辑。
const MOVEMENT_SALE_DECREASE = 'STOCK_SALE_DECREASE';
const MOVEMENT_PURCHASE_INCREASE = 'STOCK_PURCHASE_INCREASE';
const BEHAVIOR_SAMPLE_PROMOTION = 'STOCK_DOORBOX_TO_SAMPLE';

const STOCK_MOVEMENTS = Object.freeze({
  [MOVEMENT_SALE_DECREASE]: {
    direction: '减少',
    // 库存流水回指来源明细的字段（由 v1BitableSchema 映射成中文列名）。
    ledgerSource: 'salesDetail',
    // 按顺序消耗这些状态的实时库存；null 表示不消耗既有记录。
    consumes: ['门盒', '样品'],
    // 扣到样品时要不要触发补样品提醒。
    triggerSampleReplacement: true,
  },
  [MOVEMENT_PURCHASE_INCREASE]: {
    direction: '增加',
    ledgerSource: 'purchaseInbound',
    consumes: null,
    triggerSampleReplacement: false,
  },
});

const requireMovement = (code) => {
  const movement = STOCK_MOVEMENTS[code];
  if (!movement) {
    throw new Error(`未在库存动作注册表中声明动作「${code}」：请先在行为管理表补齐该行为，再在注册表中声明其引擎语义`);
  }
  return movement;
};

// 补样品不算数量变动，但它的流水同样挂在销售明细上，用销售动作的来源字段查找。
const SALE_LEDGER_SOURCE = STOCK_MOVEMENTS[MOVEMENT_SALE_DECREASE].ledgerSource;

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

// 一次库存操作里「第 N 双」的远端标识。实时库存是一双一条记录，
// 本地日志丢失时只能靠这个键回答「这一双是不是已经建过了」。
const operationItemKey = (inventoryOperationId, sequence) => `${inventoryOperationId}:${sequence}`;

class InventoryService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('InventoryService requires gateway');
    this.gateway = options.gateway;
    this.sizeReferences = options.sizeReferences || new SizeReferenceService({ gateway: this.gateway });
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
      this.schemaValidation = (async () => {
        const result = await this.gateway.validateTables(['behavior', 'sizeManagement', 'inventoryLedger', 'liveInventory']);
        await this.sizeReferences.validateSchema(['inventoryLedger', 'liveInventory']);
        // 增加库存必须能按「库存操作键」回查，否则 create 结果未知时只能盲重建。
        await validateIdempotencyKeyFields({ gateway: this.gateway, tableKeys: ['liveInventory'] });
        return result;
      })().catch((error) => {
        this.schemaValidation = null;
        throw error;
      });
    }
    return this.schemaValidation;
  }

  async resolveStockBehavior(kind) {
    const movement = requireMovement(kind);
    const fields = this.gateway.table('behavior').fields;
    // 按「行为编码」匹配：编码是稳定标识，飞书里改中文名不影响代码。
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.code]).trim() === kind);
    if (matches.length !== 1) {
      throw new Error(`行为管理中编码为「${kind}」的行为必须且只能有一条记录，请先在行为管理表补齐`);
    }
    const behavior = matches[0];
    const name = textValue(behavior.fields?.[fields.name]).trim() || kind;
    const direction = textValue(behavior.fields?.[fields.stockDirection]).trim();
    if (direction !== movement.direction) {
      throw new Error(`请将行为管理「${name}」(${kind}) 的库存方向设置为“${movement.direction}”`);
    }
    if (behavior.fields?.[fields.enabled] !== true) {
      throw new Error(`请启用行为管理中的「${name}」(${kind})`);
    }
    return { recordId: behavior.record_id, direction };
  }

  async resolveSamplePromotionBehavior() {
    const fields = this.gateway.table('behavior').fields;
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.code]).trim() === BEHAVIOR_SAMPLE_PROMOTION);
    if (matches.length !== 1) {
      throw new Error(`行为管理中编码为「${BEHAVIOR_SAMPLE_PROMOTION}」的行为必须且只能有一条记录，请先在行为管理表补齐`);
    }
    const behavior = matches[0];
    const name = textValue(behavior.fields?.[fields.name]).trim() || BEHAVIOR_SAMPLE_PROMOTION;
    if (textValue(behavior.fields?.[fields.stockDirection]).trim() !== '不影响') {
      throw new Error(`请将行为管理「${name}」(${BEHAVIOR_SAMPLE_PROMOTION}) 的库存方向设置为“不影响”`);
    }
    if (behavior.fields?.[fields.enabled] !== true) {
      throw new Error(`请启用行为管理中的「${name}」(${BEHAVIOR_SAMPLE_PROMOTION})`);
    }
    return { recordId: behavior.record_id };
  }

  async validateStockBehaviors() {
    for (const kind of Object.keys(STOCK_MOVEMENTS)) await this.resolveStockBehavior(kind);
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
      kind: MOVEMENT_SALE_DECREASE,
      // A sale always consumes door-box stock first, then a sample. Callers
      // must not bypass that policy by choosing a source state themselves.
      state: '门盒',
      sourceRecordId: input.salesDetailRecordId,
      quantity: positiveInteger(input.quantity, '销售数量'),
    });
  }

  async getSaleResult(salesDetailRecordId) {
    const operation = await this.store.get(operationId(MOVEMENT_SALE_DECREASE, salesDetailRecordId));
    return operation?.status === 'completed' ? operation.result : null;
  }

  applyPurchase(input) {
    return this.applyChange({
      ...input,
      kind: MOVEMENT_PURCHASE_INCREASE,
      state: input.state || '门盒',
      sourceRecordId: input.purchaseInboundRecordId,
      quantity: positiveInteger(input.quantity, '采购入库数量'),
    });
  }

  async applyChange(input) {
    if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
    if (!input.sourceRecordId) throw new Error('库存变化缺少来源明细 record_id');
    const size = normalizeSize(input.size);
    const quantity = positiveInteger(input.quantity, '变动数量');
    const state = String(input.state || '门盒');
    if (!['门盒', '样品', '仓库'].includes(state)) throw new Error('库存所属状态无效');
    const stockKey = `${input.productRecordId}|${size}|${state}`;
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      const sizeReference = await this.sizeReferences.resolveByNumber(size);
      await this.resumePending(stockKey);
      const id = operationId(input.kind, input.sourceRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if ([2, 3].includes(operation.schema_version) && (
          operation.kind !== input.kind || operation.product_record_id !== input.productRecordId ||
          operation.size !== size || operation.state !== state || operation.quantity !== quantity
        )) throw new Error(`来源明细 ${input.sourceRecordId} 的库存操作内容与首次提交不一致`);
      } else {
        const movement = requireMovement(input.kind);
        const behavior = await this.resolveStockBehavior(input.kind);
        const existingLedger = await this.findLedger(movement.ledgerSource, input.sourceRecordId, behavior.recordId);
        if (existingLedger) {
          throw new Error(`来源明细 ${input.sourceRecordId} 已有库存流水，但缺少可恢复任务，请人工核对实时库存`);
        }
        const delta = behavior.direction === '减少' ? -quantity : quantity;
        const allLiveRecords = await this.gateway.listAll('liveInventory');
        // 消耗哪些状态由注册表声明；增加方向不消耗既有记录，只看目标状态本身。
        const states = movement.consumes || [state];
        const liveRecords = states.flatMap((candidateState) =>
          this.findLiveInventoryIn(allLiveRecords, input.productRecordId, sizeReference.recordId, candidateState)
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
          schema_version: 3,
          status: 'prepared',
          kind: input.kind,
          stock_key: stockKey,
          product_record_id: input.productRecordId,
          size,
          size_record_id: sizeReference.recordId,
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
    const normalizedSize = normalizeSize(size);
    const stockKey = `${productRecordId}|${normalizedSize}|门盒`;
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      const sizeReference = await this.sizeReferences.resolveByNumber(normalizedSize);
      await this.resumePending(stockKey);
      const id = samplePromotionId(salesDetailRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if (operation.product_record_id !== productRecordId || operation.size !== normalizedSize) {
          throw new Error('同一销售明细已选择其他补样品尺码，不能重复选择');
        }
      } else {
        const behavior = await this.resolveSamplePromotionBehavior();
        if (await this.findLedger(SALE_LEDGER_SOURCE, salesDetailRecordId, behavior.recordId)) {
          throw new Error('补样品流水已存在但缺少可恢复任务，请人工核对');
        }
        const liveRecords = await this.findLiveInventory(productRecordId, normalizedSize, '门盒');
        liveRecords.sort((left, right) => String(left.record_id).localeCompare(String(right.record_id)));
        if (!liveRecords.length) throw new Error(`${normalizedSize}码已没有门盒库存，请重新选择`);
        operation = await this.store.create({
          operation_id: id, type: 'sample_promotion', status: 'prepared', stock_key: stockKey,
          source_record_id: salesDetailRecordId, product_record_id: productRecordId,
          size: normalizedSize, size_record_id: sizeReference.recordId,
          live_record_id: liveRecords[0].record_id,
          behavior_record_id: behavior.recordId,
        });
      }
      return this.executeSamplePromotion(operation);
    });
  }

  async executeSamplePromotion(operation) {
    if (operation.status === 'completed') return operation.result;
    let ledger = await this.findLedger(SALE_LEDGER_SOURCE, operation.source_record_id, operation.behavior_record_id);
    const record = await this.gateway.get('liveInventory', operation.live_record_id);
    if (!record) throw new Error('待补样品的门盒库存记录不存在，请人工核对');
    const fields = this.gateway.table('liveInventory').fields;
    const sizeReference = await this.sizeReferences.resolveByNumber(operation.size);
    // Tasks written before the size field became a relation carry no
    // size_record_id, and a later link change cannot be told apart from a
    // stale one. Both stop here instead of resuming against the wrong 尺码.
    if (operation.size_record_id !== sizeReference.recordId) {
      throw new Error('补样品任务缺少可核对的尺码关联或关联已改变，请人工核对，不能自动恢复');
    }
    if (ledger && !this.ledgerMatchesOperation(ledger, {
      productRecordId: operation.product_record_id,
      sizeRecordId: sizeReference.recordId,
      behaviorRecordId: operation.behavior_record_id,
      sourceField: 'salesDetail',
      sourceRecordId: operation.source_record_id,
      // 补样品只改状态，不改变数量，流水变动数量必须为 0。
      quantityChange: 0,
    })) {
      throw new Error(`已有库存流水 ${ledger.record_id} 的货品、尺码关联、行为、来源或数量不一致，请人工核对，不能自动恢复`);
    }
    if (!linkedRecordIds(record.fields?.[fields.product]).includes(operation.product_record_id) ||
      !linkedRecordIds(record.fields?.[fields.size]).includes(sizeReference.recordId)) {
      throw new Error('待补样品的库存记录与货品或尺码不一致');
    }
    const state = textValue(record.fields?.[fields.state]);
    if (state !== '门盒' && !(ledger && state === '样品')) {
      throw new Error('待补样品的库存已不属于门盒，请人工核对');
    }
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id), size: relation(sizeReference.recordId),
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
    if (![2, 3].includes(operation.schema_version)) {
      throw new Error(`库存操作 ${operation.operation_id} 使用旧结构且尚未完成，请先人工核对，不能自动重试`);
    }
    const movement = requireMovement(operation.kind);
    const sizeReference = await this.sizeReferences.resolveByNumber(operation.size);
    if (operation.size_record_id && operation.size_record_id !== sizeReference.recordId) {
      throw new Error(`库存操作 ${operation.operation_id} 的尺码关联已改变，请人工核对`);
    }
    let ledger = await this.findOperationLedger(operation);
    await this.auditExistingOperationRecords(operation, ledger, sizeReference.recordId);
    if (operation.schema_version === 2 && !ledger) {
      throw new Error(`旧版库存操作 ${operation.operation_id} 未能确认已有流水，请人工核对，不能自动恢复`);
    }
    if (operation.direction === '增加') {
      // 先确认远端没有「同一个键出现两条」这种已经重复的事实，再写流水：
      // 已经重复时应该停下来让人核对，而不是再补一条流水把差异藏起来。
      await this.assertNoDuplicateOperationItems(operation, (operation.created_live_record_ids || []).length + 1,
        operation.quantity);
    }
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id),
        size: relation(sizeReference.recordId),
        quantityChange: operation.quantity,
        behavior: relation(operation.behavior_record_id),
        // 来源字段由注册表声明：新增动作不必再改这里。
        [movement.ledgerSource]: relation(operation.source_record_id),
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
        const liveFields = this.gateway.table('liveInventory').fields;
        if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(operation.product_record_id) ||
          !linkedRecordIds(record.fields?.[liveFields.size]).includes(sizeReference.recordId) ||
          !['门盒', '样品'].includes(textValue(record.fields?.[liveFields.state]))) {
          throw new Error(`待扣减实时库存 ${recordId} 的货品、尺码或状态已改变，请人工核对`);
        }
        await this.gateway.delete('liveInventory', recordId);
        removedIds.push(recordId);
        operation = await this.store.update(operation.operation_id, { removed_live_record_ids: removedIds });
      }
    } else {
      const expectedCreates = operation.quantity;
      while (createdIds.length < expectedCreates) {
        // 第 N 双先按「库存操作键」回查远端，再决定是否创建：
        // 飞书创建成功但本地 journal 没写下去（崩溃 / 磁盘失败 / 响应丢失）时，
        // 直接重发 create 会把库存 +1 变成 +2，而 +2 在业务上是看不出来的。
        const itemKey = operationItemKey(operation.operation_id, createdIds.length + 1);
        const created = await createOnceByKey({
          gateway: this.gateway,
          tableKey: 'liveInventory',
          keyField: OPERATION_ITEM_KEY_FIELD,
          keyValue: itemKey,
          label: `实时库存 ${itemKey}`,
          values: {
            product: relation(operation.product_record_id),
            size: relation(sizeReference.recordId),
            state: operation.state || '门盒',
            operationItemKey: itemKey,
          },
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
      consumedLiveRecordIds: movement.direction === '减少' ? removedIds : [],
    };
    if (movement.triggerSampleReplacement && result.sampleConsumedQuantity) {
      try {
        result.remainingSizes = await this.sampleReplacementCandidates(operation.product_record_id,
          { excludeRecordIds: removedIds });
      } catch (error) {
        // The stock movement is already durable. A malformed or temporarily
        // unreadable remaining row must not turn a successful delivery into a
        // failed one; the replacement card can retry this separate lookup.
        result.remainingSizes = [];
        result.replacementCandidatesUnavailable = true;
        logWarn('inventory.sample_candidates.failed', {
          operation_id: operation.operation_id,
          source_record_id: operation.source_record_id,
          error: error.message,
        });
      }
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

  // 同一个键出现两条实时库存，说明这一双已经被写过两次：真实库存已经错了。
  // 这时不能继续补写，也不能挑一条继续，只能停下让人核对。
  async assertNoDuplicateOperationItems(operation, fromSequence, toSequence) {
    if (fromSequence > toSequence) return;
    const fieldName = this.gateway.table('liveInventory').fields?.[OPERATION_ITEM_KEY_FIELD];
    if (!fieldName) return;
    const expected = new Set();
    for (let sequence = fromSequence; sequence <= toSequence; sequence += 1) {
      expected.add(operationItemKey(operation.operation_id, sequence));
    }
    const counts = new Map();
    for (const record of await this.gateway.listAll('liveInventory')) {
      const key = textValue(record.fields?.[fieldName]).trim();
      if (expected.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) {
        throw new Error(`实时库存中已存在 ${count} 条库存操作键为 ${key} 的记录，库存事实重复，请人工核对后再入库`);
      }
    }
  }

  async findOperationLedger(operation) {
    const listed = await this.findLedger(requireMovement(operation.kind).ledgerSource, operation.source_record_id,
      operation.behavior_record_id);
    if (!operation.ledger_record_id) {
      if (operation.status === 'ledger_created' && !listed) {
        throw new Error(`库存操作 ${operation.operation_id} 的已创建流水无法确认，请人工核对`);
      }
      return listed;
    }
    const direct = await this.gateway.get('inventoryLedger', operation.ledger_record_id);
    if (!direct || (listed && listed.record_id !== direct.record_id)) {
      throw new Error(`库存操作 ${operation.operation_id} 的已创建流水不存在或不一致，请人工核对`);
    }
    return direct;
  }

  // A resumed task may only reuse a ledger row we can prove belongs to it.
  // Rows written before the 尺码 field became a relation still hold a numeric
  // value (or an empty link after migration), so every existing caller audits
  // the same five facts before continuing.
  ledgerMatchesOperation(ledger, { productRecordId, sizeRecordId, behaviorRecordId,
    sourceField, sourceRecordId, quantityChange }) {
    const fields = this.gateway.table('inventoryLedger').fields;
    return singleLinked(ledger.fields?.[fields.product], productRecordId) &&
      singleLinked(ledger.fields?.[fields.size], sizeRecordId) &&
      singleLinked(ledger.fields?.[fields.behavior], behaviorRecordId) &&
      singleLinked(ledger.fields?.[fields[sourceField]], sourceRecordId) &&
      Number(ledger.fields?.[fields.quantityChange]) === quantityChange;
  }

  async auditExistingOperationRecords(operation, ledger, sizeRecordId) {
    const manual = (reason) => {
      throw new Error(`库存操作 ${operation.operation_id} ${reason}，请人工核对，不能自动恢复`);
    };
    if (ledger && !this.ledgerMatchesOperation(ledger, {
      productRecordId: operation.product_record_id,
      sizeRecordId,
      behaviorRecordId: operation.behavior_record_id,
      sourceField: requireMovement(operation.kind).ledgerSource,
      sourceRecordId: operation.source_record_id,
      quantityChange: operation.quantity,
    })) {
      manual(`已有库存流水 ${ledger.record_id} 的货品、尺码关联、行为、来源或数量不一致`);
    }
    const createdIds = operation.created_live_record_ids || [];
    const removedIds = operation.removed_live_record_ids || [];
    const selectedIds = operation.live_record_ids || [];
    if (new Set(createdIds).size !== createdIds.length || createdIds.length > operation.quantity ||
      new Set(removedIds).size !== removedIds.length ||
      removedIds.some((recordId) => !selectedIds.includes(recordId))) {
      manual('已记录的实时库存 ID 不一致');
    }
    if (operation.schema_version === 2 && removedIds.length) {
      manual('旧版销售任务已有库存删除，已删除记录的尺码关联无法再核实');
    }
    const liveFields = this.gateway.table('liveInventory').fields;
    if (operation.direction === '增加') {
      for (const [index, recordId] of createdIds.entries()) {
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record || !singleLinked(record.fields?.[liveFields.product], operation.product_record_id) ||
          !singleLinked(record.fields?.[liveFields.size], sizeRecordId) ||
          textValue(record.fields?.[liveFields.state]) !== operation.state) {
          manual(`已有实时库存 ${recordId} 的货品、尺码关联或状态不一致`);
        }
        // 库存操作键是「这一双属于本次操作第几条」的证明。老记录可能没有这个值
        // （字段是后加的），但一旦写了就必须和本地清单对得上，否则无法区分
        // 「这就是我要的那一双」和「别的操作写进来的同一货品尺码」。
        const recordedKey = textValue(record.fields?.[liveFields[OPERATION_ITEM_KEY_FIELD]]).trim();
        if (recordedKey && recordedKey !== operationItemKey(operation.operation_id, index + 1)) {
          manual(`已有实时库存 ${recordId} 的库存操作键与本地记录不一致`);
        }
      }
    } else if (operation.direction === '减少') {
      if (selectedIds.length !== operation.quantity) manual('待扣减实时库存数量不一致');
      for (const recordId of selectedIds) {
        if (removedIds.includes(recordId)) continue;
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record || !singleLinked(record.fields?.[liveFields.product], operation.product_record_id) ||
          !singleLinked(record.fields?.[liveFields.size], sizeRecordId) ||
          !['门盒', '样品'].includes(textValue(record.fields?.[liveFields.state]))) {
          manual(`待扣减实时库存 ${recordId} 的货品、尺码关联或状态不一致`);
        }
      }
    } else {
      manual('库存方向无效');
    }
  }

  // ledgerSource 是库存流水里回指来源明细的语义字段名（见 v1BitableSchema）。
  async findLedger(ledgerSource, sourceRecordId, behaviorRecordId) {
    const table = this.gateway.table('inventoryLedger');
    const fieldName = table.fields[ledgerSource];
    const records = await this.gateway.listAll('inventoryLedger');
    const matches = records.filter((record) =>
      linkedRecordIds(record.fields?.[fieldName]).includes(sourceRecordId) &&
      (!behaviorRecordId || linkedRecordIds(record.fields?.[table.fields.behavior]).includes(behaviorRecordId)));
    if (matches.length > 1) throw new Error(`来源明细 ${sourceRecordId} 存在重复库存流水`);
    return matches[0] || null;
  }

  findLiveInventoryIn(records, productRecordId, sizeRecordId, state = '门盒') {
    const table = this.gateway.table('liveInventory');
    return records.filter(
      (record) =>
        linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId) &&
        linkedRecordIds(record.fields?.[table.fields.size]).includes(sizeRecordId) &&
        textValue(record.fields?.[table.fields.state]) === state
    );
  }

  async findLiveInventory(productRecordId, size, state = '门盒') {
    const sizeReference = await this.sizeReferences.resolveByNumber(size);
    return this.findLiveInventoryIn(await this.gateway.listAll('liveInventory'), productRecordId,
      sizeReference.recordId, state);
  }

  async sampleReplacementCandidates(productRecordId, { excludeRecordIds = [] } = {}) {
    const table = this.gateway.table('liveInventory');
    const bySize = new Map();
    const excluded = new Set(excludeRecordIds);
    for (const record of await this.gateway.listAll('liveInventory')) {
      if (excluded.has(record.record_id)) continue;
      if (!linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId)) continue;
      const size = (await this.sizeReferences.resolveLinkedCell(record.fields?.[table.fields.size])).size;
      const state = textValue(record.fields?.[table.fields.state]);
      if (!['门盒', '样品', '仓库'].includes(state)) continue;
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
