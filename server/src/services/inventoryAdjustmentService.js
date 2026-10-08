/**
 * 人工库存调整 service —— 工作台「常用功能 → 库存手工调整」的后端入口。
 *
 * 只干两件事，一件对应一个子页：
 *   ① 盘点调整（改**数量**，可增可减）→ `adjustCount`
 *      · 行为 = STOCK_MANUAL_INCREASE / STOCK_MANUAL_DECREASE
 *      · 走 `InventoryService.applyChange`（数量通路，新建或删除「实时库存」记录）
 *   ② 换季调整（改**状态**，数量不变）→ `adjustSeason`
 *      · 行为 = STOCK_FREEZE（门盒/样品 → 仓库）/ STOCK_RELEASE_TO_DOOR_BOX（仓库 → 门盒/样品）
 *        ⚠️ 2026-10-08：业务负责人把原「转释放」（编码 STOCK_UNFREEZE）改成了
 *        「转释放门盒」（编码 STOCK_RELEASE_TO_DOOR_BOX），表里已无 STOCK_UNFREEZE。
 *        新名字字面像「仓库 → 门盒」，但本 service ⇄ inventoryService 的流转目标
 *        目前仍是「门盒 / 样品」二选一（`UNFREEZE_STATE_TRANSITION`）——
 *        **待她确认**是否收窄成只回门盒；确认前描述保留为「仓库 → 门盒/样品」。
 *      · 走 `InventoryService.transitionState`（状态通路，**不增删记录**）
 *
 * 为什么单独一个 service（而不是加到 InventoryService 里）：
 *   `InventoryService` 是**库存写入的唯一出口**，负责幂等、串行队列、账实核对；
 *   这一层只负责「界面的动作 → 行为编码 → 入参校验 → 幂等来源」。
 *   两者分开，将来入口换（飞书卡片 / 别的工作台）时下面那层一行不用动。
 *
 * 幂等（她 2026-10-06 明确：幂等要能用界面侧的 requestId）：
 *   库存操作的幂等键是 `operationId(kind, sourceRecordId)`（见 inventoryService）。
 *   人工调整没有"明细单"，所以 sourceRecordId 由入口给：
 *     `sourceRecordId = ${requestId}:${productRecordId}:${size}:${state}`
 *   · `requestId` 由**界面在提交时生成一次**，**重试复用同一个**（前端 pendingRequestId）；
 *   · 后面三段是目标身份 —— 一次提交里每个目标各不相同，所以同一批里不会互相顶掉；
 *   · 同一目标重试 → sourceRecordId 不变 → 命中同一条本地任务 → 不会重复加/减。
 */
const { ADJUSTMENT_BEHAVIORS, LIVE_STATES, STOCK_MOVEMENTS } = require('./inventoryService');
const {
  INVENTORY_ADJUSTMENT_MAX_TARGETS,
  INVENTORY_ADJUSTMENT_BATCH_CONCURRENCY,
} = require('../config/inventoryAdjustment');
const { logInfo } = require('../utils/logger');

// 界面动作 → 「行为管理」里的行为编码。
// 编码是契约（表里改中文名不影响这里），动作名是界面的语言。要换编码只改这张表。
const ADJUSTMENT_ACTIONS = Object.freeze({
  COUNT_INCREASE: 'count_increase',
  COUNT_DECREASE: 'count_decrease',
  SEASON_FREEZE: 'season_freeze',
  SEASON_RELEASE: 'season_release',
});

// 盘点调整的两种输入方式：
//   · counted = 她数出来「实际有几双」→ 代码算差额（盘多了加、盘少了减）；
//   · delta   = 她直接说「加几双 / 减几双」。
const COUNT_MODES = Object.freeze({ COUNTED: 'counted', DELTA: 'delta' });

// 换季调整的两个动作。释放回门盒还是样品由她选（见 inventoryService 的注释：
// 记录进了「仓库」以后，原来在哪就查不到了，只能靠她指定）。
const SEASON_ACTION_KIND = Object.freeze({
  [ADJUSTMENT_ACTIONS.SEASON_FREEZE]: ADJUSTMENT_BEHAVIORS.FREEZE,
  [ADJUSTMENT_ACTIONS.SEASON_RELEASE]: ADJUSTMENT_BEHAVIORS.UNFREEZE,
});

// 入参错误（她填错了）与系统错误（飞书/表出错）要分开：
// 前者回 400 并原样告诉她哪里填错了，后者回 5xx 且不回显内部细节。
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const requireText = (value, label) => {
  const text = String(value ?? '').trim();
  if (!text) throw userError(`${label}不能为空`);
  return text;
};

