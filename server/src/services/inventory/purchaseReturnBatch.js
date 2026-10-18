// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 1186-1493 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 采购退货扣库存的批量口：applyPurchaseReturnBatch。
const { linkedRecordIds, textValue } = require('../v1BitableGateway');
const { relation } = require('../v1ReferenceResolver');
const { normalizeSize } = require('../sizeReferenceService');
const { logInfo } = require('../../utils/logger');
const { correlationFields } = require('../../utils/correlationFields');
const { invalidateLiveInventorySnapshot } = require('../liveInventorySnapshot');
const { requireMovement, MOVEMENT_PURCHASE_DECREASE, LIVE_STATES } = require('./movements');
const {
  operationId,
  positiveInteger,
  stockKeyLabelFields,
  correlationPatch,
  stockKeyLabelOfOperation,
  movementLedgerLinkPatch,
  movementLedgerLinkValue,
  purchaseReturnSourceId,
} = require('./keys');

  /**
   * ⭐⭐ task-65（业务负责人 2026-10-16 逐字「**退货也需要批量提速**」）：
   * **一批一次扣**的采购退货 —— `applyPurchaseReturn` 的批量版
   * （形态**逐行对齐** `applyPurchaseBatch`：同一把串行队列、同一条幂等纪律、同一套日志）。
   *
   * 为什么要有它（真账）：逐条路径**每个尺码**要敲
   *   ① `listAll('behavior')`（`resolveStockBehavior`）
   *   ② `listAll('liveInventory')`（整表读 ⇒ 生产几千行 ⇒ 翻页 ⇒ 多个 HTTP）
   *   ③ `create('inventoryLedger')`
   *   ＋ **每一双** `get('liveInventory')` ×2（`auditExistingOperationRecords` 一次 ＋ 删之前确认一次）
   *      ＋ **每一双** `delete('liveInventory')`
   * ⇒ 一批 3 档 6 双 ≈ **20+ 次**；本方法折成
   *   **1 次整表读 ＋ 1 次读行为表 ＋ 1 次 `createBatch`（流水）＋ 1 次 `getBatch`（删之前确认）
   *   ＋ 1 次 `deleteBatch`（整批一次删完 · ≤500/片由网关分片）**。
   *
   * 🔴 **语义一行不改**（与逐条路径逐字对齐）：
   *   · 幂等键 = `purchaseReturnSourceId(input)`（本地 task journal）⇒ **重跑零写**、
   *     崩溃后按同一把键续跑（`resumePending` → `executeOperation`，这条路一个字没动）；
   *   · "内容与首次提交不一致"闸门、「重复业务事实」语义、超库存报文、行为解析 /
   *     库存方向 / 「库存键」标签 全部**复用逐条路径那几个 helper**；
   *   · 任务落盘顺序照 `applyChange`：**`prepared`（写远端之前）→ `ledger_created` → `completed`**
   *     —— 退货没有"远端幂等键"可回查，崩溃后只能靠这份本地日志恢复；
   *   · 失败粒度 = **整批一次写**（与 2026-10-13 验收那条 `applyPurchaseBatch` 同一档）：
   *     流水那一次批量写失败 ⇒ 这一批**一条都不写**，重试按同一把键补齐；
   *     删那一次 `deleteBatch` 失败 ⇒ **不把半截当成功**（照原样抛）；
   *     ⚠️ 但网关会把**官方如实回报的那一份**（`error.bitableDeletedRecordIds`：哪几条真的删掉了）
   *     挂上来 ⇒ 先把它们记进 journal **再抛** —— 那份账是"官方对这次请求的应答"，
   *     **不是**从一次（可能滞后的）读里推断的（逐条路径那句"绝不凭可能滞后的列表断定已扣减"
   *     在这里同样成立）⇒ 续跑（逐双）跳过已删的那几条，**不重不漏**。
   *     拿不到那份应答（网络异常之类）⇒ 什么都不记 ⇒ 续跑会停下要人工核对（**宁可停下，也不猜**）。
   *   · ⚠️ **计划阶段**（读表之后、写任何东西之前）就抛的场景（例如库存不足）⇒ 整批**一条都不写**；
   *     逐条路径是"前面几条已扣、到那条才抛"—— 这一档差异与验收那条 **AC-B4** 同类，测试里显式钉住。
   *
   * ⭐ **`delete` 那一半也批量化了**（task-65 · Lead 当场授权）：网关
   *   （`v1BitableGateway`）原来有 `createBatch` / `updateBatch` / `getBatch`、**没有 `deleteBatch`**
   *   ⇒ 本卡给它**加**了 `deleteBatch`（单独一个提交，好回退；形态逐行对齐 `createBatch`、
   *   官方 `appTableRecord.batchDelete`、≤500/片）⇒ 这里由"每一双一次 `delete`"改成**整批一次**。
   *   🔴 **只加能力**：网关单条 `delete` 一行没动，它的既有调用方（`executeOperation` 等）逐字不变。
   *
   * ⚠️ **两条回落**（都**不改行为**，只是少几次 HTTP）：
   *   · 网关**没有**批量口（老替身 / 未接线）⇒ **整体退回逐条**（`applyPurchaseReturn` 循环），
   *     与改动前**逐字节同形** —— 与 `purchaseWebhookService` 对 `applyPurchaseBatch` 的回落同一手法；
   *   · 有 `createBatch` / `getBatch` 但**没有 `deleteBatch`**（老夹具）⇒ 流水与"删之前确认"
   *     照旧走批量，**只有删这一步退回逐双**，且那一段与改动前**逐字相同**
   *     （同序、同一条 `store.update`、同一条"删之前先确认"的守护）。
   *
   * ⚠️ **已知边界（如实标，不美化）**：`deleteBatch` 超过 500 条时由网关**内部**分片 ⇒
   *   "1 次 `deleteBatch`"这句在 **N ≤ 500** 时成立。分片里**后一片**失败、而前一片已经删掉时，
   *   那一份"已删"清单挂在**后一片的错误**上 ⇒ journal 只记得到后一片回报的那些，
   *   前一片（已经删掉、没记账）在续跑时会报"不存在，请人工核对"——**宁可停下让人核对，
   *   也不重复扣 / 假报成功**。⚠️ 退货一批到不了 500 双 ⇒ 现实里走不到；这里显式写出来。
   *
   * ⚠️ 与 `applyPurchaseBatch` **同一条纪律**：调用方负责把「同一 货品 × 尺码」聚合过
   *   （本方法不做这个聚合 —— 同一批里出现重复的身份会让同一个 `operation_id` 被写两遍）。
   *   退货这条链的来源是 `plan.items`（每个尺码一条）⇒ 天然不重复。
   *
   * @param {Array<object>} items 每项与 `applyPurchaseReturn` 的入参同形
   * @returns {Promise<Array<object>>} 与 `applyChange` 同形的结果数组（顺序 = 入参顺序）
   */
