'use strict';

/**
 * 「配品销售 → S交易明细」同步 service（2026-11-17）。
 *
 * 业务来源：飞书工作流「配品销售同步」（wkfJ6Uo7GihkbmGF）改为代码。
 * 口径（逐条对齐工作流，另补两条防错账）：
 *   · 触发：配品销售**新增**记录（record_added）；
 *   · 条件：名称非空 且 数量 >= minQuantity；
 *   · 目标：S交易明细（paymentRecord）新增一条：
 *       支付方式 ← 收款方式
 *       收支方向 = 收入
 *       交易金额 ← 金额（要求 > 0）
 *       钱款状态 = 已收款
 *       收付日 ← 配品销售.销售日（拿不到才退记录创建时间/处理时刻）
 *   · 幂等：交易明细ID = PX-<配品销售 record_id>；写前按它回查，已有就跳过；
 *   · 只读源表 / 只写目标表；失败不吞，记录日志。
 *
 * 🔴 上线前先停飞书工作流，否则代码和工作流会给同一条记录各写一条。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { ACCESSORY_SALE_SYNC } = require('../config/accessorySaleSync');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { equalsFormula } = require('./bitableFilterFormula');
const { textValue } = require('./v1Gateway/cells');
const { relation } = require('./v1ReferenceResolver');
const { logInfo, logWarn } = require('../utils/logger');

/** 关联 cell → record_id 数组（兼容 [{id}] / [{record_ids}] / 字符串；与 issue #1074 口径一致）。 */
const recordIdsOf = (value) => {
  const ids = [];
  const push = (id) => {
    const text = String(id ?? '').trim();
    if (text) ids.push(text);
  };
  const walk = (item) => {
    if (item === null || item === undefined) return;
    if (typeof item === 'string') return push(item);
    if (Array.isArray(item)) return item.forEach(walk);
    if (Array.isArray(item.record_ids)) return item.record_ids.forEach(walk);
    if (item.recordId) return push(item.recordId);
    if (item.id) return push(item.id);
    return undefined;
  };
  walk(value);
  return [...new Set(ids)];
};

const amountOf = (value) => {
  const n = Number(textValue(value));
  return Number.isFinite(n) ? n : NaN;
};

