// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 1597-1693 / 1695-1790 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 状态类变更通路：transitionState（准备）+ executeStateTransition（执行）。
const { linkedRecordIds, textValue } = require('../v1BitableGateway');
const { relation } = require('../v1ReferenceResolver');
const { normalizeSize } = require('../sizeReferenceService');
const { logInfo } = require('../../utils/logger');
const { correlationFields } = require('../../utils/correlationFields');
const { invalidateLiveInventorySnapshot } = require('../liveInventorySnapshot');
const { requireStateMovement, resolveTargetState } = require('./movements');
const {
  operationId,
  positiveInteger,
  stockKeyLabelFields,
  correlationPatch,
  stockKeyLabelOfOperation,
} = require('./keys');

  // ── 状态变更通路（人工「换季调整」：转冻结 / 转释放门盒，以及样品 ↔ 门盒）────────
  // 与 applyChange 的分工：
  //   · applyChange   = 数量类（增加 / 减少）——新建或删除「实时库存」记录；
  //   · transitionState = 状态类（方向=不影响）——**只改「所属状态」，一条记录都不增删**。
  // 两条通路共用 runForStock 串行队列，避免和销售/采购同时改同一双鞋。
  //
  // 幂等：`sourceRecordId` 由入口提供（工作台侧 = requestId + 目标身份，
  // 同一次提交重试复用同一个 requestId，见 InventoryAdjustmentService）。
  //
  // ⚠️ 为什么人工调整还需要 `findOperationBySource`：`operationId(kind, source)` 里带 kind，
  // 而「按实际盘点数」的 kind（调增还是调减）**要先算出差额才知道**——重试时账面已经变了，
  // 差额会算成 0，于是拿不到原来那条任务、反而报"不需要调整"。所以入口先用来源回查一次，
  // 命中已完成任务就直接返回它（同一次提交重试的唯一正确语义）。

async function transitionState(input = {}, options = {}) {
    if (!input.productRecordId) throw new Error('库存状态变更缺少商品 record_id');
    if (!input.sourceRecordId) throw new Error('库存状态变更缺少来源标识（requestId）');
    const movement = requireStateMovement(input.kind);
    const transition = movement.stateTransition;
    const fromStates = [].concat(transition.from);
    const size = normalizeSize(input.size);
    const quantity = positiveInteger(input.quantity, '变更数量');
    const toState = resolveTargetState(input.kind, transition, input.toState);
    // 单一起点（转释放门盒：仓库）可以由配置决定；多起点（转冻结：门盒/样品）必须由入口指明，
    // 否则"这一双原来在哪"就靠猜了。
    const fromState = fromStates.length === 1 ? fromStates[0] : String(input.fromState || '').trim();
    if (!fromStates.includes(fromState)) {
      throw new Error(`库存动作「${input.kind}」只能从「${fromStates.join('、')}」转出，`
        + `不能从「${fromState || '空'}」转出`);
    }
    if (fromState === toState) throw new Error(`库存动作「${input.kind}」的起点和终点都是「${toState}」，无需调整`);
    const stockKey = `${input.productRecordId}|${size}|${fromState}`;
    const correlation = correlationFields(options.correlation);
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      const sizeReference = await this.sizeReferences.resolveByNumber(size);
      await this.resumePending(stockKey);
      const id = operationId(input.kind, input.sourceRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if (operation.kind !== input.kind || operation.product_record_id !== input.productRecordId ||
          operation.size !== size || operation.from_state !== fromState ||
          operation.to_state !== toState || operation.quantity !== quantity) {
          throw new Error(`来源 ${input.sourceRecordId} 的库存状态变更内容与首次提交不一致`);
        }
      } else {
        // 行为表的「库存方向=不影响」+ 是否启用在这里校验（resolveStockBehavior）。
        const behavior = await this.resolveStockBehavior(input.kind);
        const allLiveRecords = await this.gateway.listAll('liveInventory');
        const candidates = this
          .findLiveInventoryIn(allLiveRecords, input.productRecordId, sizeReference.recordId, fromState)
          .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id)));
        if (candidates.length < quantity) {
          throw new Error(`${fromState}库存不足：${input.productRecordId} ${size}码，`
            + `需 ${quantity} 双，现有 ${candidates.length} 双`);
        }
        operation = await this.store.create({
          operation_id: id,
          type: 'state_transition',
          schema_version: 3,
          status: 'prepared',
          kind: input.kind,
          stock_key: stockKey,
          // 同 applyChange：抄这次已经读到的实时库存记录上的「库存键」，零额外请求。
          ...stockKeyLabelFields({
            record: candidates[0],
            fieldName: this.gateway.table('liveInventory').fields.stockKey,
            fallback: options.stockKeyLabel,
          }),
          ...correlationPatch(correlation),
          product_record_id: input.productRecordId,
          size,
          size_record_id: sizeReference.recordId,
          from_state: fromState,
          to_state: toState,
          quantity,
          direction: behavior.direction,
          behavior_record_id: behavior.recordId,
          source_record_id: input.sourceRecordId,
          occurred_at: Number(input.occurredAt || Date.now()),
          // 同上：人工调整的操作人只落本地任务 + 日志（「库存流水」还没有「操作人」列）。
          operator_open_id: input.operatorOpenId || '',
          live_record_ids: candidates.slice(0, quantity).map((record) => record.record_id),
          moved_live_record_ids: [],
          current_quantity: candidates.length,
        });
      }
      return this.executeStateTransition(operation);
    });
  }

  // 状态变更的执行体。顺序与 executeOperation 一致：先确认流水，再动实时库存；
  // 每一步都把已完成的进度写回本地任务，中途失败（或响应丢失）后按同一任务续跑。
