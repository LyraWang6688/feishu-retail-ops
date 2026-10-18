// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 2198-2257 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 「实时库存」记录的纯读取 / 候选计算（不写、不改状态、不再整表读）。
const { linkedRecordIds, textValue } = require('../v1BitableGateway');

function findLiveInventoryIn(records, productRecordId, sizeRecordId, state = '门盒') {
    const table = this.gateway.table('liveInventory');
    return records.filter(
      (record) =>
        linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId) &&
        linkedRecordIds(record.fields?.[table.fields.size]).includes(sizeRecordId) &&
        textValue(record.fields?.[table.fields.state]) === state
    );
  }

async function findLiveInventory(productRecordId, size, state = '门盒') {
    const sizeReference = await this.sizeReferences.resolveByNumber(size);
    return this.findLiveInventoryIn(await this.gateway.listAll('liveInventory'), productRecordId,
      sizeReference.recordId, state);
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
      if (!linkedRecordIds(record.fields?.[table.fields.product]).includes(productRecordId)) continue;
      const size = (await this.sizeReferences.resolveLinkedCell(record.fields?.[table.fields.size])).size;
      const state = textValue(record.fields?.[table.fields.state]);
      if (!['门盒', '样品', '仓库'].includes(state)) continue;
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

module.exports = {
  findLiveInventoryIn,
  findLiveInventory,
  candidatesFromLiveRecords,
  sampleReplacementCandidates,
};
