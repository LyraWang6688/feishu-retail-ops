'use strict';

/**
 * 「库存 → 手工调整 → 单双调整」的保存服务（2026-11-11）。
 *
 * 输入是**编辑后的目标库存**（按 尺码 + 所属状态 聚合的数量），不是逐条记录：
 *   rows = [{ size: 42, state: '门盒', quantity: 3 }, ...]
 *
 * 做法：读一次实时库存 → 按 尺码|状态 算当前数量。
 *   · 每个尺码的目标总数与当前总数一致、只是状态分布不同 ⇒ **只改行的所属状态**，
 *     不增删库存（state-agnostic 内核下这是唯一正确的“状态调整”）；
 *   · 数量/尺码也变了 ⇒ 先按**尺码记录总数**做新增/删除，再统一改状态标签；
 *     这样增减仍走 `InventoryService.applyChange`，状态只在第二阶段修改。
 *
 * 只读 → 算差异 → 逐项写；同一 requestId 重试时差额会变成 0（不会再写），
 * 与盘点调整的幂等语义一致。
 */
const { ADJUSTMENT_BEHAVIORS } = require('./inventoryService');
const { logInfo } = require('../utils/logger');
const { PAIR_STATES } = require('../config/inventoryPairAdjustment');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { textValue } = require('./v1BitableGateway');
const { invalidateLiveInventorySnapshot } = require('./liveInventorySnapshot');

const MAX_ROWS = 200;
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const normalizeRows = (rows) => {
  if (!Array.isArray(rows) || !rows.length) throw userError('请至少保留一行库存');
  if (rows.length > MAX_ROWS) throw userError(`一次最多调整 ${MAX_ROWS} 行`);
  const seen = new Set();
  return rows.map((row) => {
    const size = Number(row?.size);
    const quantity = Number(row?.quantity);
    const state = String(row?.state || '').trim();
    if (!Number.isInteger(size) || size <= 0) throw userError('尺码必须是正整数');
    if (!Number.isInteger(quantity) || quantity < 0) throw userError('数量必须是非负整数');
    if (!PAIR_STATES.includes(state)) throw userError(`所属状态只能是：${PAIR_STATES.join(' / ')}`);
    const key = `${size}|${state}`;
    if (seen.has(key)) throw userError(`同一批里有重复的「${size} 码 / ${state}」`);
    seen.add(key);
    return { size, state, quantity };
  }).filter((row) => row.quantity > 0);
};


/**
 * 把实时库存原始行按「尺码」分组（只读；状态为空的行也保留）。
 * 状态调整是「改展示标签」，需要拿到具体行才能原地改，不能只看聚合数量。
 */
const recordsBySize = async (inventory, productRecordId, rawRecords = []) => {
  const table = inventory.gateway.table('liveInventory');
  const bySize = new Map();
  for (const record of Array.isArray(rawRecords) ? rawRecords : []) {
    const fields = record.fields || {};
    if (!strictLinkedRecordIds(fields?.[table.fields.product]).includes(productRecordId)) continue;
    let size = null;
    try {
      size = (await inventory.sizeReferences.resolveLinkedCell(fields?.[table.fields.size])).size;
    } catch (error) {
      continue;
    }
    if (!size) continue;
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size).push(record);
  }
  return bySize;
};


class InventoryPairAdjustmentService {
  constructor(options = {}) {
    if (!options.inventory) throw new Error('InventoryPairAdjustmentService requires inventory');
    this.inventory = options.inventory;
  }