const requireState = (value, label) => {
  const state = requireText(value, label);
  if (!LIVE_STATES.includes(state)) {
    throw userError(`${label}只能是：${LIVE_STATES.join(' / ')}`);
  }
  return state;
};

const requireInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number)) throw userError(`${label}必须是整数`);
  return number;
};

// 一次提交里每个目标各自的幂等来源：requestId 由界面给，其余是目标身份。
const adjustmentSourceId = ({ requestId, productRecordId, size, state }) =>
  `${requestId}:${productRecordId}:${size}:${state}`;

const runWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

class InventoryAdjustmentService {
  constructor(options = {}) {
    if (!options.inventory) throw new Error('InventoryAdjustmentService requires inventory');
    this.inventory = options.inventory;
  }

  // ── ① 盘点调整（改数量，可增可减）────────────────────────────────────────
  async adjustCount({ productRecordId, size, state: rawState, mode, delta, countedQuantity,
    requestId, operatorOpenId } = {}) {
    const source = requireText(requestId, '请求编号');
    const product = requireText(productRecordId, '货号');
    const normalizedSize = requireInteger(size, '尺码');
    const state = requireState(rawState, '所属状态');
    const adjustMode = String(mode || COUNT_MODES.COUNTED);
    if (!Object.values(COUNT_MODES).includes(adjustMode)) {
      throw userError(`盘点方式只能是：${Object.values(COUNT_MODES).join(' / ')}`);
    }
    const sourceRecordId = adjustmentSourceId({ requestId: source, productRecordId: product,
      size: normalizedSize, state });
    // 幂等第一层：同一次提交重试 → 命中原来那条库存任务，直接回放结果。
    // 不能靠"重算差额"来判幂等：重试时账面已经变了，按实际盘点数算出来的差额会变成 0，
    // 反而报"不需要调整"（这正是这条回查要解决的问题）。
    const replay = await this.replayCompleted(sourceRecordId, { product, size: normalizedSize, state, mode: adjustMode });
    if (replay) return replay;
    // 「账面现有几双」= 该货号 + 尺码 + 所属状态下的实时库存**记录条数**（一双一条）。
    const current = (await this.inventory.findLiveInventory(product, normalizedSize, state)).length;
    let movement = 0;
    if (adjustMode === COUNT_MODES.COUNTED) {
      const counted = requireInteger(countedQuantity, '实际盘点数');
      if (counted < 0) throw userError('实际盘点数不能是负数');
      movement = counted - current;
      if (movement === 0) throw userError(`账面已经是 ${current} 双，与实际盘点数一致，不需要调整`);
    } else {
      movement = requireInteger(delta, '增减数量');
      if (movement === 0) throw userError('增减数量不能为 0');
    }
    const increase = movement > 0;
    const action = increase ? ADJUSTMENT_ACTIONS.COUNT_INCREASE : ADJUSTMENT_ACTIONS.COUNT_DECREASE;
    const kind = increase ? ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE : ADJUSTMENT_BEHAVIORS.MANUAL_DECREASE;
    const quantity = Math.abs(movement);
    const result = await this.inventory.applyChange({
      kind,
      productRecordId: product,
      size: normalizedSize,
      state,
      quantity,
      sourceRecordId,
      operatorOpenId,
    });
    logInfo('inventory.adjustment.count.applied', {
      request_id: source,
      operation_kind: kind,
      product_record_id: product,
      size: normalizedSize,
      state,
      before_quantity: current,
      delta: movement,
      after_quantity: result.quantity,
      ledger_record_id: result.ledgerRecordId,
      operator_open_id: operatorOpenId || undefined,
    });
    return {
      action,
      product_record_id: product,
      size: normalizedSize,
      state,
      mode: adjustMode,
      before_quantity: current,
      delta: movement,
      after_quantity: result.quantity,
      ledger_record_id: result.ledgerRecordId,
      live_record_ids: result.liveRecordIds,
    };
  }

  // 同一来源已经成功过 → 原样回放那条结果（同一次提交重试的唯一正确语义）。
  // 只回放**已完成**的任务；还在跑/需要人工核对的不算成功，照常按新提交走
  //（后续 applyChange 会命中同一条任务，由库存引擎决定是续跑还是转人工）。
  async replayCompleted(sourceRecordId, { product, size, state, mode }) {
    const operation = await this.inventory.findOperationBySource(sourceRecordId);
    if (!operation || operation.status !== 'completed' || !operation.result) return null;
    const movement = operation.result.direction === '减少'
      ? -operation.result.movementQuantity : operation.result.movementQuantity;
    const after = operation.result.quantity;
    logInfo('inventory.adjustment.count.replayed', {
      request_id: sourceRecordId, operation_id: operation.operation_id, operation_kind: operation.kind,
    });
    return {
      action: movement > 0 ? ADJUSTMENT_ACTIONS.COUNT_INCREASE : ADJUSTMENT_ACTIONS.COUNT_DECREASE,
      product_record_id: product,
      size,
      state,
      mode,
      before_quantity: after - movement,
      delta: movement,
      after_quantity: after,
      ledger_record_id: operation.result.ledgerRecordId,
      live_record_ids: operation.result.liveRecordIds || [],
      replayed: true,
    };
  }

