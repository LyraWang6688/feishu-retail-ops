// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 2066-2196 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 库存流水 / 实时库存的**读取与审计**：重放前核对、幂等回查、重复事实检查。
const { linkedRecordIds, singleLinked, textValue } = require('../v1BitableGateway');
const { OPERATION_ITEM_KEY_FIELD } = require('../../infrastructure/idempotencyKey');
const { requireMovement } = require('./movements');
const { operationItemKey } = require('./keys');

  // 同一个键出现两条实时库存，说明这一双已经被写过两次：真实库存已经错了。
  // 这时不能继续补写，也不能挑一条继续，只能停下让人核对。
async function assertNoDuplicateOperationItems(operation, fromSequence, toSequence, preFetchedRecords = null) {
    if (fromSequence > toSequence) return;
    const fieldName = this.gateway.table('liveInventory').fields?.[OPERATION_ITEM_KEY_FIELD];
    if (!fieldName) return;
    const expected = new Set();
    for (let sequence = fromSequence; sequence <= toSequence; sequence += 1) {
      expected.add(operationItemKey(operation.operation_id, sequence));
    }
    const counts = new Map();
    // ⭐ 2026-10-13：批量路径把**已经读到的那一份**实时库存传进来（一批一次整表读，
    //    不传 = 逐条路径逐字不变）。
    for (const record of (preFetchedRecords || await this.gateway.listAll('liveInventory'))) {
      const key = textValue(record.fields?.[fieldName]).trim();
      if (expected.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count > 1) {
        throw new Error(`实时库存中已存在 ${count} 条库存操作键为 ${key} 的记录，库存事实重复，请人工核对后再入库`);
      }
    }
  }

async function findOperationLedger(operation) {
    const movement = requireMovement(operation.kind);
    // 没有来源字段的动作（采购退货）无法按来源回查流水，只能靠 operation.ledger_record_id
    // 这条本地记录；这也是为什么它的重试保护弱于销售（见 STOCK_MOVEMENTS 的注释）。
    const listed = movement.ledgerSource
      ? await this.findLedger(movement.ledgerSource, operation.source_record_id, operation.behavior_record_id)
      : null;
    if (!operation.ledger_record_id) {
      if (operation.status === 'ledger_created' && !listed) {
        throw new Error(`库存操作 ${operation.operation_id} 的已创建流水无法确认，请人工核对`);
      }
      return listed;
    }
    const direct = await this.gateway.get('inventoryLedger', operation.ledger_record_id);
    if (!direct || (listed && listed.record_id !== direct.record_id)) {
      throw new Error(`库存操作 ${operation.operation_id} 的已创建流水不存在或不一致，请人工核对`);
    }
    return direct;
  }

  // A resumed task may only reuse a ledger row we can prove belongs to it.
  // Rows written before the 尺码 field became a relation still hold a numeric
  // value (or an empty link after migration), so every existing caller audits
  // the same five facts before continuing.
  // 没有来源字段的动作（采购退货）只核对四项：那张表里根本没有能放下这张来源的列，
  // 硬核对会把"字段名 undefined"当成不匹配，把可恢复的任务判成人工介入。
function ledgerMatchesOperation(ledger, { productRecordId, sizeRecordId, behaviorRecordId,
    sourceField, sourceRecordId, quantityChange }) {
    const fields = this.gateway.table('inventoryLedger').fields;
    return singleLinked(ledger.fields?.[fields.product], productRecordId) &&
      singleLinked(ledger.fields?.[fields.size], sizeRecordId) &&
      singleLinked(ledger.fields?.[fields.behavior], behaviorRecordId) &&
      (!sourceField || singleLinked(ledger.fields?.[fields[sourceField]], sourceRecordId)) &&
      Number(ledger.fields?.[fields.quantityChange]) === quantityChange;
  }