async function applyPurchaseReturnBatch(items = [], options = {}) {
    const list = (Array.isArray(items) ? items : []).filter(Boolean);
    if (!list.length) return [];
    // 网关没有批量口 ⇒ 逐条回落（既有替身用例看到的路与改动前逐字相同）。
    if (typeof this.gateway.createBatch !== 'function' || typeof this.gateway.getBatch !== 'function') {
      const results = [];
      for (const item of list) results.push(await this.applyPurchaseReturn(item, options));
      return results;
    }
    const correlation = correlationFields(options.correlation);
    const movement = requireMovement(MOVEMENT_PURCHASE_DECREASE);
    const prepared = [];
    for (const input of list) {
      if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
      const sourceRecordId = purchaseReturnSourceId(input);
      // 与 `applyPurchaseReturn` 同一条纪律：**先按来源回查本地任务**，重放时用它自己记下的 state
      // （否则重放会拿"重新算出来的 state"去比对，被"内容与首次提交不一致"当场拦下）。
      const existing = await this.findOperationBySource(sourceRecordId);
      const state = String(existing?.state || input.state || '门盒');
      if (!LIVE_STATES.includes(state)) throw new Error('库存所属状态无效');
      const size = normalizeSize(input.size);
      prepared.push({
        input,
        sourceRecordId,
        size,
        state,
        quantity: positiveInteger(input.quantity, '采购退货数量'),
        operationId: operationId(MOVEMENT_PURCHASE_DECREASE, sourceRecordId),
        stockKey: `${input.productRecordId}|${size}|${state}`,
      });
    }
    const stockKeys = [...new Set(prepared.map((item) => item.stockKey))].sort();
    return this.runForStocks(stockKeys, async () => {
      await this.ensureSchema();
      for (const key of stockKeys) await this.resumePending(key);
      const behavior = await this.resolveStockBehavior(MOVEMENT_PURCHASE_DECREASE);
      const liveFields = this.gateway.table('liveInventory').fields;
      const stateField = liveFields.state;
      // ⭐ 整批**一次**整表读（原来每个尺码一次：生产几千行 ⇒ 翻页 ⇒ 多个 HTTP）。
      const allLive = await this.gateway.listAll('liveInventory');
      const results = new Array(prepared.length);
      const plans = [];
      for (const [index, item] of prepared.entries()) {
        const sizeReference = await this.sizeReferences.resolveByNumber(item.size);
        const journal = await this.store.get(item.operationId);
        if (journal) {
          // 与 `applyChange` **同一个闸门、同一句文案**（少了它，重放就会拿新内容盖掉旧事实）。
          if ([2, 3].includes(journal.schema_version) && (
            journal.kind !== MOVEMENT_PURCHASE_DECREASE ||
            journal.product_record_id !== item.input.productRecordId ||
            journal.size !== item.size || journal.state !== item.state ||
            journal.quantity !== item.quantity
          )) throw new Error(`来源明细 ${item.sourceRecordId} 的库存操作内容与首次提交不一致`);
          if (journal.status === 'completed') { results[index] = journal.result; continue; }
          // 未完成：`resumePending` 刚跑过 ⇒ 正常到不了这里；真到了就沿用逐条通路（绝不半写）。
          results[index] = await this.executeOperation(journal);
          continue;
        }
        const states = movement.consumes || [item.state];
        const liveRecords = states.flatMap((candidateState) =>
          this.findLiveInventoryIn(
            allLive, item.input.productRecordId, sizeReference.recordId, candidateState,
          ))
          .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id)));
        const currentQuantity = liveRecords.length;
        if (currentQuantity < item.quantity) {
          // 与 `applyChange` **逐字同一句**（"退能退的"由调用方先算好；这里只兜底、绝不夹取）。
          throw new Error(`${states.join('和')}库存不足：${item.input.productRecordId} ${item.size}码，需 ${item.quantity} 双，现有 ${currentQuantity} 双`);
        }
        const selected = liveRecords.slice(0, item.quantity);
        // 本地任务形状**逐字照抄** `applyChange` 的 `store.create({...})`。
        plans.push({
          index,
          item,
          sizeReference,
          removedIds: [],
          operation: {
            operation_id: item.operationId,
            type: 'inventory_change',
            schema_version: 3,
            status: 'prepared',
            kind: MOVEMENT_PURCHASE_DECREASE,
            stock_key: item.stockKey,
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
      }
      // ① 本地任务**先落盘**（写远端之前）：退货没有"远端幂等键"可回查 ⇒ 崩溃后只能靠它恢复。
      for (const plan of plans) await this.store.create(plan.operation);
      // ② 流水：**一批一次**（列与值照抄 `executeOperation`）。
      if (plans.length) {
        const rows = plans.map((plan) => {
          const ledgerLinkValue = movementLedgerLinkValue(movement, plan.operation);
          return {
            product: relation(plan.item.input.productRecordId),
            size: relation(plan.sizeReference.recordId),
            quantityChange: plan.item.quantity,
            behavior: relation(plan.operation.behavior_record_id),
            ...(movement.ledgerSource
              ? { [movement.ledgerSource]: relation(plan.item.sourceRecordId) }
              : {}),
            ...(ledgerLinkValue ? { [movement.ledgerLink.field]: relation(ledgerLinkValue) } : {}),
          };
        });
        const created = await this.gateway.createBatch('inventoryLedger', rows, { correlation });
        for (const [offset, plan] of plans.entries()) {
          plan.operation.ledger_record_id = created[offset]?.recordId || '';
          await this.store.update(plan.item.operationId, {
            status: 'ledger_created',
            ledger_record_id: plan.operation.ledger_record_id,
          });
        }
        // ③ 删之前**先确认那一条**（与逐条路径同一句守护）——逐双 `get` 换成**一次 `getBatch`**。
        const wantedIds = plans.flatMap((plan) => plan.operation.live_record_ids);
        const fetched = wantedIds.length ? await this.gateway.getBatch('liveInventory', wantedIds) : [];
        const fetchedById = new Map(fetched.map((record) => [record.record_id, record]));
        if (typeof this.gateway.deleteBatch === 'function') {
          // ⭐ 有批量删口：先把整批要删的**确认出来**（同一句守护、同一句文案、同一个顺序），
          //    再**一次**删（≤500/片由网关分片）。
          const confirmed = [];
          for (const plan of plans) {
            const consumableStates = movement.consumes || [plan.operation.state];
            for (const recordId of plan.operation.live_record_ids) {
              if (plan.removedIds.includes(recordId)) continue;
              const record = fetchedById.get(recordId);
              if (!record) throw new Error(`待扣减实时库存 ${recordId} 不存在，请人工核对`);
              if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(plan.item.input.productRecordId) ||
                !linkedRecordIds(record.fields?.[liveFields.size]).includes(plan.sizeReference.recordId) ||
                !consumableStates.includes(textValue(record.fields?.[stateField]))) {
                throw new Error(`待扣减实时库存 ${recordId} 的货品、尺码或状态已改变，请人工核对`);
              }
              confirmed.push({ plan, recordId });
            }
          }
          if (confirmed.length) {
            // 成功后**按 plan 各落一次** journal（形状与逐双路径逐字相同：
            // `removed_live_record_ids` = 这一档已删的 id 数组）。
            try {
              await this.gateway.deleteBatch('liveInventory',
                confirmed.map((entry) => entry.recordId), { correlation });
            } catch (error) {
              // ⚠️ 网关如实回报了"哪几条其实已经删掉了"（`bitableDeletedRecordIds`）⇒
              //    先把它们记进 journal，再照原样抛。**不从任何一次读里推断**（读可能滞后；
              //    逐条路径那句"绝不凭可能滞后的列表断定已扣减"在这里同样成立）——
              //    这份账是**官方对这次请求的应答**。
              //    没有这一步，续跑（逐双）会把"已删"当成"不存在"当场抛、要人工核对。
              const removedByApi = Array.isArray(error?.bitableDeletedRecordIds)
                ? error.bitableDeletedRecordIds : [];
              if (removedByApi.length) {
                for (const entry of confirmed) {
                  if (removedByApi.includes(entry.recordId) && !entry.plan.removedIds.includes(entry.recordId)) {
                    entry.plan.removedIds.push(entry.recordId);
                  }
                }
                for (const plan of plans) {
                  if (plan.removedIds.length) {
                    await this.store.update(plan.item.operationId,
                      { removed_live_record_ids: plan.removedIds });
                  }
                }
              }
              throw error;
            }
            for (const entry of confirmed) entry.plan.removedIds.push(entry.recordId);
            for (const plan of plans) {
              if (plan.removedIds.length) {
                await this.store.update(plan.item.operationId, { removed_live_record_ids: plan.removedIds });
              }
            }
          }
        } else {
          // ⚠️ 老替身 / 夹具没有 `deleteBatch` ⇒ **只有删这一步**退回逐双：下面这段与改动前
          //    **逐字相同**（"确认一条 → 删一条 → 记一条"**交错**，连出错时已删到哪一条都一样）。
          for (const plan of plans) {
            const consumableStates = movement.consumes || [plan.operation.state];
            for (const recordId of plan.operation.live_record_ids) {
              if (plan.removedIds.includes(recordId)) continue;
              const record = fetchedById.get(recordId);
              if (!record) throw new Error(`待扣减实时库存 ${recordId} 不存在，请人工核对`);
              if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(plan.item.input.productRecordId) ||
                !linkedRecordIds(record.fields?.[liveFields.size]).includes(plan.sizeReference.recordId) ||
                !consumableStates.includes(textValue(record.fields?.[stateField]))) {
                throw new Error(`待扣减实时库存 ${recordId} 的货品、尺码或状态已改变，请人工核对`);
              }
              await this.gateway.delete('liveInventory', recordId);
              plan.removedIds.push(recordId);
              await this.store.update(plan.item.operationId, { removed_live_record_ids: plan.removedIds });
            }
          }
        }
      }
      // ④ 终态 + 逐条日志（与 `executeOperation` 同形、同序）。
      for (const plan of plans) {
        const operation = plan.operation;
        const result = {
          stockKey: operation.stock_key,
          ledgerRecordId: operation.ledger_record_id,
          liveRecordIds: plan.removedIds,
          movementQuantity: operation.quantity,
          direction: operation.direction,
          quantity: operation.target_quantity,
          sampleConsumedQuantity: operation.sample_consumed_quantity || 0,
          productRecordId: operation.product_record_id,
          consumedLiveRecordIds: plan.removedIds,
        };
        await this.store.update(plan.item.operationId, { status: 'completed', result });
        logInfo('inventory.change.applied', {
          operation_id: operation.operation_id,
          kind: operation.kind,
          stock_key: operation.stock_key,
          ...stockKeyLabelOfOperation(operation),
          movement_quantity: operation.quantity,
          direction: operation.direction,
          target_quantity: operation.target_quantity,
          ledger_record_id: operation.ledger_record_id,
          live_record_ids: plan.removedIds,
          operator_open_id: operation.operator_open_id || undefined,
          ...correlation,
        });
        results[plan.index] = result;
      }
      // 库存**已经写进飞书** ⇒ 当场作废扫码页那份内存快照（与两条既有通路同一条纪律）。
      if (plans.length) invalidateLiveInventorySnapshot('inventory_changed');
      return results;
    });
  }

module.exports = {
  applyPurchaseReturnBatch,
};
