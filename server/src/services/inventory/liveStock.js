// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 2198-2257 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 「实时库存」记录的纯读取 / 候选计算（不写、不改状态、不再整表读）。
const {textValue} = require('../v1BitableGateway');
const { strictLinkedRecordIds } = require('../strictLinkIds');
const { LIVE_STATES } = require('./movements');
const { outboundStateRank } = require('../../config/inventoryStatePolicy');

/** 实时库存里这一条记录是不是「这个货品 + 这个尺码」——不看所属状态。 */
function matchesLiveInventory(record, { productRecordId, sizeRecordId, productField, sizeField } = {}) {
  return strictLinkedRecordIds(record?.fields?.[productField]).includes(productRecordId) &&
    strictLinkedRecordIds(record?.fields?.[sizeField]).includes(sizeRecordId);
}

function findLiveInventoryIn(records, productRecordId, sizeRecordId) {
    // ⭐ 2026-11-11：**不看所属状态** —— 只要「货品+尺码」匹配就是库存（空状态也算）。
    const table = this.gateway.table('liveInventory');
    return records.filter((record) => matchesLiveInventory(record, {
      productRecordId,
      sizeRecordId,
      productField: table.fields.product,
      sizeField: table.fields.size,
    }));
  }

/**
 * FIFO：按「实时库存.创建时间」升序（最早入库的先被消耗/删除）。
 * 缺失创建时间的行视为**最早**；同一时间用 record_id 兜底，保证顺序稳定。
 */
function sortLiveInventoryFifo(records = []) {
  const field = this.gateway.table('liveInventory').readOnlyFields?.createdAt?.name || '';
  const timeOf = (record) => {
    const raw = record?.fields?.[field];
    const number = Number(raw);
    if (Number.isFinite(number) && number > 0) return number;
    const parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...records].sort((left, right) => {
    const diff = timeOf(left) - timeOf(right);
    if (diff !== 0) return diff;
    return String(left.record_id).localeCompare(String(right.record_id));
  });
}

async function findLiveInventory(productRecordId, size) {
    const sizeReference = await this.sizeReferences.resolveByNumber(size);
    return this.findLiveInventoryIn(await this.gateway.listAll('liveInventory'), productRecordId,
      sizeReference.recordId);
  }

  /**
   * ⭐ 2026-10-16（性能）：**从"已经读到的"「实时库存」记录算候选**（纯函数版）。
   *
   * 为什么单独剥出来：订单列表**每条待补样品**都要问一次候选，而问一次就要整表读一次
   *   「实时库存」（一双一行，店里最大的一张表）⇒ 几条待办 = 几次**串行**整表读
   *   （线上 `/sales/orders` 27~42 秒的真凶）。调用方已经有那批记录时，直接交给这里，
   *   **一个字节都不再看表**。
   * 🔴 **判据一个字没动**：与下面 `sampleReplacementCandidates` 原来那段循环**逐行同义**
   *   （同样的 `excludeRecordIds` → 同样的货品过滤 → 同样的状态白名单 → 同样的按码计数 →
   *    同样的按 `size` 升序），只是把"读表"从里面挪到了调用方。
   * ⚠️ `await this.sizeReferences.resolveLinkedCell(...)` **一字不改地保留**：
   *   尺码服务自己带缓存，同一批记录里每个尺码只解一次（不影响"读了几次表"）。
   */
async function candidatesFromLiveRecords(productRecordId, liveRecords = [], { excludeRecordIds = [] } = {}) {
    const table = this.gateway.table('liveInventory');
    const bySize = new Map();
    const excluded = new Set(excludeRecordIds);
    for (const record of Array.isArray(liveRecords) ? liveRecords : []) {
      if (excluded.has(record.record_id)) continue;
      if (!strictLinkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId)) continue;
      const size = (await this.sizeReferences.resolveLinkedCell(record.fields?.[table.fields.size])).size;
      const state = textValue(record.fields?.[table.fields.state]);
      if (!LIVE_STATES.includes(state)) continue;
      if (!bySize.has(size)) bySize.set(size, { size, doorBoxCount: 0, sampleCount: 0, warehouseCount: 0 });
      const counts = bySize.get(size);
      if (state === '门盒') counts.doorBoxCount += 1;
      if (state === '样品') counts.sampleCount += 1;
      if (state === '仓库') counts.warehouseCount += 1;
    }
    return [...bySize.values()].sort((left, right) => left.size - right.size);
  }

  /**
   * `options.liveRecords`（可选）：调用方**已经读到的**「实时库存」快照 —— 给了就用它，
   *   **不再整表读一次**；不给（默认）就自己读 ⇒ 行为与优化前**逐字一致**。
   * ⚠️ `resolveLinkedCell` 会抛（关联字段为空 / 认不出尺码）：与优化前**同一处、同一种抛法**
   *   —— 调用方（订单列表）原来怎么兜底，现在还是怎么兜底。
   */
async function sampleReplacementCandidates(productRecordId, { excludeRecordIds = [], liveRecords = null } = {}) {
    const records = Array.isArray(liveRecords)
      ? liveRecords
      : await this.gateway.listAll('liveInventory');
    return this.candidatesFromLiveRecords(productRecordId, records, { excludeRecordIds });
  }


/**
 * ⭐ 2026-11-11（售后写库提速）：**按货品记录 ID 条件读**「实时库存」，不再整表拉 1300+ 行。
 *
 * 「实时库存.recordID」是业务负责人 2026-11-11 新增的查找引用列（= 货品 record_id），
 * 标签打印已经在用同一个 filter 精确读。拿不到该列 / 条件读失败 ⇒ **回退整表读**（慢一次但对）。
 */
async function readLiveInventoryForProduct(productRecordId) {
  const table = this.gateway.table('liveInventory');
  const field = table.fields?.recordId;
  const wanted = String(productRecordId || '').trim();
  if (!field || typeof this.gateway.listByFilter !== 'function' || !/^[A-Za-z0-9]+$/.test(wanted)) {
    return this.gateway.listAll('liveInventory');
  }
  try {
    const rows = await this.gateway.listByFilter('liveInventory', `CurrentValue.[${field}]="${wanted}"`);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    return this.gateway.listAll('liveInventory');
  }
}

/**
 * 出库选行顺序（业务负责人 2026-11-12 定）：
 *   · 门盒 / 空状态同优先级（空状态按门盒算）
 *   · 样品最后
 *   · 同一优先级按创建时间 FIFO
 */
function sortLiveInventoryForConsumption(records = []) {
  const field = this.gateway.table('liveInventory').readOnlyFields?.createdAt?.name || '';
  const timeOf = (record) => {
    const raw = record?.fields?.[field];
    const number = Number(raw);
    if (Number.isFinite(number) && number > 0) return number;
    const parsed = Date.parse(String(raw || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const stateField = this.gateway.table('liveInventory').fields.state;
  return [...records].sort((left, right) => {
    const rankDiff = outboundStateRank(left?.fields?.[stateField]) - outboundStateRank(right?.fields?.[stateField]);
    if (rankDiff !== 0) return rankDiff;
    const diff = timeOf(left) - timeOf(right);
    if (diff !== 0) return diff;
    return String(left.record_id).localeCompare(String(right.record_id));
  });
}

module.exports = {
  matchesLiveInventory,
  findLiveInventoryIn,
  findLiveInventory,
  candidatesFromLiveRecords,
  sampleReplacementCandidates,
  readLiveInventoryForProduct,
  sortLiveInventoryFifo,
  sortLiveInventoryForConsumption,
};
