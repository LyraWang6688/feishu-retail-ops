'use strict';

/**
 * 销售明细「尺码更正」的库存端口（2026-11-28）。
 *
 * 业务口径（业务负责人定稿）：
 *   · 现货 → 现货：把新尺码的一条实时库存行改成原尺码；原销售出库流水尺码改新尺码；
 *   · 现货 → 预订：原尺码新增一条实时库存行；原销售出库流水删除（预订没有出库事实）；
 *   · 预订 → 现货：删除新尺码的一条实时库存行；补一条销售出库流水；
 *   · 预订 → 预订：库存 / 流水都不动。
 *
 * ⚠️ 这是**库存引擎内部端口**：route / correction service 都不许直接写
 *    liveInventory / inventoryLedger；所有实时库存和流水动作都在这里收口。
 */
const { relation } = require('../v1ReferenceResolver');
const { personPatch } = require('../personFieldService');
const { createOnceByKey, OPERATION_ITEM_KEY_FIELD } = require('../../infrastructure/idempotencyKey');
const { strictLinkedRecordIds } = require('../strictLinkIds');
const { MOVEMENT_SALE_DECREASE } = require('./movements');

async function correctSaleDetailSize(input = {}) {
  const salesDetailRecordId = String(input.salesDetailRecordId || '').trim();
  const salesEntryRecordId = String(input.salesEntryRecordId || '').trim();
  const productRecordId = String(input.productRecordId || '').trim();
  const fromInStock = input.fromInStock === true;
  const toInStock = input.toInStock === true;
  if (!salesDetailRecordId || !salesEntryRecordId || !productRecordId) {
    throw new Error('尺码更正缺少销售明细 / 销售单 / 货品身份');
  }
  if (!fromInStock && !toInStock) return { inventory: 'none', ledger: 'none' };

  const oldSize = await this.sizeReferences.resolveByNumber(input.fromSize);
  const newSize = await this.sizeReferences.resolveByNumber(input.toSize);
  if (!oldSize?.recordId || !newSize?.recordId) throw new Error('尺码关联解析失败');
  if (oldSize.recordId === newSize.recordId && fromInStock === toInStock) {
    return { inventory: 'none', ledger: 'none' };
  }

  return this.runForStocks([`${productRecordId}|${input.fromSize}`, `${productRecordId}|${input.toSize}`], async () => {
    await this.ensureSchema();
    const decreaseBehavior = await this.resolveStockBehavior(MOVEMENT_SALE_DECREASE);
    const operation = await this.findOperationBySource(salesDetailRecordId).catch(() => null);
    const ledger = operation?.ledger_record_id
      ? await this.gateway.get('inventoryLedger', operation.ledger_record_id).catch(() => null)
      : await this.findLedger('salesDetail', salesEntryRecordId, decreaseBehavior.recordId).catch(() => null);
    const allLive = await this.readLiveInventoryForProduct(productRecordId);
    const liveOf = (sizeRecordId) => this.sortLiveInventoryForConsumption(
      allLive.filter((row) => strictLinkedRecordIds(row.fields?.[this.gateway.table('liveInventory').fields.size]).includes(sizeRecordId)),
    );

    // 现货 → 现货：把新尺码的一条库存行改成原尺码；原出库流水改尺码。
    if (fromInStock && toInStock) {
      const target = liveOf(newSize.recordId)[0];
      if (!target) throw new Error(`新尺码 ${input.toSize} 当前没有可扣库存，请先核对库存`);
      await this.gateway.update('liveInventory', target.record_id, { size: relation(oldSize.recordId) });
      if (ledger) await this.gateway.update('inventoryLedger', ledger.record_id, { size: relation(newSize.recordId) });
      return { inventory: 'row_swapped', ledger: ledger ? 'updated' : 'none' };
    }

    // 现货 → 预订：原尺码回库；原出库流水删除。
    if (fromInStock && !toInStock) {
      const key = `correction:${input.correctionId || salesDetailRecordId}:restore`;
      const liveFields = this.gateway.table('liveInventory').fields;
      await createOnceByKey({
        gateway: this.gateway,
        tableKey: 'liveInventory',
        keyField: OPERATION_ITEM_KEY_FIELD,
        keyValue: key,
        label: `实时库存 ${key}`,
        correlation: input.correlation || {},
        values: {
          product: relation(productRecordId),
          size: relation(oldSize.recordId),
          state: '门盒',
          operationItemKey: key,
          // 测试 Base 可能还没有「仓库员」列；生产有。没有映射就不写，不能让整条更正失败。
          ...(liveFields.warehouseStaff ? personPatch({
            tableKey: 'liveInventory', fieldKey: 'warehouseStaff', operatorOpenId: input.operatorOpenId,
          }) : {}),
        },
      });
      if (ledger) await this.gateway.delete('inventoryLedger', ledger.record_id).catch(() => undefined);
      return { inventory: 'restored', ledger: ledger ? 'deleted' : 'none' };
    }

    // 预订 → 现货：删除新尺码的一条库存行；补一条销售出库流水。
    const target = liveOf(newSize.recordId)[0];
    if (!target) throw new Error(`新尺码 ${input.toSize} 当前没有可扣库存，请先核对库存`);
    await this.gateway.delete('liveInventory', target.record_id);
    if (!ledger) {
      await this.gateway.create('inventoryLedger', {
        product: relation(productRecordId),
        size: relation(newSize.recordId),
        quantityChange: 1,
        behavior: relation(decreaseBehavior.recordId),
        salesDetail: relation(salesEntryRecordId),
        ...personPatch({
          tableKey: 'inventoryLedger', fieldKey: 'operator', operatorOpenId: input.operatorOpenId,
        }),
      }, { correlation: input.correlation || {} });
    }
    return { inventory: 'consumed', ledger: ledger ? 'kept' : 'created' };
  });
}

module.exports = { correctSaleDetailSize };
