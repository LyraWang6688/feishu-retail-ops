'use strict';

/**
 * 验收 → P发生明细（tblWaafeodl2oILI）。
 *
 * 2026-11-19 业务负责人：每验收完一家供应商，把这家本次填的货款金额写一条 P发生明细；
 * 交易明细ID = 批次号-供应商名；最新余额字段已从生产表删除，不写；发生行为是 Lookup，不写。
 * 幂等：先按交易明细ID回查，已有就跳过。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const CONFIG = require('../config/purchasePaymentDetail');
const { equalsFormula } = require('./bitableFilterFormula');
const { textValue } = require('./v1BitableGateway');
const { relation } = require('./v1ReferenceResolver');
const { logInfo, logWarn } = require('../utils/logger');

const safePart = (value) => String(value || '').trim().replace(/[\\/:*?"<>|\r\n]/g, '_');

const createPurchasePaymentDetailService = ({ gateway, config = CONFIG } = {}) => {
  if (!gateway) throw new Error('PurchasePaymentDetailService requires gateway');
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
    batchNo = '', batchRecordId = '', supplierRecordId = '', amount, correlation = {},
  } = {}) => {
    const wantedNo = String(batchNo || '').trim();
    const batchId = String(batchRecordId || '').trim();
    const supplierId = String(supplierRecordId || '').trim();
    const value = Number(amount);
    if (!wantedNo || !batchId || !supplierId || !Number.isFinite(value)) {
      return { ok: false, skipped: true, reason: 'missing_identity_or_amount' };
    }
    if (!fields.transactionDetailId || !fields.supplier || !fields.batchNo || !fields.amount) {
      throw new Error('P发生明细未配置交易明细ID/供应商/报货批次号/发生额字段映射');
    }
    // 单测 / 未接线的替身网关可能没有 listByFilter：不做无幂等保证的盲写，跳过并记录。
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
    let existing = [];
    if (formula) {
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
      supplier: relation(supplierId),
      batchNo: relation(batchId),
      amount: value,
    }, { correlation });
    logInfo(config.events.created, {
      batch_no: wantedNo, batch_record_id: batchId, supplier_record_id: supplierId,
      transaction_detail_id: transactionDetailId, amount: value,
      record_id: created?.recordId || created?.record_id || '',
    });
    return {
      ok: true, created: true, transaction_detail_id: transactionDetailId,
      record_id: created?.recordId || created?.record_id || '',
    };
  };

  return { writeForSupplier };
};

module.exports = { createPurchasePaymentDetailService };
