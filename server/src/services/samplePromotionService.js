'use strict';

/**
 * 补样品（2026-11-18）：销售成功后，把她选中的尺码的一双改成「样品」。
 *
 * 复用既有「库存单双状态调整」的写法：
 *   · 改「实时库存.所属状态」；
 *   · 写一条 STOCK_TO_SAMPLE 库存流水（变动数量 0，走 writeManualLedger）。
 *
 * 🔴 只做「门盒 / 空状态 → 样品」；该尺码已经有样品 ⇒ 直接跳过（幂等）。
 * 🔴 失败只返回失败，不抛给销售层 —— 销售已经成功，不能因为补样品把它改成失败。
 */
const { ADJUSTMENT_BEHAVIORS } = require('./inventory/movements');
const { SAMPLE_PROMOTION } = require('../config/samplePromotion');
const { writeManualLedger } = require('./inventory/manualLedger');
const { invalidateLiveInventorySnapshot } = require('./liveInventorySnapshot');
const { textValue } = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { person } = require('./v1ReferenceResolver');
const { logInfo, logWarn } = require('../utils/logger');

const createSamplePromotionService = ({ inventory, logger = { logInfo, logWarn } } = {}) => {
  const promote = async ({
    productRecordId, size, salesDetailRecordId = '', salesEntryRecordId = '', operatorOpenId = '', requestId = '',
  } = {}) => {
    const product = String(productRecordId || '').trim();
    const wanted = Number(size);
    if (!inventory?.gateway || !product || !Number.isInteger(wanted) || wanted <= 0) {
      return { ok: false, code: 'invalid_input' };
    }
    const table = inventory.gateway.table('liveInventory');
    const records = await inventory.readLiveInventoryForProduct(product);
    const rows = [];
    for (const record of Array.isArray(records) ? records : []) {
      const linked = strictLinkedRecordIds(record?.fields?.[table.fields.size]);
      if (!linked.length) continue;
      try {
        const resolved = await inventory.sizeReferences.resolveLinkedCell(record.fields?.[table.fields.size]);
        if (Number(resolved?.size) !== wanted) continue;
        rows.push({ record, sizeRecordId: linked[0], state: textValue(record?.fields?.[table.fields.state]) });
      } catch (error) {
        // 尺码关联认不出：不算候选，也不猜（与既有库存逻辑一致）。
      }
    }
    if (!rows.length) {
      logger.logWarn('inventory.sample.promotion_skipped', {
        reason: 'no_stock', product_record_id: product, size: wanted,
        sales_detail_record_id: salesDetailRecordId, request_id: requestId,
      });
      return { ok: false, code: 'no_stock' };
    }
    // 已经有样品 ⇒ 不重复补（重试 / 她选了一个已有样品的尺码）。
    if (rows.some((row) => row.state === SAMPLE_PROMOTION.texts.tagSample)) {
      return { ok: true, skipped: 'already_sample', size: wanted };
    }
    const candidates = rows
      .filter((row) => row.state === SAMPLE_PROMOTION.texts.tagDoorbox || row.state === '')
      .sort((left, right) => String(left.record.record_id).localeCompare(String(right.record.record_id)));
    const target = candidates[0];
    if (!target) {
      logger.logWarn('inventory.sample.promotion_skipped', {
        reason: 'no_promotable_state', product_record_id: product, size: wanted,
        states: rows.map((row) => row.state), sales_detail_record_id: salesDetailRecordId, request_id: requestId,
      });
      return { ok: false, code: 'no_promotable_state' };
    }
    const correlation = { task_id: String(requestId || ''), audit_domain: 'inventoryManual' };
    await inventory.gateway.update('liveInventory', target.record.record_id, {
      state: SAMPLE_PROMOTION.texts.tagSample,
      ...(operatorOpenId ? { warehouseStaff: person(operatorOpenId) } : {}),
    }, { correlation });
    await writeManualLedger({
      inventory,
      changes: [{
        record_id: target.record.record_id,
        productRecordId: product,
        sizeRecordId: target.sizeRecordId,
        behaviorCode: ADJUSTMENT_BEHAVIORS.DOORBOX_TO_SAMPLE,
        salesEntryRecordId,
      }],
      operatorOpenId,
      correlation,
    });
    invalidateLiveInventorySnapshot('sample_promotion');
    logger.logInfo('inventory.sample.promoted', {
      product_record_id: product, size: wanted, record_id: target.record.record_id,
      from_state: target.state || '', sales_detail_record_id: salesDetailRecordId, request_id: requestId,
    });
    return { ok: true, recordId: target.record.record_id, size: wanted, fromState: target.state || '' };
  };
  return { promote };
};

module.exports = { createSamplePromotionService };
