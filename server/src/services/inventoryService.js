// ⭐ 2026-10-18（task-5）：**facade + 编排**。
//
// 本文件从 2280 行拆到 `services/inventory/` 子模块后，只留：
//   · 入口薄封装（applySale / applyPurchase / applyPurchaseReturn / applyChange / getSaleResult）
//   · 编排骨架（ensureSchema / runForStock(s) / resolveStockBehavior / resumePending）
//   · 兼容导出（下面 `module.exports` 的键名与拆分前**一个不少**）
//
// ⚠️ **只搬不改**：被搬走的执行体在 `inventory/*.js` 里**逐字节原样**（仍用 `this.`），
//    本文件末尾用 `Object.defineProperty` 把它们挂回 `InventoryService.prototype`
//    —— 与 class 方法**同一份属性描述符**（不可枚举 / 可写 / 可配置）⇒ 接口与 `this` 语义不变。
//
// 拆分去向：
//   · movements.js          行为注册表 / 方向与状态闸门（配置先行）
//   · keys.js               幂等键 / 库存键 / ledgerLink / 操作键
//   · ledger.js             库存流水与实时库存的读取与审计
//   · liveStock.js          实时库存选取与候选计算
//   · saleBatch.js          applySaleBatch
//   · purchaseBatch.js      applyPurchaseBatch
//   · purchaseReturnBatch.js applyPurchaseReturnBatch
//   · executeOperation.js   数量类执行体
//   · stateTransition.js    状态类通路
//   · samplePromotion.js    补样品通路
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { textValue } = require('./v1BitableGateway');
const { SizeReferenceService, normalizeSize } = require('./sizeReferenceService');
const { OPERATION_ITEM_KEY_FIELD, validateIdempotencyKeyFields } = require('../infrastructure/idempotencyKey');
const { correlationFields } = require('../utils/correlationFields');
const {
  STOCK_MOVEMENTS,
  ADJUSTMENT_BEHAVIORS,
  LIVE_STATES,
  BEHAVIOR_SAMPLE_PROMOTION,
  MOVEMENT_SALE_DECREASE,
  MOVEMENT_PURCHASE_INCREASE,
  MOVEMENT_PURCHASE_DECREASE,
  MOVEMENT_SALE_RETURN,
  MOVEMENT_SALE_COMPENSATION,
  MOVEMENT_SALE_CASH,
  requireMovement,
  requireQuantityMovement,
} = require('./inventory/movements');
const {
  operationId,
  positiveInteger,
  stockKeyLabelFields,
  correlationPatch,
  movementLedgerLinkPatch,
  purchaseIncreaseSourceId,
  purchaseReturnSourceId,
} = require('./inventory/keys');
const { applySaleBatch } = require('./inventory/saleBatch');
const { applyPurchaseBatch } = require('./inventory/purchaseBatch');
const { applyPurchaseReturnBatch } = require('./inventory/purchaseReturnBatch');
const { executeOperation } = require('./inventory/executeOperation');
const { transitionState, executeStateTransition } = require('./inventory/stateTransition');
const { promoteToSample, executeSamplePromotion } = require('./inventory/samplePromotion');
const {
  assertNoDuplicateOperationItems,
  findOperationLedger,
  ledgerMatchesOperation,
  auditExistingOperationRecords,
  findLedger,
} = require('./inventory/ledger');
const {
  findLiveInventoryIn,
  findLiveInventory,
  candidatesFromLiveRecords,
  sampleReplacementCandidates,
} = require('./inventory/liveStock');

