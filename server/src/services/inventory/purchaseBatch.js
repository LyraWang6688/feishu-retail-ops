// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 951-1157 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 采购到货加库存的批量口：applyPurchaseBatch。
const { textValue } = require('../v1BitableGateway');
const { relation } = require('../v1ReferenceResolver');
const { normalizeSize } = require('../sizeReferenceService');
const { OPERATION_ITEM_KEY_FIELD } = require('../../infrastructure/idempotencyKey');
const { logInfo } = require('../../utils/logger');
const { correlationFields } = require('../../utils/correlationFields');
const { invalidateLiveInventorySnapshot } = require('../liveInventorySnapshot');
const { requireMovement, MOVEMENT_PURCHASE_INCREASE, LIVE_STATES } = require('./movements');
const {
  operationId,
  positiveInteger,
  stockKeyLabelFields,
  correlationPatch,
  stockKeyLabelOfOperation,
  movementLedgerLinkPatch,
  movementLedgerLinkValue,
  operationItemKey,
  purchaseIncreaseSourceId,
} = require('./keys');

  /**
   * ⭐⭐ 2026-10-13（验收提速 ①）：**一批一次写**的采购加库存 —— `applyPurchase` 的批量版。
   *
   * 为什么要有它（真账）：每批 5 码 143.9 秒，其中**逐码"库存流水 + 实时库存" = 119.5 秒（83%）**。
   * 逐条路径每码要敲 **6 次**飞书（`listAll('liveInventory')` ×3 + `listAll('behavior')` ×1
   * + `create('inventoryLedger')` ×1 + `create('liveInventory')` ×1）⇒ 5 码 **31 次**（假网关实测）。
   * 本方法把"这一批"折成 **1 次整表读 + ≤2 次批量写**：
   *   `listAll('liveInventory')`（一批一次，同时喂：重复事实检查 + 幂等"已建过"回查 + 「库存键」标签）
   *   + `createBatch('inventoryLedger', rows)` + `createBatch('liveInventory', rows)`
   *
   * 🔴 **语义一行不改**（与逐条路径逐字对齐，AC 用"字段集逐字相同"钉住）：
   *   · 幂等键 = `purchaseIncreaseSourceId(input)`（本地 task journal）+ 每双的「库存操作键」
   *     （`operationItemKey(operationId, 序号)`）⇒ **重跑零写**、崩溃后按同一把键续跑；
   *   · 行为解析 / 库存方向 / 「关联采购」关联值 / 「库存键」标签 **复用逐条路径那几个 helper**；
   *   · 串行队列：**按 `stock_key` 先过一遍**（`runForStocks`，跨任务同 key 不会被绕过）；
   *   · 失败粒度 = **整批一次写**（任一批量写失败 ⇒ 这一批一条都不写；重试按同一把键补齐）。
   * ⚠️ 调用方（`confirmArrival`）已按 `货品 + 尺码` 聚合过 ⇒ 同一批里 `stock_key` 不重复
   *   （本方法不做这个聚合，与逐条路径同一条纪律：聚合是调用方的事）。
   *
   * @param {Array<object>} items 每项与 `applyPurchase` 的入参同形
   *   （`productRecordId`/`size`/`quantity`/`state`/来源三元组…）
   * @returns {Promise<Array<object>>} 与 `applyChange` 同形的结果数组（顺序 = 入参顺序）
   */
