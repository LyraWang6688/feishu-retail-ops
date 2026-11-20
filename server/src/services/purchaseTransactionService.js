'use strict';

/**
 * 验收 / 退货 → P交易明细（tblYLkCKlTw9CB9P）。
 *
 * 2026-11-20：P发生明细已删除；验收/退货都只写：
 *   · 交易明细ID = 批次号-供应商名
 *   · 报货批次号 = 关联供应主表
 * 不写供应商、交易额、交易方向、凭证、发生行为。
 * 幂等：先按交易明细ID回查，已有就跳过。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const CONFIG = require('../config/purchaseTransaction');
const { equalsFormula } = require('./bitableFilterFormula');
const { textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
const { logInfo, logWarn } = require('../utils/logger');

const safePart = (value) => String(value || '').trim().replace(/[\/:*?"<>|\r\n]/g, '_');

const createPurchaseTransactionService = ({ gateway, config = CONFIG } = {}) => {
  if (!gateway) throw new Error('PurchaseTransactionService requires gateway');
  const target = V1_BITABLE_SCHEMA.tables[config.targetTableKey];
  const fields = target?.fields || {};

  const supplierNameOf = async (supplierRecordId) => {
    const id = String(supplierRecordId || '').trim();
    if (!id) return '';
    try {
      const record = await gateway.get('supplier', id);
      const name = textValue(record?.fields?.[V1_BITABLE_SCHEMA.tables.supplier.fields.name]).trim();
      return name || id;
    } catch (error) {
      return id;
    }
  };

  const idOf = ({ batchNo, supplierName }) => String(config.idTemplate || '{batchNo}-{supplierName}')
    .replace(/\{batchNo\}/g, safePart(batchNo))
    .replace(/\{supplierName\}/g, safePart(supplierName));

  const writeForSupplier = async ({
    batchNo = '', batchRecordId = '', supplierRecordId = '', correlation = {},
  } = {}) => {
    const wantedNo = String(batchNo || '').trim();
    const batchId = String(batchRecordId || '').trim();
    const supplierId = String(supplierRecordId || '').trim();
    if (!wantedNo || !batchId || !supplierId) {
      return { ok: false, skipped: true, reason: 'missing_identity' };
    }
    if (!fields.transactionDetailId || !fields.batchNo) {
      throw new Error('P交易明细未配置交易明细ID/报货批次号字段映射');
    }
    if (typeof gateway.listByFilter !== 'function') {
      logWarn(config.events.failed, {
        batch_no: wantedNo, supplier_record_id: supplierId,
        reason: 'list_by_filter_unavailable',
      });
      return { ok: false, skipped: true, reason: 'list_by_filter_unavailable' };
    }
    const supplierName = await supplierNameOf(supplierId);
    const transactionDetailId = idOf({ batchNo: wantedNo, supplierName });
    const formula = equalsFormula(fields.transactionDetailId, transactionDetailId);
    if (formula) {
      let existing = [];
      try {
        existing = await gateway.listByFilter(config.targetTableKey, formula);
      } catch (error) {
        logWarn(config.events.failed, {
          batch_no: wantedNo, supplier_record_id: supplierId,
          transaction_detail_id: transactionDetailId,
          reason: 'dedupe_read_failed', error: String(error?.message || error).slice(0, 200),
        });
        return { ok: false, skipped: true, reason: 'dedupe_read_failed' };
      }
      if (Array.isArray(existing) && existing.length) {
        logInfo(config.events.skipped, {
          batch_no: wantedNo, supplier_record_id: supplierId,
          transaction_detail_id: transactionDetailId, reason: 'already_synced',
        });
        return { ok: true, skipped: true, reason: 'already_synced', transaction_detail_id: transactionDetailId };
      }
    }
    const created = await gateway.create(config.targetTableKey, {
      transactionDetailId,
      batchNo: relation(batchId),
    }, { correlation });
    logInfo(config.events.created, {
      batch_no: wantedNo, batch_record_id: batchId, supplier_record_id: supplierId,
      transaction_detail_id: transactionDetailId,
      record_id: created?.recordId || created?.record_id || '',
    });
    return {
      ok: true, created: true, transaction_detail_id: transactionDetailId,
      record_id: created?.recordId || created?.record_id || '',
    };
  };

  return { writeForSupplier };
};

module.exports = { createPurchaseTransactionService };
