'use strict';

/**
 * 「库存 → 手工调整 → 单双调整」的保存服务（2026-11-11）。
 *
 * 输入是**编辑后的目标库存**（按 尺码 + 所属状态 聚合的数量），不是逐条记录：
 *   rows = [{ size: 42, state: '门盒', quantity: 3 }, ...]
 *
 * 做法：读一次实时库存 → 按 尺码|状态 算当前数量 → 逐项和目标的差额走
 * `InventoryService.applyChange`（人工调增 / 调减）。
 * 这样每一种差异都有库存流水、幂等键与串行队列，不绕过库存引擎。
 *
 * 只读 → 算差异 → 逐项写；同一 requestId 重试时差额会变成 0（不会再写），
 * 与盘点调整的幂等语义一致。
 */
const { InventoryService, ADJUSTMENT_BEHAVIORS } = require('./inventoryService');
const { logInfo } = require('../utils/logger');
const { PAIR_STATES } = require('../config/inventoryPairAdjustment');

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

const countsFromCandidates = (candidates = []) => {
  const counts = new Map();
  for (const item of candidates) {
    const size = Number(item.size);
    counts.set(size, {
      doorbox: Number(item.doorBoxCount || 0),
      sample: Number(item.sampleCount || 0),
    });
  }
  return counts;
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
    const currentCounts = countsFromCandidates(
      await this.inventory.candidatesFromLiveRecords(product, raw),
    );
    const desiredByKey = new Map();
    for (const row of desired) desiredByKey.set(`${row.size}|${row.state}`, row.quantity);
    const sizes = new Set([...currentCounts.keys()]);
    for (const row of desired) sizes.add(row.size);

    const operations = [];
    for (const size of [...sizes].sort((a, b) => a - b)) {
      const current = currentCounts.get(size) || { doorbox: 0, sample: 0 };
      for (const [state, currentQuantity] of [[PAIR_STATES[0], current.doorbox], [PAIR_STATES[1], current.sample]]) {
        const targetQuantity = desiredByKey.get(`${size}|${state}`) || 0;
        const delta = targetQuantity - currentQuantity;
        if (delta === 0) continue;
        const increase = delta > 0;
        await this.inventory.applyChange({
          kind: increase ? ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE : ADJUSTMENT_BEHAVIORS.MANUAL_DECREASE,
          productRecordId: product,
          size,
          state,
          quantity: Math.abs(delta),
          requestId: source,
          operatorOpenId,
        });
        operations.push({ size, state, delta });
      }
    }
    logInfo('inventory.adjustment.pairs.applied', {
      request_id: source,
      product_record_id: product,
      rows: desired.length,
      operations: operations.length,
      operator_open_id: operatorOpenId || undefined,
    });
    return {
      product_record_id: product,
      rows: desired,
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
