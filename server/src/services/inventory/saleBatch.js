// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 556-913 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 销售出库（扣库存）的批量口：applySaleBatch。
const { linkedRecordIds, textValue } = require('../v1BitableGateway');
const { relation } = require('../v1ReferenceResolver');
const { normalizeSize } = require('../sizeReferenceService');
const { logInfo, logWarn } = require('../../utils/logger');
const { correlationFields } = require('../../utils/correlationFields');
const { invalidateLiveInventorySnapshot } = require('../liveInventorySnapshot');
const { requireMovement, MOVEMENT_SALE_DECREASE } = require('./movements');
const {
  operationId,
  positiveInteger,
  stockKeyLabelFields,
  correlationPatch,
  stockKeyLabelOfOperation,
  movementLedgerLinkPatch,
  movementLedgerLinkValue,
} = require('./keys');

  /**
   * ⭐⭐ task-3（2026-10-18 提速 · 第 4 步）：**销售出库（扣库存）的批量版** —— `applySale` 的批量口。
   *
   * 为什么要有它（真账）：一次交付 N 双时，`SalesDeliveryService` 逐行调 `applySale`
   *   ⇒ 每一行都要敲：`listAll('behavior')` ＋ `listAll('liveInventory')`（整表读，生产几千行）
   *     ＋ `get('liveInventory')` ×2（`auditExistingOperationRecords` 一次 ＋ 删之前确认一次）
   *     ＋ `create('inventoryLedger')` ＋ `delete('liveInventory')`。
   *   本方法折成 **1 次读行为表 ＋ 1 次整表读 ＋ 1 次 `createBatch`（流水）
   *   ＋ 1 次 `getBatch`（删之前确认）＋ 1 次 `deleteBatch`（整批一次删完）**。
   *
   * 🔴 **语义一行不改**（与逐条路径逐字对齐）：
   *   · 起始状态永远是「门盒」（`applySale` 那条纪律：先扣门盒、扣光了才轮到样品）；
   *   · 消耗顺序 = `STOCK_MOVEMENTS[销售减少].consumes`（门盒 → 样品）；**同一状态内按 record_id 升序**
   *     —— 与 `applyChange` 那两行**逐字同形**（`flatMap` 里各自 sort）；
   *   · 流水字段 = 货品 / 尺码 / 变动数量 / 库存行为 ＋ **关联销售 = 销售主表 record_id**
   *     （`ledgerLink`，与逐条路径**同一处覆盖**）；本地幂等仍是「明细 id + `operationId`」；
   *   · 「样品消耗」从**真正扣掉的那几条**记录算（同 `applyChange` 的 `sample_consumed_quantity`）；
   *   · 补样品候选（`remainingSizes`）用**这一批已经读到的那一份**实时库存算
   *     （`sampleReplacementCandidates(..., { liveRecords })`，零额外整表读）；
   *   · 串行队列按 `stock_key` 先占住（`runForStocks`，跨任务同款同码不会被绕过）；
   *   · 本地任务落盘顺序照 `applyChange`：`prepared`（写远端之前）→ `ledger_created` → `completed`
   *     ⇒ 崩溃 / 批量写失败之后按同一把键续跑，**重放零写、不重复扣**。
   *
   * ⚠️ **一行同款同码时「谁扣哪一双」与逐条路径一致**：逐条路径是"扣完再读"（下一行天然看不到
   *   上一行扣掉的那双）；批量路径用内存 `claimed` 集合把前面行已经挑中的实时库存 id 排除掉
   *   ⇒ 选中集合、`current_quantity` / `target_quantity`、以及"库存不足"那句报文**逐字相同**。
   *
   * ⚠️ **返回值与逐条路径不同（故意的）**：返回与入参**同序**的
   *   `[{ ok: true, result } | { ok: false, error }]`。
   *   为什么：一次交付 N 行时，"某一行库存不足"在逐条路径里只让**那一行**失败（其余照扣），
   *   批量口必须保留这个**部分失败**语义 ⇒ 计划阶段的逐行失败落成逐行的 `{ ok: false }`，
   *   **绝不因为一行不够就整批抛掉**（失败如实、不静默）。
   *   ⚠️ **批量写本身失败**（`createBatch` / `deleteBatch` 抛）⇒ 照原样抛：
   *      调用方（`SalesDeliveryService`）退回逐条，那几次按 journal 续跑 —— 不重不漏。
   *
   * ⚠️ 两条回落（都不改行为，只是少几次 HTTP）：
   *   · 网关**没有**批量口（老替身 / 未接线）⇒ **整体退回逐条**（`applySale` 循环），
   *     与改动前**逐字节同形**；
   *   · 有 `createBatch` / `getBatch` 但**没有** `deleteBatch`（老夹具）⇒ 流水与"删之前确认"
   *     照旧走批量，**只有删这一步退回逐双**，且那一段与 `executeOperation` **逐字同形**。
   *
   * ⚠️ 与 `applyPurchaseBatch` / `applyPurchaseReturnBatch` **同一条纪律**：调用方负责把
   *   「同一 销售明细」聚合过（一次交付里每条明细只出现一次 —— `SalesDeliveryService`
   *   在入口就校验了 `detailRecordIds` 不许重复）⇒ 同一批里不会有两条相同的 `operationId`。
   *
   * @param {Array<object>} items 每项与 `applySale` 的入参同形
   *   （`salesDetailRecordId` / `salesEntryRecordId` / `productRecordId` / `size` / `quantity` / `occurredAt`）
   * @returns {Promise<Array<{ok: boolean, result?: object, error?: Error}>>} 顺序 = 入参顺序
   */