  // ── ② 换季调整（改状态，数量不变）────────────────────────────────────────
  // targets: [{ productRecordId, size, state(起点), quantity }]
  // 转释放门盒时要传 toState（回门盒还是样品，由她选）。
  async adjustSeason({ action, targets, toState, requestId, operatorOpenId } = {}) {
    const source = requireText(requestId, '请求编号');
    const adjustAction = requireText(action, '调整动作');
    const kind = SEASON_ACTION_KIND[adjustAction];
    if (!kind) throw userError(`换季调整动作只能是：${Object.values(ADJUSTMENT_ACTIONS).filter((item) => SEASON_ACTION_KIND[item]).join(' / ')}`);
    if (!Array.isArray(targets) || !targets.length) throw userError('请先选择要调整的鞋');
    if (targets.length > INVENTORY_ADJUSTMENT_MAX_TARGETS) {
      throw userError(`一次最多调整 ${INVENTORY_ADJUSTMENT_MAX_TARGETS} 条，请分批提交`);
    }
    // 「转释放门盒」回到门盒还是样品**必须由她选**（记录进了「仓库」后原来在哪就查不到了）。
    // 在这一层先校验：否则同一个错误会变成"每一条都失败"，她看到一堆重复的报错。
    const transition = STOCK_MOVEMENTS[kind].stateTransition;
    let targetState = toState;
    if (transition && !transition.to) {
      targetState = requireText(toState, '释放回哪里');
      if (!transition.targets.includes(targetState)) {
        throw userError(`释放回哪里只能是：${transition.targets.join(' / ')}`);
      }
    }
    const normalized = targets.map((target) => ({
      productRecordId: requireText(target?.productRecordId, '货号'),
      size: requireInteger(target?.size, '尺码'),
      state: requireState(target?.state, '所属状态'),
      quantity: target?.quantity === undefined ? 1 : requireInteger(target.quantity, '数量'),
    }));
    normalized.forEach((target, index) => {
      if (target.quantity <= 0) throw userError(`第 ${index + 1} 条的调整数量必须大于 0`);
    });
    const keys = normalized.map((target) => `${target.productRecordId}|${target.size}|${target.state}`);
    if (new Set(keys).size !== keys.length) {
      throw userError('同一批里有重复的「货号 + 尺码 + 所属状态」，请合并后再提交');
    }
    const results = await runWithConcurrency(normalized, INVENTORY_ADJUSTMENT_BATCH_CONCURRENCY,
      async (target) => {
        try {
          const result = await this.inventory.transitionState({
            kind,
            productRecordId: target.productRecordId,
            size: target.size,
            fromState: target.state,
            toState: targetState,
            quantity: target.quantity,
            sourceRecordId: adjustmentSourceId({ requestId: source, productRecordId: target.productRecordId,
              size: target.size, state: target.state }),
            operatorOpenId,
          });
          return { ...target, ok: true, ...result };
        } catch (error) {
          // 单个目标失败（例如"仓库里只有 2 双、她要拿出 3 双"）不拖垮整批：
          // 逐条报给她，成功的那些照常生效（与销售交付的 failures 形状一致）。
          return { ...target, ok: false, error: error.message };
        }
      });
    const failures = results.filter((item) => !item.ok);
    const succeeded = results.filter((item) => item.ok);
    for (const item of succeeded) {
      logInfo('inventory.adjustment.season.applied', {
        request_id: source,
        operation_kind: kind,
        product_record_id: item.productRecordId,
        size: item.size,
        from_state: item.fromState,
        to_state: item.toState,
        quantity: item.quantity,
        ledger_record_id: item.ledgerRecordId,
        operator_open_id: operatorOpenId || undefined,
      });
    }
    return {
      action: adjustAction,
      to_state: succeeded[0]?.toState || String(targetState || ''),
      total: results.length,
      succeeded: succeeded.length,
      failed: failures.length,
      results,
      failures: failures.map((item) => ({ product_record_id: item.productRecordId, size: item.size,
        state: item.state, quantity: item.quantity, error: item.error })),
    };
  }
}

module.exports = {
  InventoryAdjustmentService,
  ADJUSTMENT_ACTIONS,
  COUNT_MODES,
  adjustmentSourceId,
};