class InventoryService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('InventoryService requires gateway');
    this.gateway = options.gateway;
    this.sizeReferences = options.sizeReferences || new SizeReferenceService({ gateway: this.gateway });
    this.store =
      options.store ||
      new JsonTaskStore({
        dir: path.join(__dirname, '../../data/inventory_operations'),
        idField: 'operation_id',
      });
    this.queues = new Map();
    this.schemaValidation = null;
  }

  async ensureSchema() {
    if (typeof this.gateway.validateTables !== 'function') return;
    if (!this.schemaValidation) {
      this.schemaValidation = (async () => {
        const result = await this.gateway.validateTables(['behavior', 'sizeManagement', 'inventoryLedger', 'liveInventory']);
        await this.sizeReferences.validateSchema(['inventoryLedger', 'liveInventory']);
        // 增加库存必须能按「库存操作键」回查，否则 create 结果未知时只能盲重建。
        await validateIdempotencyKeyFields({
          gateway: this.gateway,
          tables: [{ tableKey: 'liveInventory', keyField: OPERATION_ITEM_KEY_FIELD }],
        });
        return result;
      })().catch((error) => {
        this.schemaValidation = null;
        throw error;
      });
    }
    return this.schemaValidation;
  }

  async resolveStockBehavior(kind) {
    const movement = requireMovement(kind);
    const fields = this.gateway.table('behavior').fields;
    // 按「行为编码」匹配：编码是稳定标识，飞书里改中文名不影响代码。
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.code]).trim() === kind);
    if (matches.length !== 1) {
      throw new Error(`行为管理中编码为「${kind}」的行为必须且只能有一条记录，请先在行为管理表补齐`);
    }
    const behavior = matches[0];
    const name = textValue(behavior.fields?.[fields.name]).trim() || kind;
    const direction = textValue(behavior.fields?.[fields.stockDirection]).trim();
    if (direction !== movement.direction) {
      throw new Error(`请将行为管理「${name}」(${kind}) 的库存方向设置为“${movement.direction}”`);
    }
    if (behavior.fields?.[fields.enabled] !== true) {
      throw new Error(`请启用行为管理中的「${name}」(${kind})`);
    }
    return { recordId: behavior.record_id, direction };
  }

  async resolveSamplePromotionBehavior() {
    const fields = this.gateway.table('behavior').fields;
    const matches = (await this.gateway.listAll('behavior')).filter((record) =>
      textValue(record.fields?.[fields.code]).trim() === BEHAVIOR_SAMPLE_PROMOTION);
    if (matches.length !== 1) {
      throw new Error(`行为管理中编码为「${BEHAVIOR_SAMPLE_PROMOTION}」的行为必须且只能有一条记录，请先在行为管理表补齐`);
    }
    const behavior = matches[0];
    const name = textValue(behavior.fields?.[fields.name]).trim() || BEHAVIOR_SAMPLE_PROMOTION;
    if (textValue(behavior.fields?.[fields.stockDirection]).trim() !== '不影响') {
      throw new Error(`请将行为管理「${name}」(${BEHAVIOR_SAMPLE_PROMOTION}) 的库存方向设置为“不影响”`);
    }
    if (behavior.fields?.[fields.enabled] !== true) {
      throw new Error(`请启用行为管理中的「${name}」(${BEHAVIOR_SAMPLE_PROMOTION})`);
    }
    return { recordId: behavior.record_id };
  }

  async validateStockBehaviors() {
    for (const kind of Object.keys(STOCK_MOVEMENTS)) await this.resolveStockBehavior(kind);
  }

  runForStock(stockKey, work) {
    const previous = this.queues.get(stockKey) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(stockKey, next);
    const cleanup = () => {
      if (this.queues.get(stockKey) === next) this.queues.delete(stockKey);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  /**
   * ⭐ 2026-10-13（验收提速 ①）：**一批一次写**要同时占住这一批涉及的每个 `stock_key` 的串行队列。
   *
   * 为什么不能只占一个：批量写会同时落多条记录，跨任务并发时"同一双鞋"的保护不能被绕过
   * （这正是 `runForStock` 存在的理由）。
   * ⚠️ **按 key 排序后依次占用** ⇒ 两批 key 有交集时也不会互相等待成环（有序加锁的常规做法）。
   * 单 key 的调用方（`applyChange` 等）看到的语义与改动前**逐字相同**。
   */
  runForStocks(stockKeys, work) {
    const keys = [...new Set((stockKeys || []).map((key) => String(key)))].sort();
    const acquireNext = (index) => {
      if (index >= keys.length) return work();
      return this.runForStock(keys[index], () => acquireNext(index + 1));
    };
    return acquireNext(0);
  }

  // ⚠️ 关联键走**尾部可选参数**（`options.correlation`），**不塞进 `input`**：
  //    库存引擎的业务入参形状因此一个字段都没变（既有测试对它是逐字 deepEqual 的，
  //    那条断言就是这条边界的证明）。关联键只进日志。
  applySale(input, options = {}) {
    return this.applyChange({
      ...input,
      kind: MOVEMENT_SALE_DECREASE,
      // A sale always consumes door-box stock first, then a sample. Callers
      // must not bypass that policy by choosing a source state themselves.
      state: '门盒',
      sourceRecordId: input.salesDetailRecordId,
      quantity: positiveInteger(input.quantity, '销售数量'),
    }, options);
  }

  async getSaleResult(salesDetailRecordId) {
    const operation = await this.store.get(operationId(MOVEMENT_SALE_DECREASE, salesDetailRecordId));
    return operation?.status === 'completed' ? operation.result : null;
  }

  /**
   * 采购到货 → 加库存（「库存流水」+「实时库存」）。
   *
   * 入参（业务身份，**全是真实标识**）：
   *   · `purchaseBatchRecordId` —— 「报货批次」那一行的 record_id（`draft.batch_record_id`）
   *   · `purchaseBatchNo`       —— 批次号（`draft.batch_no`，上面那个拿不到时的兜底）
   *   · `arrivalTaskId`         —— 到货核对任务 id（只在"孤儿调用"时兜底）
   *   · `productRecordId` / `size` / `quantity` / `state`
   *
   * ⚠️ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ **不再有 `purchaseInboundRecordId`**。
   *    来源标识改由 `purchaseIncreaseSourceId` 用**真实三元组**算（见它的注释）；
   *    它是**本地幂等键**，参与幂等/恢复的 `ledgerSource` 仍是 `null`。
   * ⭐ 2026-10-08 补刀：业务负责人把「库存流水.关联采购」改成了指向**「报货批次」**
   *    ⇒ 这条流水**多写一个**「关联采购」= `purchaseBatchRecordId`（走 `ledgerLink`，
   *      **只写不查**；拿不到就不写整列）。`purchaseBatchRecordId` 从此有**两个去处**：
   *      ① 参与本地三元组幂等键；② 作为远端关联值写进「关联采购」。两者互不替代。
   *
   * ⚠️ **`state` 是"看当前库存算出来的"（没有样品→样品，有→门盒）⇒ 重放时必然算得不一样**：
   *    第一次入库那一双样品已经把「实时库存」改了。所以重放**不能**拿重算的 state 去比对
   *    （`applyChange` 会抛「内容与首次提交不一致」——那是它的职责，别放宽它）。
   *    ⇒ 这里先按**来源标识**回查一次本地库存任务（`findOperationBySource`，与工作台
   *      「按实际盘点数」调库用的是同一条通路）：**有就用它自己记下的 state**（事实优先），
   *      没有才用调用方给的 / 默认值。这样"崩溃恢复重放"与"首次提交"走的是同一份 state。
   */
  async applyPurchase(input, options = {}) {
    const sourceRecordId = purchaseIncreaseSourceId(input);
    const existing = await this.findOperationBySource(sourceRecordId);
    return this.applyChange({
      ...input,
      kind: MOVEMENT_PURCHASE_INCREASE,
      state: existing?.state || input.state || '门盒',
      sourceRecordId,
      quantity: positiveInteger(input.quantity, '采购入库数量'),
    }, options);
  }

  /**
   * ⭐ 2026-10-11：**采购退货 → 扣库存**（扫码页退货那条链路唯一允许走的库存入口）。
   *
   * 它就是 `applyChange` 的一层**薄封装**（和 `applyPurchase` 对入库那样）：
   *   · `kind` = `MOVEMENT_PURCHASE_DECREASE`（**库存行为编码不在这里写死**，
   *     由注册表 `STOCK_MOVEMENTS` 决定扣哪些状态 —— 现存口径 = 门盒 + 样品 + 仓库）；
   *   · 来源标识 = 真实三元组（见 `purchaseReturnSourceId`）；
   *   · `state` 与 `applyPurchase` 同一条纪律：**先按来源回查本地任务**，重放时用它自己
   *     记下的那一份（否则重放会拿"重新算出来的 state"去比对，被 `applyChange`
   *     的"内容与首次提交不一致"当场拦下）。
   *
   * 🔴 **超库存由 `applyChange` 兜底**：现有数量 < 要退的数量 ⇒ **当场抛错**、
   *    一双都不动（绝不退成负数）。所以"退能退的"必须在**调用方**先把 `quantity`
   *    算成 `min(她说要退的, 现有)` —— 本方法不做业务判断、不夹取、不静默少扣。
   */
  async applyPurchaseReturn(input, options = {}) {
    const sourceRecordId = purchaseReturnSourceId(input);
    const existing = await this.findOperationBySource(sourceRecordId);
    return this.applyChange({
      ...input,
      kind: MOVEMENT_PURCHASE_DECREASE,
      state: existing?.state || input.state || '门盒',
      sourceRecordId,
      quantity: positiveInteger(input.quantity, '采购退货数量'),
    }, options);
  }

  async applyChange(input, options = {}) {
    if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
    if (!input.sourceRecordId) throw new Error('库存变化缺少来源明细 record_id');
    const size = normalizeSize(input.size);
    const quantity = positiveInteger(input.quantity, '变动数量');
    const state = String(input.state || '门盒');
    if (!LIVE_STATES.includes(state)) throw new Error('库存所属状态无效');
    const stockKey = `${input.productRecordId}|${size}|${state}`;
    // 配置驱动的闸门：状态类行为（方向=不影响，含转冻结/转释放门盒/两个"转"）不许走数量通路。
    // 放在任何远端读写之前，且不改变上面几条入参校验的报错顺序。
    requireQuantityMovement(input.kind);
    // 关联键：落进本地任务记录，**重放/续跑时用它自己的那一份**（不是当前请求的）——
    // 这正是为什么不走 AsyncLocalStorage：resumePending 会把上一笔单的操作放到这次请求里跑。
    const correlation = correlationFields(options.correlation);
    return this.runForStock(stockKey, async () => {
      await this.ensureSchema();
      const sizeReference = await this.sizeReferences.resolveByNumber(size);
      await this.resumePending(stockKey);
      const id = operationId(input.kind, input.sourceRecordId);
      let operation = await this.store.get(id);
      if (operation) {
        if ([2, 3].includes(operation.schema_version) && (
          operation.kind !== input.kind || operation.product_record_id !== input.productRecordId ||
          operation.size !== size || operation.state !== state || operation.quantity !== quantity
        )) throw new Error(`来源明细 ${input.sourceRecordId} 的库存操作内容与首次提交不一致`);
      } else {
        const movement = requireMovement(input.kind);
        const behavior = await this.resolveStockBehavior(input.kind);
        // 没有来源字段的动作（例如采购退货）拿不到"远端已经写过这条流水"的证明，
        // 只能靠本地任务日志恢复；见 STOCK_MOVEMENTS 里那条注释。
        const existingLedger = movement.ledgerSource
          ? await this.findLedger(movement.ledgerSource, input.sourceRecordId, behavior.recordId)
          : null;
        if (existingLedger) {
          throw new Error(`来源明细 ${input.sourceRecordId} 已有库存流水，但缺少可恢复任务，请人工核对实时库存`);
        }
        const delta = behavior.direction === '减少' ? -quantity : quantity;
        const allLiveRecords = await this.gateway.listAll('liveInventory');
        // 消耗哪些状态由注册表声明；增加方向不消耗既有记录，只看目标状态本身。
        const states = movement.consumes || [state];
        const liveRecords = states.flatMap((candidateState) =>
          this.findLiveInventoryIn(allLiveRecords, input.productRecordId, sizeReference.recordId, candidateState)
            .sort((left, right) => String(left.record_id).localeCompare(String(right.record_id))));
        const currentQuantity = liveRecords.length;
        if (delta < 0 && currentQuantity < quantity) {
          // 文案里的状态来自注册表（销售是"门盒和样品"，采购退货是"门盒、样品和仓库"），
          // 不再写死——写死的文案会在退货时告诉她"门盒和样品不足"，而仓库里其实有货。
          throw new Error(`${states.join('和')}库存不足：${input.productRecordId} ${size}码，需 ${quantity} 双，现有 ${currentQuantity} 双`);
        }
        const selected = delta < 0 ? liveRecords.slice(0, quantity) : [];
        const stateField = this.gateway.table('liveInventory').fields.state;
        const sampleConsumed = selected.filter((record) =>
          textValue(record.fields?.[stateField]) === '样品').length;
        const targetQuantity = currentQuantity + delta;
        operation = await this.store.create({
          operation_id: id,
          type: 'inventory_change',
          schema_version: 3,
          status: 'prepared',
          kind: input.kind,
          stock_key: stockKey,
          // 人类可读那串：抄**这次已经读到的**实时库存记录上的「库存键」（零额外请求）。
          // 减少方向抄的是**要扣掉的那一双**；增加方向（采购入库）抄同款同码已有的那一双。
          ...stockKeyLabelFields({
            // 增加、且这一款店里一双都没有（第一双新品）→ 两个都是 undefined → unavailable。
            record: selected[0] || liveRecords[0],
            fieldName: this.gateway.table('liveInventory').fields.stockKey,
            fallback: options.stockKeyLabel,
          }),
          ...correlationPatch(correlation),
          product_record_id: input.productRecordId,
          size,
          size_record_id: sizeReference.recordId,
          state,
          quantity,
          direction: behavior.direction,
          behavior_record_id: behavior.recordId,
          source_record_id: input.sourceRecordId,
          // ⭐ 2026-10-08：`ledgerLink` 那列要写的**远端关联值**也要落进本地任务
          //    （采购加库存 = 报货批次那一行的 record id）—— 流水只创建一次，
          //    崩溃后 `resumePending` 补写的那一次必须有得写，否则重放的那条会静默丢关联。
          //    ⚠️ 它**不是幂等判据**（幂等仍是 `source_record_id` + `operationId`），只是载荷。
          ...movementLedgerLinkPatch(movement, input),
          occurred_at: Number(input.occurredAt || Date.now()),
          // 谁做的这次调整（人工调整时由工作台传入飞书 open_id）。
          // ⚠️ 「库存流水」目前**没有「操作人」列**（2026-10-06 只读核过测试 Base：
          // 库存键/库存行为/编号/尺码/变动数量/关联销售/关联采购/创建时间/更新时间），
          // 所以只落**本地任务日志 + 结构化日志**，不往远端写；那两处已经能回答"谁调的"。
          // 等「库存流水」加了「操作人」列，在这里补一个 ledgerSource 同级的映射即可。
          operator_open_id: input.operatorOpenId || '',
          live_record_ids: selected.map((record) => record.record_id),
          sample_consumed_quantity: sampleConsumed,
          removed_live_record_ids: [],
          created_live_record_ids: [],
          current_quantity: currentQuantity,
          target_quantity: targetQuantity,
        });
      }
      return this.executeOperation(operation);
    });
  }

  async findOperationBySource(sourceRecordId) {
    const matches = (await this.store.list()).filter((record) => record.source_record_id === sourceRecordId);
    if (matches.length > 1) {
      throw new Error(`来源 ${sourceRecordId} 存在多条库存任务，请人工核对`);
    }
    return matches[0] || null;
  }

  async resumePending(stockKey) {
    const pending = (await this.store.list()).filter(
      (record) => ['inventory_change', 'sample_promotion', 'state_transition'].includes(record.type) &&
        record.stock_key === stockKey && record.status !== 'completed'
    );
    for (const operation of pending.reverse()) {
      if (operation.type === 'sample_promotion') await this.executeSamplePromotion(operation);
      else if (operation.type === 'state_transition') await this.executeStateTransition(operation);
      else await this.executeOperation(operation);
    }
  }
}

// ── facade：把 `inventory/**` 里的执行体挂回原型 ─────────────────────────────────
// 属性描述符与 class 方法一致（不可枚举 / 可写 / 可配置）；方法体仍用 `this.`，
// 所以"实例方法被替身 / 子类覆盖"的既有测试语义与拆分前相同。
for (const [name, method] of Object.entries({
  applySaleBatch,
  applyPurchaseBatch,
  applyPurchaseReturnBatch,
  executeOperation,
  transitionState,
  executeStateTransition,
  promoteToSample,
  executeSamplePromotion,
  assertNoDuplicateOperationItems,
  findOperationLedger,
  ledgerMatchesOperation,
  auditExistingOperationRecords,
  findLedger,
  findLiveInventoryIn,
  findLiveInventory,
  candidatesFromLiveRecords,
  sampleReplacementCandidates,
})) {
  Object.defineProperty(InventoryService.prototype, name, {
    value: method,
    writable: true,
    configurable: true,
  });
}

module.exports = {
  InventoryService,
  operationId,
  // 采购加库存的**来源标识**（= 本地幂等键）：导出它，好让测试 / 排查脚本
  // 用**同一个函数**算出"这一条该是哪个键"，而不是在别处再抄一份格式（抄了就会漂移）。
  purchaseIncreaseSourceId,
  // ⭐ 2026-10-11：采购退货的来源标识（= 本地幂等键）——同样导出，好让测试 / 排查脚本
  // 用**同一个函数**算键，而不是在别处再抄一份格式（抄了就会漂移）。
  purchaseReturnSourceId,
  STOCK_MOVEMENTS,
  ADJUSTMENT_BEHAVIORS,
  // 状态值域从这里导出，避免「实时库存」的状态清单在别处再抄一份（抄了就会漂移）。
  LIVE_STATES,
  MOVEMENT_PURCHASE_DECREASE,
  // 销售出库的行为编码。导出它只为让「库存真的动了」那条正向日志
  //（`sales.inventory.applied`）写**编码**，而不是在别的文件里再抄一份字面量。
  MOVEMENT_SALE_DECREASE,
  MOVEMENT_SALE_RETURN,
  MOVEMENT_SALE_COMPENSATION,
  MOVEMENT_SALE_CASH,
};