async function applySaleBatch(items = [], options = {}) {
    const list = (Array.isArray(items) ? items : []).filter(Boolean);
    if (!list.length) return [];
    const outcomes = new Array(list.length);
    // 网关没有批量口（老替身 / 未接线）⇒ **整体退回逐条**，与改动前逐字节同形。
    if (typeof this.gateway.createBatch !== 'function' || typeof this.gateway.getBatch !== 'function') {
      for (const [index, item] of list.entries()) {
        try {
          outcomes[index] = { ok: true, result: await this.applySale(item, options) };
        } catch (error) {
          outcomes[index] = { ok: false, error };
        }
      }
      return outcomes;
    }
    const correlation = correlationFields(options.correlation);
    const movement = requireMovement(MOVEMENT_SALE_DECREASE);
    // 入参先逐行规整：与 `applySale` → `applyChange` 同一个校验顺序、同一句报文，
    // ⚠️ 但**逐行**捕获 —— 一行不合法只让这一行失败（逐条路径的失败粒度就是这一行的 try/catch）。
    const prepared = [];
    for (const [index, input] of list.entries()) {
      try {
        if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
        const sourceRecordId = String(input.salesDetailRecordId || '').trim();
        if (!sourceRecordId) throw new Error('库存变化缺少来源明细 record_id');
        const size = normalizeSize(input.size);
        const quantity = positiveInteger(input.quantity, '销售数量');
        // 与 `applySale` 逐字同一条纪律：销售**永远先门盒**，调用方不能自己选起点状态。
        const state = '门盒';
        prepared.push({
          index,
          input,
          sourceRecordId,
          size,
          quantity,
          state,
          operationId: operationId(MOVEMENT_SALE_DECREASE, sourceRecordId),
          stockKey: `${input.productRecordId}|${size}|${state}`,
        });
      } catch (error) {
        outcomes[index] = { ok: false, error };
      }
    }
    if (!prepared.length) return outcomes;
    const stockKeys = [...new Set(prepared.map((item) => item.stockKey))].sort();
    const plans = [];
    await this.runForStocks(stockKeys, async () => {
      await this.ensureSchema();
      for (const key of stockKeys) await this.resumePending(key);
      const behavior = await this.resolveStockBehavior(MOVEMENT_SALE_DECREASE);
      const liveFields = this.gateway.table('liveInventory').fields;
      const stateField = liveFields.state;
      // ⭐ 整批**一次**整表读（改动前：每一行一次）。同一批里前后几行同款同码时，
      //    用 `claimed` 把前面行已经挑中的那一双排除掉 ⇒ 与"扣完再读"的逐条路径同一个可见面。
      const allLive = await this.gateway.listAll('liveInventory');
      const claimed = new Set();
      // 与 `applyChange` 的 `findLedger` **同一个判据**（"已有流水但缺少可恢复任务 ⇒ 停下要人工核对"），
      // 只是把它从"每行整表读一次"换成"整批读一次 + 内存索引" —— 判据与报文一条都不放宽。
      let ledgerIndex = null;
      const existingLedgerOf = async (sourceRecordId) => {
        if (!movement.ledgerSource) return null;
        const ledgerFields = this.gateway.table('inventoryLedger').fields;
        if (!ledgerIndex) {
          ledgerIndex = new Map();
          for (const record of await this.gateway.listAll('inventoryLedger')) {
            for (const linkedId of linkedRecordIds(record.fields?.[ledgerFields[movement.ledgerSource]])) {
              if (!ledgerIndex.has(linkedId)) ledgerIndex.set(linkedId, []);
              ledgerIndex.get(linkedId).push(record);
            }
          }
        }
        const matches = (ledgerIndex.get(sourceRecordId) || []).filter((record) =>
          !behavior.recordId || linkedRecordIds(record.fields?.[ledgerFields.behavior]).includes(behavior.recordId));
        if (matches.length > 1) throw new Error(`来源明细 ${sourceRecordId} 存在重复库存流水`);
        return matches[0] || null;
      };
      for (const item of prepared) {
        try {
          const sizeReference = await this.sizeReferences.resolveByNumber(item.size);
          const journal = await this.store.get(item.operationId);
          if (journal) {
            // 与 `applyChange` **同一个闸门、同一句文案**（少了它，重放就会拿新内容盖掉旧事实）。
            if ([2, 3].includes(journal.schema_version) && (
              journal.kind !== MOVEMENT_SALE_DECREASE ||
              journal.product_record_id !== item.input.productRecordId ||
              journal.size !== item.size || journal.state !== item.state ||
              journal.quantity !== item.quantity
            )) throw new Error(`来源明细 ${item.sourceRecordId} 的库存操作内容与首次提交不一致`);
            if (journal.status === 'completed') {
              outcomes[item.index] = { ok: true, result: journal.result };
              continue;
            }
            // 未完成（`resumePending` 刚跑过）⇒ 正常到不了这里；真到了就沿用逐条通路续跑（绝不半写）。
            outcomes[item.index] = { ok: true, result: await this.executeOperation(journal) };
            continue;
          }
          // 与 `applyChange` **同一处**的第三层幂等守护：本地没有任务、远端却已有这条流水
          // ⇒ 停下来让人核对（**绝不**再补一条把差异藏起来）。
          if (await existingLedgerOf(item.sourceRecordId)) {
            throw new Error(`来源明细 ${item.sourceRecordId} 已有库存流水，但缺少可恢复任务，请人工核对实时库存`);
          }
          // 消耗哪些状态由注册表声明（销售 = 门盒 → 样品），同一状态内按 record_id 升序
          // —— 与 `applyChange` 那两行逐字同形。
          const states = movement.consumes || [item.state];
          const liveRecords = states.flatMap((candidateState) =>
            this.findLiveInventoryIn(allLive, item.input.productRecordId, sizeReference.recordId, candidateState)
              .filter((record) => !claimed.has(record.record_id))
              .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id))));
          const currentQuantity = liveRecords.length;
          if (currentQuantity < item.quantity) {
            // 与 `applyChange` **逐字同一句**（文案里的状态来自注册表，不写死）。
            throw new Error(`${states.join('和')}库存不足：${item.input.productRecordId} ${item.size}码，需 ${item.quantity} 双，现有 ${currentQuantity} 双`);
          }
          const selected = liveRecords.slice(0, item.quantity);
          for (const record of selected) claimed.add(record.record_id);
          // 本地任务形状**逐字照抄** `applyChange` 的 `store.create({...})`（幂等与续跑的唯一依据）。
          plans.push({
            index: item.index,
            item,
            sizeReference,
            removedIds: [],
            operation: {
              operation_id: item.operationId,
              type: 'inventory_change',
              schema_version: 3,
              status: 'prepared',
              kind: MOVEMENT_SALE_DECREASE,
              stock_key: item.stockKey,
              // 人类可读那串：抄**这次已经读到的**实时库存记录上的「库存键」（零额外请求）。
              ...stockKeyLabelFields({
                record: selected[0] || liveRecords[0],
                fieldName: liveFields.stockKey,
                fallback: options.stockKeyLabel,
              }),
              ...correlationPatch(correlation),
              product_record_id: item.input.productRecordId,
              size: item.size,
              size_record_id: sizeReference.recordId,
              state: item.state,
              quantity: item.quantity,
              direction: behavior.direction,
              behavior_record_id: behavior.recordId,
              source_record_id: item.sourceRecordId,
              // 「关联销售」要写的**远端关联值**（销售主表 id）也要落进本地任务：
              // 流水只创建一次，崩溃后 `resumePending` 补写的那一次必须有得写。
              ...movementLedgerLinkPatch(movement, item.input),
              occurred_at: Number(item.input.occurredAt || Date.now()),
              operator_open_id: item.input.operatorOpenId || '',
              live_record_ids: selected.map((record) => record.record_id),
              sample_consumed_quantity: selected.filter((record) =>
                textValue(record.fields?.[stateField]) === '样品').length,
              removed_live_record_ids: [],
              created_live_record_ids: [],
              current_quantity: currentQuantity,
              target_quantity: currentQuantity - item.quantity,
            },
          });
        } catch (error) {
          // 计划阶段逐行失败（库存不足 / 内容与首次提交不一致 / 尺码解不出来…）⇒ 只让这一行失败。
          outcomes[item.index] = { ok: false, error };
        }
      }
      if (!plans.length) return;
      // ① 本地任务**先落盘**（写远端之前）：与 `applyChange` 同一处、同一份形状。
      for (const plan of plans) await this.store.create(plan.operation);
      // ② 流水：**一批一次**（列与值照抄 `executeOperation`）。
      const ledgerRows = plans.map((plan) => {
        const ledgerLinkValue = movementLedgerLinkValue(movement, plan.operation);
        return {
          product: relation(plan.operation.product_record_id),
          size: relation(plan.sizeReference.recordId),
          quantityChange: plan.operation.quantity,
          behavior: relation(plan.operation.behavior_record_id),
          // 来源字段由注册表声明：销售的 `ledgerSource` = 明细（本地幂等键那一侧），
          // 紧接着 `ledgerLink` 用**销售主表 id** 覆盖同一列 —— 与 `executeOperation` 同形同序。
          ...(movement.ledgerSource
            ? { [movement.ledgerSource]: relation(plan.operation.source_record_id) }
            : {}),
          ...(ledgerLinkValue ? { [movement.ledgerLink.field]: relation(ledgerLinkValue) } : {}),
        };
      });
      const created = await this.gateway.createBatch('inventoryLedger', ledgerRows, { correlation });
      for (const [offset, plan] of plans.entries()) {
        plan.operation.ledger_record_id = created[offset]?.recordId || '';
        await this.store.update(plan.operation.operation_id, {
          status: 'ledger_created',
          ledger_record_id: plan.operation.ledger_record_id,
        });
      }
      // ③ 删之前**先确认那一条**（与逐条路径同一句守护、同一句文案）—— 逐双 `get` 换成一次 `getBatch`。
      const wantedIds = plans.flatMap((plan) => plan.operation.live_record_ids);
      const fetched = wantedIds.length ? await this.gateway.getBatch('liveInventory', wantedIds) : [];
      const fetchedById = new Map(fetched.map((record) => [record.record_id, record]));
      const confirmRecord = (plan, recordId) => {
        // A list response may lag behind the selected record. Confirm the exact record before
        // deleting; never report a deduction based only on its absence from a possibly stale list.
        const record = fetchedById.get(recordId);
        if (!record) throw new Error(`待扣减实时库存 ${recordId} 不存在，请人工核对`);
        const consumableStates = movement.consumes || [plan.operation.state];
        if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(plan.operation.product_record_id) ||
          !linkedRecordIds(record.fields?.[liveFields.size]).includes(plan.sizeReference.recordId) ||
          !consumableStates.includes(textValue(record.fields?.[stateField]))) {
          throw new Error(`待扣减实时库存 ${recordId} 的货品、尺码或状态已改变，请人工核对`);
        }
      };
      const recordRemoved = async () => {
        for (const plan of plans) {
          if (plan.removedIds.length) {
            await this.store.update(plan.operation.operation_id, { removed_live_record_ids: plan.removedIds });
          }
        }
      };
      if (typeof this.gateway.deleteBatch === 'function') {
        const confirmed = [];
        for (const plan of plans) {
          for (const recordId of plan.operation.live_record_ids) {
            confirmRecord(plan, recordId);
            confirmed.push({ plan, recordId });
          }
        }
        if (confirmed.length) {
          try {
            await this.gateway.deleteBatch('liveInventory',
              confirmed.map((entry) => entry.recordId), { correlation });
          } catch (error) {
            // ⚠️ 网关如实回报了"哪几条其实已经删掉了"（`bitableDeletedRecordIds`）⇒ 先记进 journal，
            //    再照原样抛。**不从任何一次读里推断**（读可能滞后）—— 这份账是官方对这次请求的应答。
            const removedByApi = Array.isArray(error?.bitableDeletedRecordIds)
              ? error.bitableDeletedRecordIds : [];
            if (removedByApi.length) {
              for (const entry of confirmed) {
                if (removedByApi.includes(entry.recordId) && !entry.plan.removedIds.includes(entry.recordId)) {
                  entry.plan.removedIds.push(entry.recordId);
                }
              }
              await recordRemoved();
            }
            throw error;
          }
          for (const entry of confirmed) entry.plan.removedIds.push(entry.recordId);
          await recordRemoved();
        }
      } else {
        // ⚠️ 老替身 / 夹具没有 `deleteBatch` ⇒ **只有删这一步**退回逐双：
        //    下面这段与 `executeOperation` **逐字同形**（"确认一条 → 删一条 → 记一条"交错）。
        for (const plan of plans) {
          for (const recordId of plan.operation.live_record_ids) {
            if (plan.removedIds.includes(recordId)) continue;
            confirmRecord(plan, recordId);
            await this.gateway.delete('liveInventory', recordId);
            plan.removedIds.push(recordId);
            await this.store.update(plan.operation.operation_id, { removed_live_record_ids: plan.removedIds });
          }
        }
      }
      // ④ 终态 + 逐条日志（与 `executeOperation` 同形、同序）。
      const removedSoFar = [];
      for (const plan of plans) {
        removedSoFar.push(...plan.removedIds);
        const result = {
          stockKey: plan.operation.stock_key,
          ledgerRecordId: plan.operation.ledger_record_id,
          liveRecordIds: plan.removedIds,
          movementQuantity: plan.operation.quantity,
          direction: plan.operation.direction,
          quantity: plan.operation.target_quantity,
          sampleConsumedQuantity: plan.operation.sample_consumed_quantity || 0,
          productRecordId: plan.operation.product_record_id,
          consumedLiveRecordIds: plan.removedIds,
        };
        if (movement.triggerSampleReplacement && result.sampleConsumedQuantity) {
          try {
            // ⚠️ 逐条路径这一步是"再读一次实时库存"；批量路径用这一批已经读到的那一份
            //    ＋ 排除"到这一行为止已扣掉的那些" ⇒ 与逐条路径**同一个可见面**，零额外请求。
            result.remainingSizes = await this.sampleReplacementCandidates(result.productRecordId,
              { excludeRecordIds: [...removedSoFar], liveRecords: allLive });
          } catch (error) {
            // 库存写入已经落了；候选算不出来**绝不能**把一次成功交付变成失败（同逐条路径）。
            result.remainingSizes = [];
            result.replacementCandidatesUnavailable = true;
            logWarn('inventory.sample_candidates.failed', {
              operation_id: plan.operation.operation_id,
              source_record_id: plan.operation.source_record_id,
              error: error.message,
              ...correlation,
            });
          }
        }
        await this.store.update(plan.operation.operation_id, { status: 'completed', result });
        logInfo('inventory.change.applied', {
          operation_id: plan.operation.operation_id,
          kind: plan.operation.kind,
          stock_key: plan.operation.stock_key,
          ...stockKeyLabelOfOperation(plan.operation),
          movement_quantity: plan.operation.quantity,
          direction: plan.operation.direction,
          target_quantity: plan.operation.target_quantity,
          ledger_record_id: plan.operation.ledger_record_id,
          live_record_ids: plan.removedIds,
          operator_open_id: plan.operation.operator_open_id || undefined,
          ...correlation,
        });
        outcomes[plan.index] = { ok: true, result };
      }
      // 库存**已经写进飞书** ⇒ 当场作废扫码页那份内存快照（与三条既有通路同一条纪律）。
      invalidateLiveInventorySnapshot('inventory_changed');
    });
    return outcomes;
  }

module.exports = {
  applySaleBatch,
};