async function executeStateTransition(operation) {
    if (operation.status === 'completed') return operation.result;
    if (![2, 3].includes(operation.schema_version)) {
      throw new Error(`库存状态变更 ${operation.operation_id} 使用旧结构且尚未完成，请先人工核对，不能自动重试`);
    }
    const movement = requireStateMovement(operation.kind);
    // 同 executeOperation：关联键取这条本地任务记录自己的（重放时不会挂到当前请求上）。
    const correlation = correlationFields(operation.correlation);
    const sizeReference = await this.sizeReferences.resolveByNumber(operation.size);
    if (operation.size_record_id && operation.size_record_id !== sizeReference.recordId) {
      throw new Error(`库存状态变更 ${operation.operation_id} 的尺码关联已改变，请人工核对`);
    }
    // 流水先写：数量类动作的第三层幂等靠「按来源回查流水」，人工调整没有来源列
    //（ledgerSource = null），只能靠本地任务上的 ledger_record_id，所以先把 id 落盘。
    let ledger = await this.findOperationLedger(operation);
    if (ledger && !this.ledgerMatchesOperation(ledger, {
      productRecordId: operation.product_record_id,
      sizeRecordId: sizeReference.recordId,
      behaviorRecordId: operation.behavior_record_id,
      sourceField: null,
      sourceRecordId: null,
      // 状态变更不改变数量：流水「变动数量」必须是 0
      //（与补样品 promoteToSample 同一个形状；「变动数量」存绝对值，增减靠方向表达）。
      quantityChange: 0,
    })) {
      throw new Error(`已有库存流水 ${ledger.record_id} 的货品、尺码关联、行为或数量不一致，请人工核对，不能自动恢复`);
    }
    if (!ledger) {
      const created = await this.gateway.create('inventoryLedger', {
        product: relation(operation.product_record_id),
        size: relation(sizeReference.recordId),
        quantityChange: 0,
        behavior: relation(operation.behavior_record_id),
      }, { correlation });
      ledger = { record_id: created.recordId };
      operation = await this.store.update(operation.operation_id, {
        status: 'ledger_created', ledger_record_id: ledger.record_id,
      });
    }
    const liveFields = this.gateway.table('liveInventory').fields;
    const moved = [...(operation.moved_live_record_ids || [])];
    for (const recordId of operation.live_record_ids || []) {
      if (moved.includes(recordId)) continue;
      const record = await this.gateway.get('liveInventory', recordId);
      if (!record) throw new Error(`待变更状态的实时库存 ${recordId} 不存在，请人工核对`);
      if (!linkedRecordIds(record.fields?.[liveFields.product]).includes(operation.product_record_id) ||
        !linkedRecordIds(record.fields?.[liveFields.size]).includes(sizeReference.recordId)) {
        throw new Error(`待变更状态的实时库存 ${recordId} 的货品或尺码已改变，请人工核对`);
      }
      const current = textValue(record.fields?.[liveFields.state]);
      // 已经是目标状态 = 上一步写成功但本地没落盘，视为已完成（幂等）；
      // 既不是起点也不是终点 = 别人动过这一双，停下转人工，绝不硬改。
      if (current !== operation.to_state && current !== operation.from_state) {
        throw new Error(`待变更状态的实时库存 ${recordId} 的所属状态是「${current}」，`
          + `既不是「${operation.from_state}」也不是「${operation.to_state}」，请人工核对`);
      }
      if (current !== operation.to_state) {
        await this.gateway.update('liveInventory', recordId, { state: operation.to_state }, { correlation });
      }
      moved.push(recordId);
      operation = await this.store.update(operation.operation_id, { moved_live_record_ids: moved });
    }
    const result = {
      stockKey: operation.stock_key,
      ledgerRecordId: ledger.record_id,
      liveRecordIds: moved,
      movementQuantity: 0,
      direction: movement.direction,
      productRecordId: operation.product_record_id,
      size: operation.size,
      fromState: operation.from_state,
      toState: operation.to_state,
      quantity: operation.quantity,
    };
    await this.store.update(operation.operation_id, { status: 'completed', result });
    logInfo('inventory.state.transitioned', {
      operation_id: operation.operation_id,
      kind: operation.kind,
      stock_key: operation.stock_key,
      ...stockKeyLabelOfOperation(operation),
      from_state: operation.from_state,
      to_state: operation.to_state,
      quantity: operation.quantity,
      live_record_ids: moved,
      ledger_record_id: ledger.record_id,
      operator_open_id: operation.operator_open_id || undefined,
      ...correlation,
    });
    // ⭐ 2026-10-09：库存**已经写进飞书**了 ⇒ 当场作废扫码页那份内存快照
    //   （她的第一要求是"库存准确"；不作废就会给她看一份最多 30 秒前的库存）。
    //   ⚠️ 放在 `logInfo` 之后、`return` 之前：这一行**永不抛**（模块内部自己 try/catch 了 no-op 路径）。
    invalidateLiveInventorySnapshot('inventory_changed');
    return result;
  }

module.exports = {
  transitionState,
  executeStateTransition,
};
