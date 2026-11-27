'use strict';

/**
 * 扫码当季调整 service（2026-11-25）。
 *
 * 结构：
 *   1. 按 requestId 建本地 WAL（JsonTaskStore）
 *   2. 精确定位 liveInventory 记录，只改 season / warehouseStaff
 *   3. 每条记录写一条 inventoryLedger（变动数量 0）
 *   4. 失败后按 WAL 续跑：已改当季的只补流水
 *
 * 不直接复用 InventoryService.applyChange：它是数量通路，状态类行为会被 requireQuantityMovement 拦。
 * 复用它的操作日志思路、行为解析、实时库存读取、操作人、快照失效。
 */
const crypto = require('node:crypto');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { personPatch } = require('./personFieldService');
const { relation } = require('./v1ReferenceResolver');
const { textValue } = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { invalidateLiveInventorySnapshot } = require('./liveInventorySnapshot');
const { logInfo } = require('../utils/logger');
const { SEASON_ADJUSTMENT } = require('../config/seasonAdjustment');

const positiveInteger = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const keyOf = (item) => [item.productRecordId, item.sizeRecordId, item.state, item.currentSeason].join('|');

const createSeasonAdjustmentService = ({ inventory, store, config = SEASON_ADJUSTMENT, now = () => Date.now() } = {}) => {
  if (!inventory?.gateway) throw new Error('SeasonAdjustmentService requires inventory');
  const taskStore = store || new JsonTaskStore({ dir: config.dir, idField: 'operation_id' });
  const liveFields = () => inventory.gateway.table('liveInventory').fields;
  const operationIdOf = (requestId) => 'season_' + String(requestId || '').replace(/[^a-zA-Z0-9_-]/g, '_');

  const readProduct = async (productRecordId) => {
    if (typeof inventory.readLiveInventoryForProduct === 'function') {
      return inventory.readLiveInventoryForProduct(productRecordId);
    }
    const rows = await inventory.gateway.listAll('liveInventory');
    return rows.filter((row) => strictLinkedRecordIds(row.fields?.[liveFields().product]).includes(productRecordId));
  };

  const plan = async ({ requestId, changes = [], operatorOpenId = '' } = {}) => {
    const opId = operationIdOf(requestId);
    if (!requestId) return { ok: false, code: 'request_id_missing' };
    const existing = await taskStore.get(opId);
    if (existing) return { ok: true, operation: existing, reused: true };
    const list = Array.isArray(changes) ? changes : [];
    if (!list.length) return { ok: false, code: 'empty' };
    if (list.length > Number(config.maxChanges)) return { ok: false, code: 'too_many' };
    const seen = new Set();
    const normalized = [];
    for (const item of list) {
      const productRecordId = String(item?.productRecordId || '').trim();
      const state = String(item?.state || '').trim();
      const size = positiveInteger(item?.size);
      const quantity = positiveInteger(item?.quantity);
      const currentSeason = item?.currentSeason;
      if (!productRecordId || !size || !state || typeof currentSeason !== 'boolean' || !quantity) {
        return { ok: false, code: 'invalid_change' };
      }
      const targetSeason = !currentSeason;
      if (item?.targetSeason !== undefined && item.targetSeason !== targetSeason) {
        return { ok: false, code: 'invalid_target' };
      }
      const key = productRecordId + '|' + size + '|' + state + '|' + currentSeason;
      if (seen.has(key)) return { ok: false, code: 'duplicate_change' };
      seen.add(key);
      normalized.push({ productRecordId, size, state, quantity, currentSeason, targetSeason });
    }

    const rows = [];
    for (const productId of [...new Set(normalized.map((item) => item.productRecordId))]) {
      rows.push(...await readProduct(productId));
    }
    const sizeRefs = new Map();
    const items = [];
    for (const change of normalized) {
      const ref = await inventory.sizeReferences.resolveByNumber(change.size);
      if (!ref?.recordId) return { ok: false, code: 'size_missing' };
      sizeRefs.set(change.size, ref.recordId);
      const matched = rows.filter((row) => {
        const f = row.fields || {};
        return strictLinkedRecordIds(f[liveFields().product]).includes(change.productRecordId)
          && strictLinkedRecordIds(f[liveFields().size]).includes(ref.recordId)
          && textValue(f[liveFields().state]).trim() === change.state
          // ⭐ 2026-11-27（业务负责人确认）：**空 = 非当季** —— 「当季」复选框在真表里没勾过就是
          //   空值（null），不是 false。严格 `=== false` 会把这批行全漏掉 ⇒ 她勾了也报「库存不足」。
          //   ⇒ 按**布尔语义**比：空 / false 都算非当季，true 才算当季。
          && Boolean(f[liveFields().season]) === change.currentSeason;
      });
      if (matched.length < change.quantity) {
        return { ok: false, code: 'stock_shortage', details: { size: change.size, state: change.state, need: change.quantity, have: matched.length } };
      }
      for (const row of matched.slice(0, change.quantity)) {
        items.push({
          live_record_id: row.record_id,
          product_record_id: change.productRecordId,
          size: change.size,
          size_record_id: ref.recordId,
          state: change.state,
          current_season: change.currentSeason,
          target_season: change.targetSeason,
          behavior_code: change.targetSeason ? config.behavior.release : config.behavior.freeze,
          live_applied: false,
          ledger_record_id: '',
          // Feishu create 的 client_token：崩溃后重试同一 token ⇒ 飞书幂等返回同一条流水。
          ledger_client_token: crypto.randomUUID(),
        });
      }
    }
    const created = await taskStore.createIfAbsent({
      operation_id: opId,
      request_id: String(requestId),
      operator_open_id: String(operatorOpenId || ''),
      status: 'planned',
      items,
      created_at: new Date(now()).toISOString(),
      updated_at: new Date(now()).toISOString(),
    });
    return { ok: true, operation: created.record, reused: !created.created };
  };

  const mark = async (opId, patch) => taskStore.update(opId, patch);

  const execute = async (operationId) => {
    let operation = await taskStore.get(operationId);
    if (!operation) return { ok: false, code: 'not_found' };
    if (operation.status === 'completed') return { ok: true, operation, reused: true };
    const fields = liveFields();
    // 1) 实时库存：只更新尚未生效的当季
    const pendingLive = operation.items.filter((item) => !item.live_applied);
    if (pendingLive.length) {
      const updates = pendingLive.map((item) => ({
        recordId: item.live_record_id,
        values: {
          season: item.target_season,
          ...personPatch({ tableKey: 'liveInventory', fieldKey: 'warehouseStaff', operatorOpenId: operation.operator_open_id }),
        },
      }));
      try {
        if (typeof inventory.gateway.updateBatch === 'function') {
          await inventory.gateway.updateBatch('liveInventory', updates, { correlation: { task_id: operation.request_id } });
        } else {
          for (const update of updates) {
            await inventory.gateway.update('liveInventory', update.recordId, update.values, { correlation: { task_id: operation.request_id } });
          }
        }
      } catch (error) {
        // 批量可能部分成功：按实际记录状态收敛，避免整批重写。
        for (const item of pendingLive) {
          const record = await inventory.gateway.get('liveInventory', item.live_record_id).catch(() => null);
          if (record && record.fields?.[fields.season] === item.target_season) item.live_applied = true;
        }
        await mark(operationId, { items: operation.items, status: 'live_partial' });
        throw error;
      }
      operation.items = operation.items.map((item) => (
        pendingLive.some((one) => one.live_record_id === item.live_record_id) ? { ...item, live_applied: true } : item
      ));
      operation = await mark(operationId, { items: operation.items, status: 'live_updated' });
    }
    // 2) 库存流水：只补未写的
    for (const item of operation.items) {
      if (item.ledger_record_id) continue;
      const behavior = await inventory.resolveStockBehavior(item.behavior_code);
      const created = await inventory.gateway.create('inventoryLedger', {
        product: relation(item.product_record_id),
        size: relation(item.size_record_id),
        quantityChange: 0,
        behavior: relation(behavior.recordId),
        ...personPatch({ tableKey: 'inventoryLedger', fieldKey: 'operator', operatorOpenId: operation.operator_open_id }),
      }, {
        correlation: { task_id: operation.request_id },
        clientToken: item.ledger_client_token,
      });
      item.ledger_record_id = String(created?.recordId || '');
      await mark(operationId, { items: operation.items });
    }
    await mark(operationId, { items: operation.items, status: 'completed', completed_at: new Date(now()).toISOString() });
    invalidateLiveInventorySnapshot('season_scan_adjust');
    logInfo('inventory.season.scan.applied', { request_id: operation.request_id, updated: operation.items.length, operator_open_id: operation.operator_open_id || undefined });
    return { ok: true, operation: { ...operation, items: operation.items }, updated: operation.items.length };
  };

  const submit = async (input = {}) => {
    const planned = await plan(input);
    if (!planned.ok) return planned;
    return execute(planned.operation.operation_id);
  };

  return { plan, execute, submit, operationIdOf };
};

module.exports = { createSeasonAdjustmentService };
