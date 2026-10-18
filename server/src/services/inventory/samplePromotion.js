// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 1804-1845 / 1847-1906 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 补样品通路：promoteToSample（准备）+ executeSamplePromotion（执行，门盒 → 样品）。
const { linkedRecordIds, textValue } = require('../v1BitableGateway');
const { relation } = require('../v1ReferenceResolver');
const { normalizeSize } = require('../sizeReferenceService');
const { logInfo } = require('../../utils/logger');
const { correlationFields } = require('../../utils/correlationFields');
const { invalidateLiveInventorySnapshot } = require('../liveInventorySnapshot');
const { SALE_LEDGER_SOURCE } = require('./movements');
const {
  samplePromotionId,
  stockKeyLabelFields,
  correlationPatch,
  stockKeyLabelOfOperation,
} = require('./keys');

async function promoteToSample(input = {}, options = {}) {
    const { salesDetailRecordId, productRecordId, size } = input;
    if (!salesDetailRecordId || !productRecordId) throw new Error('补样品缺少销售明细或货品');
    const normalizedSize = normalizeSize(size);
    const stockKey = `${productRecordId}|${normalizedSize}|门盒`;
    const correlation = correlationFields(options.correlation);
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
          // 同 applyChange：抄这次已经读到的门盒记录上的「库存键」，零额外请求。
          ...stockKeyLabelFields({
            record: liveRecords[0],
            fieldName: this.gateway.table('liveInventory').fields.stockKey,
            fallback: options.stockKeyLabel,
          }),
          ...correlationPatch(correlation),
          source_record_id: salesDetailRecordId, product_record_id: productRecordId,
          size: normalizedSize, size_record_id: sizeReference.recordId,
          live_record_id: liveRecords[0].record_id,
          behavior_record_id: behavior.recordId,
        });
      }
      return this.executeSamplePromotion(operation);
    });
  }

async function executeSamplePromotion(operation) {
    if (operation.status === 'completed') return operation.result;
    const correlation = correlationFields(operation.correlation);
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
      }, { correlation });
      ledger = { record_id: created.recordId };
    }
    operation = await this.store.update(operation.operation_id, {
      status: 'ledger_created', ledger_record_id: ledger.record_id,
    });
    if (state === '门盒') {
      await this.gateway.update('liveInventory', operation.live_record_id, { state: '样品' }, { correlation });
    }
    const result = { liveRecordId: operation.live_record_id, ledgerRecordId: ledger.record_id,
      productRecordId: operation.product_record_id, size: operation.size };
    await this.store.update(operation.operation_id, { status: 'completed', result });
    // 「相关库存日志」也两种键都给（stock_key + stock_key_label），见文件顶部注释。
    logInfo('inventory.sample.promoted', { operation_id: operation.operation_id,
      stock_key: operation.stock_key,
      ...stockKeyLabelOfOperation(operation),
      live_record_id: operation.live_record_id, ledger_record_id: ledger.record_id, size: operation.size,
      ...correlation });
    // ⭐ 2026-10-09：补样品**改了实时库存**（门盒 → 样品）⇒ 当场作废扫码页那份内存快照。
    invalidateLiveInventorySnapshot('inventory_changed');
    return result;
  }

module.exports = {
  promoteToSample,
  executeSamplePromotion,
};