async function applyPurchaseBatch(items = [], options = {}) {
    const list = (Array.isArray(items) ? items : []).filter(Boolean);
    if (!list.length) return [];
    const correlation = correlationFields(options.correlation);
    // ⭐ 2026-10-13：验收那一段自造的耗时汇总（`options.timing`）——本层只**填** `inventory_ms`
    //    （"加库存"那一段的净耗时只有这里量得准）。⚠️ 只进日志，不改任何判定、不改返回值形状。
    const timing = options.timing || null;
    const timingStartedAt = Date.now();
    const movement = requireMovement(MOVEMENT_PURCHASE_INCREASE);
    const prepared = list.map((input) => {
      if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
      const sourceRecordId = purchaseIncreaseSourceId(input);
      if (!sourceRecordId) throw new Error('库存变化缺少来源明细 record_id');
      const size = normalizeSize(input.size);
      const state = String(input.state || '门盒');
      if (!LIVE_STATES.includes(state)) throw new Error('库存所属状态无效');
      return {
        input,
        sourceRecordId,
        size,
        state,
        quantity: positiveInteger(input.quantity, '采购入库数量'),
        operationId: operationId(MOVEMENT_PURCHASE_INCREASE, sourceRecordId),
        stockKey: `${input.productRecordId}|${size}|${state}`,
      };
    });
    const stockKeys = [...new Set(prepared.map((item) => item.stockKey))].sort();
    return this.runForStocks(stockKeys, async () => {
      await this.ensureSchema();
      for (const key of stockKeys) await this.resumePending(key);
      const behavior = await this.resolveStockBehavior(MOVEMENT_PURCHASE_INCREASE);
      const liveFields = this.gateway.table('liveInventory').fields;
      const itemKeyField = liveFields?.[OPERATION_ITEM_KEY_FIELD];
      // ⭐ 一批**一次**整表读（原来每码 3 次：调用方的状态判定 + 重复检查 + 幂等回查各 1 次）。
      const allLive = await this.gateway.listAll('liveInventory');
      const plans = [];
      for (const item of prepared) {
        const sizeReference = await this.sizeReferences.resolveByNumber(item.size);
        const existingRows = this.findLiveInventoryIn(
          allLive, item.input.productRecordId, sizeReference.recordId, item.state,
        );
        const journal = await this.store.get(item.operationId);
        // ⭐ 与逐条路径**同一处**的"重复事实"检查（一份已读数据传进去 ⇒ 不额外读表、不新写文案）。
        await this.assertNoDuplicateOperationItems(
          { operation_id: item.operationId }, 1, item.quantity, allLive,
        );
        const liveRecordIds = [];
        const toCreate = [];
        for (let sequence = 1; sequence <= item.quantity; sequence += 1) {
          const itemKey = operationItemKey(item.operationId, sequence);
          const matches = itemKeyField
            ? allLive.filter((record) => textValue(record.fields?.[itemKeyField]).trim() === itemKey)
            : [];
          // 重复事实检查**复用既有那一处**（`assertNoDuplicateOperationItems`，稍后统一跑一次，
          // 把已经读到的那一份实时库存传进去）⇒ 判据与报文都只有一处，不新写一句文案。
          if (matches.length === 1) {
            logInfo('idempotency.reused', {
              table_key: 'liveInventory', key: itemKey, record_id: matches[0].record_id,
            });
            liveRecordIds.push(matches[0].record_id);
          } else toCreate.push(itemKey);
        }
        // 本地任务形状**逐字照抄**逐条路径的 `store.create({...})`（journal 是幂等与续跑的唯一依据）。
        const operation = {
          operation_id: item.operationId,
          type: 'inventory_change',
          schema_version: 3,
          status: 'prepared',
          kind: MOVEMENT_PURCHASE_INCREASE,
          stock_key: item.stockKey,
          ...stockKeyLabelFields({
            record: existingRows[0],
            fieldName: liveFields?.stockKey,
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
          live_record_ids: [],
          sample_consumed_quantity: 0,
          removed_live_record_ids: [],
          created_live_record_ids: liveRecordIds,
          current_quantity: existingRows.length,
          target_quantity: existingRows.length + item.quantity,
        };
        plans.push({
          item,
          sizeReference,
          operation,
          journal,
          liveRecordIds,
          toCreate,
          ledgerRecordId: journal?.ledger_record_id || '',
        });
      }
      // ① 流水：本地没有 `ledger_record_id` 的才建 —— **一批一次**（列与值照抄 `executeOperation`）。
      const ledgerNeeded = plans.filter((plan) => !plan.ledgerRecordId);
      if (ledgerNeeded.length) {
        const rows = ledgerNeeded.map((plan) => {
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
        ledgerNeeded.forEach((plan, index) => { plan.ledgerRecordId = created[index]?.recordId || ''; });
      }
      // ② 实时库存：这一批里"还没有那一条"的才建 —— **一批一次**。
      const liveNeeded = plans.flatMap((plan) => plan.toCreate.map((itemKey) => ({ plan, itemKey })));
      if (liveNeeded.length) {
        const rows = liveNeeded.map(({ plan, itemKey }) => ({
          product: relation(plan.item.input.productRecordId),
          size: relation(plan.sizeReference.recordId),
          state: plan.item.state,
          operationItemKey: itemKey,
        }));
        const created = await this.gateway.createBatch('liveInventory', rows, { correlation });
        liveNeeded.forEach((entry, index) => { entry.plan.liveRecordIds.push(created[index]?.recordId || ''); });
      }
      // ③ 落本地任务 + 逐条日志（**成功之后**才落盘 ⇒ 批量失败时一条 journal 都不留，重试从同一把键补齐）。
      const results = [];
      for (const plan of plans) {
        const result = {
          stockKey: plan.item.stockKey,
          ledgerRecordId: plan.ledgerRecordId,
          liveRecordIds: plan.liveRecordIds,
          movementQuantity: plan.item.quantity,
          direction: behavior.direction,
          quantity: plan.operation.target_quantity,
          sampleConsumedQuantity: 0,
          productRecordId: plan.item.input.productRecordId,
          consumedLiveRecordIds: [],
        };
        const completed = {
          ...plan.operation,
          status: 'completed',
          ledger_record_id: plan.ledgerRecordId,
          created_live_record_ids: plan.liveRecordIds,
          result,
        };
        if (plan.journal) await this.store.update(plan.item.operationId, completed);
        else await this.store.create(completed);
        logInfo('inventory.change.applied', {
          operation_id: plan.item.operationId,
          kind: MOVEMENT_PURCHASE_INCREASE,
          stock_key: plan.item.stockKey,
          // ⚠️ 与逐条路径**同形**：两种库存键都给（`stock_key_label` 抄这次已读到的实时库存，
          //    抄不到时只给 `stock_key_label_source: 'unavailable'`，**不猜**）。
          ...stockKeyLabelOfOperation(plan.operation),
          movement_quantity: plan.item.quantity,
          direction: behavior.direction,
          target_quantity: plan.operation.target_quantity,
          ledger_record_id: plan.ledgerRecordId,
          live_record_ids: plan.liveRecordIds,
          operator_open_id: plan.operation.operator_open_id || undefined,
          ...correlation,
        });
        results.push(result);
      }
      // 库存**已经写进飞书** ⇒ 当场作废扫码页那份内存快照（与逐条路径同一条纪律）。
      invalidateLiveInventorySnapshot('inventory_changed');
      if (timing) {
        timing.inventory_ms = Date.now() - timingStartedAt;
        timing.inventory_items = prepared.length;
      }
      return results;
    });
  }

module.exports = {
  applyPurchaseBatch,
};