const createAccessorySaleSyncService = ({
  gateway,
  config = ACCESSORY_SALE_SYNC,
  now = () => Date.now(),
  logger = { logInfo, logWarn },
} = {}) => {
  if (!gateway) throw new Error('AccessorySaleSyncService requires gateway');
  const log = {
    info: typeof logger.logInfo === 'function' ? logger.logInfo : logInfo,
    warn: typeof logger.logWarn === 'function' ? logger.logWarn : logWarn,
  };
  // 同一配品销售记录的重复事件串行；交易明细ID 幂等键兜底。
  const lock = new KeyedSerialQueue();

  const receiptIdOf = (recordId) => config.receiptPrefix + '-' + String(recordId || '').trim();

  const processRecord = async (recordId) => {
    const sourceRecordId = String(recordId || '').trim();
    if (!config.sourceTableId) {
      log.warn('accessory.sale.sync.skipped', { record_id: sourceRecordId, reason: 'source_table_not_configured' });
      return { recordId: sourceRecordId, skipped: true, reason: 'source_table_not_configured' };
    }
    if (!sourceRecordId) return { recordId: '', skipped: true, reason: 'missing_record_id' };

    const receiptId = receiptIdOf(sourceRecordId);
    return lock.run('accessory-sale:' + receiptId, async () => {
      let record;
      try {
        record = await gateway.getByTableId({
          tableId: config.sourceTableId,
          recordId: sourceRecordId,
          reason: 'accessory_sale_sync',
        });
      } catch (error) {
        log.warn('accessory.sale.sync.failed', {
          record_id: sourceRecordId, step: 'read_source', error: error.message,
        });
        return { recordId: sourceRecordId, ok: false, reason: 'read_source_failed', error: error.message };
      }
      if (!record) {
        log.warn('accessory.sale.sync.skipped', { record_id: sourceRecordId, reason: 'source_not_found' });
        return { recordId: sourceRecordId, skipped: true, reason: 'source_not_found' };
      }

      const fields = record.fields || {};
      const F = config.sourceFields;
      const nameIds = recordIdsOf(fields[F.name]);
      const quantity = amountOf(fields[F.quantity]);
      const amount = amountOf(fields[F.amount]);
      if (!nameIds.length) {
        log.warn('accessory.sale.sync.skipped', { record_id: sourceRecordId, reason: 'name_empty' });
        return { recordId: sourceRecordId, skipped: true, reason: 'name_empty' };
      }
      if (!Number.isFinite(quantity) || quantity < Number(config.minQuantity || 1)) {
        log.warn('accessory.sale.sync.skipped', { record_id: sourceRecordId, reason: 'quantity_invalid', quantity });
        return { recordId: sourceRecordId, skipped: true, reason: 'quantity_invalid' };
      }
      if (config.requirePositiveAmount && (!Number.isFinite(amount) || amount <= 0)) {
        log.warn('accessory.sale.sync.skipped', { record_id: sourceRecordId, reason: 'amount_invalid', amount });
        return { recordId: sourceRecordId, skipped: true, reason: 'amount_invalid' };
      }

      const targetTableKey = config.targetTableKey;
      const target = V1_BITABLE_SCHEMA.tables[targetTableKey];
      const targetFields = target?.fields || {};
      if (!target?.tableId || !targetFields.receiptId || !targetFields.amount || !targetFields.method) {
        log.warn('accessory.sale.sync.skipped', {
          record_id: sourceRecordId,
          reason: 'target_mapping_missing',
          has_receipt: Boolean(targetFields.receiptId),
          has_amount: Boolean(targetFields.amount),
          has_method: Boolean(targetFields.method),
        });
        return { recordId: sourceRecordId, skipped: true, reason: 'target_mapping_missing' };
      }

      // 幂等：按交易明细ID 回查。读失败时**不创建**（宁可漏一条，也不重复记账）。
      let existing;
      try {
        const formula = equalsFormula(targetFields.receiptId, receiptId);
        existing = formula ? await gateway.listByFilter(targetTableKey, formula) : null;
      } catch (error) {
        log.warn('accessory.sale.sync.failed', {
          record_id: sourceRecordId, step: 'dedupe_read', error: error.message,
        });
        return { recordId: sourceRecordId, ok: false, reason: 'dedupe_read_failed', error: error.message };
      }
      if (Array.isArray(existing) && existing.length) {
        log.info('accessory.sale.sync.skipped', {
          record_id: sourceRecordId, reason: 'already_synced', receipt_id: receiptId,
        });
        return { recordId: sourceRecordId, skipped: true, reason: 'already_synced', receipt_id: receiptId };
      }

      const methodId = recordIdsOf(fields[F.method])[0] || '';
      // 收付日：优先用源表「销售日」（业务负责人 2026-11-17：比处理时刻准确）；
      // 拿不到才退记录创建时间，再拿不到才用处理时刻。
      const saleDate = amountOf(fields[F.saleDate]);
      const sourceCreatedAt = Number(record.created_time);
      const receivedAt = [saleDate, sourceCreatedAt]
        .find((value) => Number.isFinite(value) && value > 0) || now();
      try {
        const created = await gateway.create(config.targetTableKey, {
          ...(methodId ? { method: relation(methodId) } : {}),
          amount,
          tradeDirection: config.direction,
          status: config.status,
          receivedAt,
          receiptId,
        }, { correlation: { task_id: receiptId } });
        log.info('accessory.sale.sync.created', {
          record_id: sourceRecordId,
          receipt_id: receiptId,
          payment_record_id: created?.recordId || '',
          amount,
          method_record_id: methodId,
        });
        return {
          recordId: sourceRecordId,
          ok: true,
          created: true,
          receipt_id: receiptId,
          payment_record_id: created?.recordId || '',
        };
      } catch (error) {
        log.warn('accessory.sale.sync.failed', {
          record_id: sourceRecordId, step: 'create_target', receipt_id: receiptId, error: error.message,
        });
        return { recordId: sourceRecordId, ok: false, reason: 'create_failed', error: error.message };
      }
    });
  };

  const handleTableChanges = async (actionList = []) => {
    const actions = Array.isArray(actionList) ? actionList : [];
    const recordIds = [];
    for (const action of actions) {
      const name = String(action?.action || '');
      if (!config.triggerActions.includes(name)) continue;
      const recordId = String(action?.record_id || '').trim();
      if (recordId) recordIds.push(recordId);
    }
    if (!recordIds.length) return { processed: 0, results: [] };
    const results = [];
    for (const recordId of [...new Set(recordIds)]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        results.push(await processRecord(recordId));
      } catch (error) {
        log.warn('accessory.sale.sync.failed', { record_id: recordId, step: 'unhandled', error: error.message });
        results.push({ recordId, ok: false, reason: 'unhandled', error: error.message });
      }
    }
    return { processed: results.length, results };
  };

  return { processRecord, handleTableChanges };
};

module.exports = { createAccessorySaleSyncService };