  async adjustPairs({ productRecordId, rows, requestId, operatorOpenId } = {}) {
    const product = String(productRecordId || '').trim();
    if (!product) throw userError('缺少货品 record_id');
    const source = String(requestId || '').trim();
    if (!source) throw userError('缺少请求编号');
    const desired = normalizeRows(rows);
    const raw = await this.inventory.gateway.listAll('liveInventory');
    const desiredTotals = new Map();
    const desiredStatesBySize = new Map();
    for (const row of desired) {
      desiredTotals.set(row.size, (desiredTotals.get(row.size) || 0) + row.quantity);
      if (!desiredStatesBySize.has(row.size)) desiredStatesBySize.set(row.size, []);
      desiredStatesBySize.get(row.size).push(row);
    }
    const recordsBySizeMap = await recordsBySize(this.inventory, product, raw);
    const sizeKeys = new Set([...desiredTotals.keys(), ...recordsBySizeMap.keys()]);
    const quantityOperations = [];

    // 第一阶段：先把每个尺码的**记录总数**调到目标总数（只做新增/删除）。
    // 这里不按状态做增减 —— 状态不参与库存数量，按状态算增减会被 FIFO 删错行。
    for (const size of [...sizeKeys].sort((a, b) => a - b)) {
      const records = recordsBySizeMap.get(size) || [];
      const delta = Number(desiredTotals.get(size) || 0) - records.length;
      if (delta === 0) continue;
      const increase = delta > 0;
      const targetState = (desiredStatesBySize.get(size) || []).find((row) => row.quantity > 0)?.state || PAIR_STATES[0];
      await this.inventory.applyChange({
        kind: increase ? ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE : ADJUSTMENT_BEHAVIORS.MANUAL_DECREASE,
        productRecordId: product,
        size,
        state: targetState,
        quantity: Math.abs(delta),
        requestId: source,
        operatorOpenId,
      });
      quantityOperations.push({ size, state: targetState, delta });
    }

    // 第二阶段：总数已对齐后，只改记录的「所属状态」来满足目标分布。
    // 写操作可能刚结束，重新读一次，避免拿旧行做标签分配。
    const after = quantityOperations.length
      ? await this.inventory.gateway.listAll('liveInventory')
      : raw;
    const afterBySize = quantityOperations.length
      ? await recordsBySize(this.inventory, product, after)
      : recordsBySizeMap;
    const stateResult = await this.applyStateLabels({
      productRecordId: product,
      rows: desired,
      recordsBySizeMap: afterBySize,
      requestId: source,
      operatorOpenId,
    });
    const operations = [...quantityOperations, ...(stateResult.operations || [])];
    logInfo('inventory.adjustment.pairs.applied', {
      request_id: source,
      product_record_id: product,
      rows: desired.length,
      quantity_operations: quantityOperations.length,
      state_operations: stateResult.changed,
      operator_open_id: operatorOpenId || undefined,
    });
    return {
      product_record_id: product,
      rows: desired,
      operations,
      changed: operations.length,
    };
  }

  async applyStateLabels({ productRecordId, rows, recordsBySizeMap, requestId, operatorOpenId } = {}) {
    const liveFields = this.inventory.gateway.table('liveInventory').fields;
    const operations = [];
    for (const [size, records] of [...recordsBySizeMap.entries()].sort((a, b) => a - b)) {
      const targets = { 门盒: 0, 样品: 0 };
      for (const row of rows.filter((item) => Number(item.size) === Number(size))) targets[row.state] = row.quantity;
      const unassigned = new Set(records);
      for (const state of PAIR_STATES) {
        const target = Number(targets[state] || 0);
        if (target <= 0) continue;
        const preferred = records.filter((record) => unassigned.has(record)
          && textValue(record.fields?.[liveFields.state]) === state).slice(0, target);
        for (const record of preferred) unassigned.delete(record);
        let need = target - preferred.length;
        for (const record of records) {
          if (need <= 0) break;
          if (!unassigned.has(record)) continue;
          unassigned.delete(record);
          const current = textValue(record.fields?.[liveFields.state]);
          if (current !== state) {
            await this.inventory.gateway.update('liveInventory', record.record_id, { state });
            operations.push({ size: Number(size), state, record_id: record.record_id, from: current || '' });
          }
          need -= 1;
        }
      }
    }
    if (operations.length) invalidateLiveInventorySnapshot('state_label_adjust');
    logInfo('inventory.adjustment.pairs.state_applied', {
      request_id: requestId,
      product_record_id: productRecordId,
      operations: operations.length,
      operator_open_id: operatorOpenId || undefined,
    });
    return {
      product_record_id: productRecordId,
      rows,
      operations,
      changed: operations.length,
    };
  }

  async setSeason({ category, season } = {}) {
    const name = String(category || '').trim();
    if (!name) throw userError('请先选择品类');
    if (typeof season !== 'boolean') throw userError('当季必须是布尔值');
    const gateway = this.inventory.gateway;
    const table = gateway.table('liveInventory');
    const records = await gateway.listAll('liveInventory');
    let updated = 0;
    for (const record of records) {
      const fields = record.fields || {};
      if (String(fields[table.fields.category] || '').trim() !== name) continue;
      if (fields[table.fields.season] === season) continue;
      await gateway.update('liveInventory', record.record_id, { season });
      updated += 1;
    }
    logInfo('inventory.adjustment.season_flag.applied', { category: name, season, updated });
    return { category: name, season, updated };
  }
}

module.exports = { InventoryPairAdjustmentService, normalizeRows };