async function auditExistingOperationRecords(operation, ledger, sizeRecordId) {
    const manual = (reason) => {
      throw new Error(`库存操作 ${operation.operation_id} ${reason}，请人工核对，不能自动恢复`);
    };
    if (ledger && !this.ledgerMatchesOperation(ledger, {
      productRecordId: operation.product_record_id,
      sizeRecordId,
      behaviorRecordId: operation.behavior_record_id,
      sourceField: requireMovement(operation.kind).ledgerSource,
      sourceRecordId: operation.source_record_id,
      quantityChange: operation.quantity,
    })) {
      manual(`已有库存流水 ${ledger.record_id} 的货品、尺码关联、行为、来源或数量不一致`);
    }
    const createdIds = operation.created_live_record_ids || [];
    const removedIds = operation.removed_live_record_ids || [];
    const selectedIds = operation.live_record_ids || [];
    if (new Set(createdIds).size !== createdIds.length || createdIds.length > operation.quantity ||
      new Set(removedIds).size !== removedIds.length ||
      removedIds.some((recordId) => !selectedIds.includes(recordId))) {
      manual('已记录的实时库存 ID 不一致');
    }
    if (operation.schema_version === 2 && removedIds.length) {
      manual('旧版销售任务已有库存删除，已删除记录的尺码关联无法再核实');
    }
    const liveFields = this.gateway.table('liveInventory').fields;
    if (operation.direction === '增加') {
      for (const [index, recordId] of createdIds.entries()) {
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record || !singleLinked(record.fields?.[liveFields.product], operation.product_record_id) ||
          !singleLinked(record.fields?.[liveFields.size], sizeRecordId) ||
          textValue(record.fields?.[liveFields.state]) !== operation.state) {
          manual(`已有实时库存 ${recordId} 的货品、尺码关联或状态不一致`);
        }
        // 库存操作键是「这一双属于本次操作第几条」的证明。老记录可能没有这个值
        // （字段是后加的），但一旦写了就必须和本地清单对得上，否则无法区分
        // 「这就是我要的那一双」和「别的操作写进来的同一货品尺码」。
        const recordedKey = textValue(record.fields?.[liveFields[OPERATION_ITEM_KEY_FIELD]]).trim();
        if (recordedKey && recordedKey !== operationItemKey(operation.operation_id, index + 1)) {
          manual(`已有实时库存 ${recordId} 的库存操作键与本地记录不一致`);
        }
      }
    } else if (operation.direction === '减少') {
      if (selectedIds.length !== operation.quantity) manual('待扣减实时库存数量不一致');
      // 同 executeOperation：可扣状态来自注册表的 consumes（销售 门盒+样品、采购退货还要加 仓库）。
      const consumableStates = requireMovement(operation.kind).consumes || [operation.state];
      for (const recordId of selectedIds) {
        if (removedIds.includes(recordId)) continue;
        const record = await this.gateway.get('liveInventory', recordId);
        if (!record || !singleLinked(record.fields?.[liveFields.product], operation.product_record_id) ||
          !singleLinked(record.fields?.[liveFields.size], sizeRecordId) ||
          !consumableStates.includes(textValue(record.fields?.[liveFields.state]))) {
          manual(`待扣减实时库存 ${recordId} 的货品、尺码关联或状态不一致`);
        }
      }
    } else {
      manual('库存方向无效');
    }
  }

  // ledgerSource 是库存流水里回指来源明细的语义字段名（见 v1BitableSchema）。
async function findLedger(ledgerSource, sourceRecordId, behaviorRecordId) {
    const table = this.gateway.table('inventoryLedger');
    const fieldName = table.fields[ledgerSource];
    const records = await this.gateway.listAll('inventoryLedger');
    const matches = records.filter((record) =>
      linkedRecordIds(record.fields?.[fieldName]).includes(sourceRecordId) &&
      (!behaviorRecordId || linkedRecordIds(record.fields?.[table.fields.behavior]).includes(behaviorRecordId)));
    if (matches.length > 1) throw new Error(`来源明细 ${sourceRecordId} 存在重复库存流水`);
    return matches[0] || null;
  }

module.exports = {
  assertNoDuplicateOperationItems,
  findOperationLedger,
  ledgerMatchesOperation,
  auditExistingOperationRecords,
  findLedger,
};
