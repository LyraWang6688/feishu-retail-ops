// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 1908-2064 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 数量类库存操作的执行体：executeOperation（逐条路径唯一的"写实时库存"落点）。
// ⭐ 库存**已经写进飞书** ⇒ 当场作废扫码页那份内存快照（本文件中那一行，永不抛）。
const { linkedRecordIds, textValue } = require('../v1BitableGateway');
const { relation } = require('../v1ReferenceResolver');
const { createOnceByKey, OPERATION_ITEM_KEY_FIELD } = require('../../infrastructure/idempotencyKey');
const { logInfo, logWarn } = require('../../utils/logger');
const { correlationFields } = require('../../utils/correlationFields');
const { invalidateLiveInventorySnapshot } = require('../liveInventorySnapshot');
const { requireMovement } = require('./movements');
const {
  operationItemKey,
  movementLedgerLinkValue,
  stockKeyLabelOfOperation,
} = require('./keys');

async function executeOperation(operation) {
    if (operation.status === 'completed') return operation.result;
    if (![2, 3].includes(operation.schema_version)) {
      throw new Error(`库存操作 ${operation.operation_id} 使用旧结构且尚未完成，请先人工核对，不能自动重试`);
    }
    const movement = requireMovement(operation.kind);
    // 关联键取自**这条本地任务记录自己**（不是当前请求）：resumePending 会把上一笔单
    // 尚未完成的操作放到这次请求里续跑，用当前请求的键会把日志指向错的任务。
    const correlation = correlationFields(operation.correlation);
    const sizeReference = await this.sizeReferences.resolveByNumber(operation.size);
    if (operation.size_record_id && operation.size_record_id !== sizeReference.recordId) {
      throw new Error(`库存操作 ${operation.operation_id} 的尺码关联已改变，请人工核对`);
    }
    let ledger = await this.findOperationLedger(operation);
    await this.auditExistingOperationRecords(operation, ledger, sizeReference.recordId);
    if (operation.schema_version === 2 && !ledger) {
      throw new Error(`旧版库存操作 ${operation.operation_id} 未能确认已有流水，请人工核对，不能自动恢复`);
    }
    if (operation.direction === '增加') {
      // 先确认远端没有「同一个键出现两条」这种已经重复的事实，再写流水：
      // 已经重复时应该停下来让人核对，而不是再补一条流水把差异藏起来。
      await this.assertNoDuplicateOperationItems(operation, (operation.created_live_record_ids || []).length + 1,
        operation.quantity);
    }
    if (!ledger) {
      // 远端关联值：注册表声明的"只写不查"关联列（`ledgerLink`）。取不到就**整列不写**。
      const ledgerLinkValue = movementLedgerLinkValue(movement, operation);
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id),
        size: relation(sizeReference.recordId),
        quantityChange: operation.quantity,
        behavior: relation(operation.behavior_record_id),
        // 来源字段由注册表声明：新增动作不必再改这里。
        // ledgerSource 为 null 的动作（采购退货 / 采购加库存）没有可"按来源回查"的列，整列不写。
        ...(movement.ledgerSource
          ? { [movement.ledgerSource]: relation(operation.source_record_id) }
          : {}),
        // ⭐ 2026-10-08：「关联采购」——只写不查的关联列（值 = 报货批次那一行的 record id，
        //    与本地幂等键 `source_record_id` 是**两个东西**）。拿不到就一个字都不写。
        ...(ledgerLinkValue ? { [movement.ledgerLink.field]: relation(ledgerLinkValue) } : {}),
      }, { correlation });
      ledger = { record_id: created.recordId };
    }
    operation = await this.store.update(operation.operation_id, {
      status: 'ledger_created',
      ledger_record_id: ledger.record_id,
    });

    const liveRecordIds = operation.live_record_ids || [];
    const removedIds = operation.removed_live_record_ids || [];
    const createdIds = operation.created_live_record_ids || [];
    // 可扣减的状态 = 注册表声明的消耗清单（销售是 门盒+样品，采购退货还要加 仓库）。
    // 以前这里写死成 ['门盒','样品']：写死会让"仓库里的退货"永远报"状态已改变"。
    const consumableStates = movement.consumes || [operation.state];
    if (operation.direction === '减少') {
      for (const recordId of liveRecordIds) {
        if (removedIds.includes(recordId)) continue;
        // A list response may lag behind the selected record. Confirm the
        // exact record before deleting; never report a deduction based only
        // on its absence from a possibly stale list.
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record) throw new Error(`待扣减实时库存 ${recordId} 不存在，请人工核对`);
        const liveFields = this.gateway.table('liveInventory').fields;
        if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(operation.product_record_id) ||
          !linkedRecordIds(record.fields?.[liveFields.size]).includes(sizeReference.recordId) ||
          !consumableStates.includes(textValue(record.fields?.[liveFields.state]))) {
          throw new Error(`待扣减实时库存 ${recordId} 的货品、尺码或状态已改变，请人工核对`);
        }
        await this.gateway.delete('liveInventory', recordId);
        removedIds.push(recordId);
        operation = await this.store.update(operation.operation_id, { removed_live_record_ids: removedIds });
      }
    } else {
      const expectedCreates = operation.quantity;
      while (createdIds.length < expectedCreates) {
        // 第 N 双先按「库存操作键」回查远端，再决定是否创建：
        // 飞书创建成功但本地 journal 没写下去（崩溃 / 磁盘失败 / 响应丢失）时，
        // 直接重发 create 会把库存 +1 变成 +2，而 +2 在业务上是看不出来的。
        const itemKey = operationItemKey(operation.operation_id, createdIds.length + 1);
        const created = await createOnceByKey({
          gateway: this.gateway,
          tableKey: 'liveInventory',
          keyField: OPERATION_ITEM_KEY_FIELD,
          keyValue: itemKey,
          label: `实时库存 ${itemKey}`,
          correlation,
          values: {
            product: relation(operation.product_record_id),
            size: relation(sizeReference.recordId),
            state: operation.state || '门盒',
            operationItemKey: itemKey,
          },
        });
        createdIds.push(created.recordId);
        operation = await this.store.update(operation.operation_id, { created_live_record_ids: createdIds });
      }
    }

    const result = {
      stockKey: operation.stock_key,
      ledgerRecordId: ledger.record_id,
      liveRecordIds: operation.direction === '减少' ? removedIds : createdIds,
      movementQuantity: operation.quantity,
      direction: operation.direction,
      quantity: operation.target_quantity,
      sampleConsumedQuantity: operation.sample_consumed_quantity || 0,
      productRecordId: operation.product_record_id,
      consumedLiveRecordIds: movement.direction === '减少' ? removedIds : [],
    };
    if (movement.triggerSampleReplacement && result.sampleConsumedQuantity) {
      try {
        result.remainingSizes = await this.sampleReplacementCandidates(operation.product_record_id,
          { excludeRecordIds: removedIds });
      } catch (error) {
        // The stock movement is already durable. A malformed or temporarily
        // unreadable remaining row must not turn a successful delivery into a
        // failed one; the replacement card can retry this separate lookup.
        result.remainingSizes = [];
        result.replacementCandidatesUnavailable = true;
        logWarn('inventory.sample_candidates.failed', {
          operation_id: operation.operation_id,
          source_record_id: operation.source_record_id,
          error: error.message,
          ...correlation,
        });
      }
    }
    await this.store.update(operation.operation_id, {
      status: 'completed',
      result,
    });
    // ⭐ 「库存键」两种写法并列（业务负责人 2026-10-07 拍板）：
    //    `stock_key` = 内部 `rec…|尺码|状态`（**原值不动**，既有排查脚本/断言依赖它）；
    //    `stock_key_label` = 飞书算好的 `货号|颜色|类别|尺码`（人读得懂、表里搜得到）。
    //    再叠上关联键 ⇒ 按 `task_id` / `order_no` / `sales_entry_record_id` 任一键
    //    都能把这一条和它那笔业务串起来（这正是这次事故里"看不到库存"的那半）。
    logInfo('inventory.change.applied', {
      operation_id: operation.operation_id,
      kind: operation.kind,
      stock_key: operation.stock_key,
      ...stockKeyLabelOfOperation(operation),
      movement_quantity: operation.quantity,
      direction: operation.direction,
      target_quantity: operation.target_quantity,
      ledger_record_id: ledger.record_id,
      live_record_ids: result.liveRecordIds,
      operator_open_id: operation.operator_open_id || undefined,
      ...correlation,
    });
    // ⭐ 2026-10-09：**逐条路径里这里是唯一真正写「实时库存」的地方**（销售入账 / 到货 /
    //   库存状态变更 / 补样品最后都落到这一处）⇒ 写成功之后当场作废扫码页的内存快照。
    //   ⚠️ 2026-10-13：`applyPurchaseBatch`（验收提速的批量口）是**第二处**，它同样在写成功后作废
    //      （见那边结尾的那一行）—— 所以"全仓唯一"这句已经不再成立，不要照旧相信它。
    //   ⚠️ 连告警/日志都写完了才作废：作废本身只清内存 + fire-and-forget 重拉，永不抛。
    invalidateLiveInventorySnapshot('inventory_changed');
    return result;
  }

module.exports = {
  executeOperation,
};
