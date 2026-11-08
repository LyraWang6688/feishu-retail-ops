// 库存操作键统一配置化（issue #961）—— golden / 单元测试。
//
// 验收标准（先写预期，再对照跑）：
//   AC-K1 每个行为都在 `STOCK_MOVEMENTS[行为].operationKey` 里声明了来源身份；
//   AC-K2 统一入口生成的 `sourceRecordId` / `operationId` / `operationItemKey` 与**改前逐字一致**
//         （改前的拼法 = 本文件顶部冻结的 `LEGACY` 参照实现；两边独立写，不是互相调用）；
//   AC-K3 缺字段时按配置抛**明确错误**，绝不编 id；
//   AC-K4 配置闸门：行为漏声明 / 声明不完整 ⇒ 部署闸门能红；
//   AC-K5 新增行为只改配置 + 行为表，不改写入件：写入件里不再有 per-behavior 的来源拼法；
//   AC-K6 历史撞键不再产生：同一批次的**不同尺码**必须得到不同的操作键（perItem）。
//
// ⚠️ 本文件是**纯单元测试**：不连飞书、不写任何表；只读源码做哨兵 + 纯函数比对。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  operationId,
  operationSourceIdOf,
  operationIdOf,
  operationItemKeyOf,
  operationKeySpecOf,
  validateOperationKeyConfigs,
  purchaseIncreaseSourceId,
  purchaseReturnSourceId,
  samplePromotionId,
  SAMPLE_PROMOTION_OPERATION,
} = require('../src/services/inventory/keys');
const {
  STOCK_MOVEMENTS,
  MOVEMENT_SALE_DECREASE,
  MOVEMENT_PURCHASE_INCREASE,
  MOVEMENT_PURCHASE_DECREASE,
  MOVEMENT_SALE_RETURN,
  MOVEMENT_SALE_COMPENSATION,
  MOVEMENT_SALE_CASH,
  MOVEMENT_SALE_INCREASE,
  BEHAVIOR_SAMPLE_PROMOTION,
  ADJUSTMENT_BEHAVIORS,
} = require('../src/services/inventory/movements');
const { normalizeSize } = require('../src/services/sizeReferenceService');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const readSource = (...segments) => fs.readFileSync(path.join(SERVER_SRC, ...segments), 'utf8');

// ── 改前参照实现（**照抄 2026-11-08 重构前的源码**，独立于新入口，用来做 golden 对照）──
//    ⚠️ 这里**故意**重复写一遍旧拼法：如果它改成调用新入口，"逐字一致"就成了自证循环。
const LEGACY = Object.freeze({
  // keys.js（改前 89-98 行）
  purchaseIncreaseSourceId: (input) => {
    const identity = String(
      input.purchaseBatchRecordId || input.purchaseBatchNo || input.arrivalTaskId || '',
    ).trim();
    if (!identity) {
      throw new Error('采购入库缺少来源标识（批次记录 id / 批次号 / 到货核对任务 id 至少要有一个）');
    }
    if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
    return `purchase_increase:${identity}|${input.productRecordId}|${normalizeSize(input.size)}`;
  },
  // keys.js（改前 112-121 行）
  purchaseReturnSourceId: (input) => {
    const identity = String(
      input.purchaseBatchRecordId || input.purchaseBatchNo || input.returnTaskId || '',
    ).trim();
    if (!identity) {
      throw new Error('采购退货缺少来源标识（批次记录 id / 批次号 / 退货任务 id 至少要有一个）');
    }
    if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
    return `purchase_return:${identity}|${input.productRecordId}|${normalizeSize(input.size)}`;
  },
  // keys.js（改前 72 行）：补样品的 operationId 前缀是 'sample'
  samplePromotionId: (salesDetailRecordId) => operationId('sample', salesDetailRecordId),
  // inventoryAdjustmentService.js（改前 83-84 行）
  adjustmentSourceId: ({ requestId, productRecordId, size, state }) =>
    `${requestId}:${productRecordId}:${size}:${state}`,
  // stateTransition 改前由入口拼：`${requestId}:${productRecordId}:${size}:${fromState}`
  // （旧入口传给 adjustmentSourceId 的 `state` 就是目标那一行的起点状态）。
  stateTransitionSourceId: ({ requestId, productRecordId, size, fromState }) =>
    `${requestId}:${productRecordId}:${size}:${fromState}`,
});

// ── AC-K1 + AC-K2：每个行为的 golden 对照表 ─────────────────────────────────────
// 每一行 = 「同一份输入 ⇒ 改前 / 改后逐字相同的 sourceRecordId + operationId + itemKey」。
const GOLDEN_CASES = [
  {
    label: '销售交付扣减（销售明细 record_id）',
    code: MOVEMENT_SALE_DECREASE,
    input: { salesDetailRecordId: 'detail_1', productRecordId: 'product_1', size: 38 },
    legacySource: (input) => String(input.salesDetailRecordId || '').trim(),
  },
  {
    label: '采购入库增加（真实三元组：批次记录 id ｜ 货品 ｜ 尺码）',
    code: MOVEMENT_PURCHASE_INCREASE,
    input: { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size: 38 },
    legacySource: LEGACY.purchaseIncreaseSourceId,
  },
  {
    label: '采购入库增加（批次记录 id 拿不到 → 批次号兜底）',
    code: MOVEMENT_PURCHASE_INCREASE,
    input: { purchaseBatchNo: 'CGD-20261108-0001', productRecordId: 'product_1', size: 41 },
    legacySource: LEGACY.purchaseIncreaseSourceId,
  },
  {
    label: '采购入库增加（孤儿调用 → 到货核对任务 id 兜底）',
    code: MOVEMENT_PURCHASE_INCREASE,
    input: { arrivalTaskId: 'arrival_reconcile_1', productRecordId: 'product_1', size: '42' },
    legacySource: LEGACY.purchaseIncreaseSourceId,
  },
  {
    label: '采购退货减少（真实三元组：批次记录 id ｜ 货品 ｜ 尺码）',
    code: MOVEMENT_PURCHASE_DECREASE,
    input: { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size: 38 },
    legacySource: LEGACY.purchaseReturnSourceId,
  },
  {
    label: '采购退货减少（批次号 → 退货任务 id 兜底）',
    code: MOVEMENT_PURCHASE_DECREASE,
    input: { returnTaskId: 'purchase_return_task_1', productRecordId: 'product_1', size: 40 },
    legacySource: LEGACY.purchaseReturnSourceId,
  },
  {
    label: '售后销售增加（销售明细 record_id）',
    code: MOVEMENT_SALE_INCREASE,
    input: { sourceRecordId: 'detail_return_1', productRecordId: 'product_1', size: 38 },
    legacySource: (input) => String(input.sourceRecordId).trim(),
  },
  {
    label: '售后退货 / 赔货 / 换货（SALE_RETURN）',
    code: MOVEMENT_SALE_RETURN,
    input: { sourceRecordId: 'detail_return_2', productRecordId: 'product_1', size: 38 },
    legacySource: (input) => String(input.sourceRecordId).trim(),
  },
  {
    label: '售后退货 / 赔货 / 换货（SALE_COMPENSATION）',
    code: MOVEMENT_SALE_COMPENSATION,
    input: { sourceRecordId: 'detail_comp_1', productRecordId: 'product_1', size: 39 },
    legacySource: (input) => String(input.sourceRecordId).trim(),
  },
  {
    label: '售后退货 / 赔货 / 换货（SALE_CASH）',
    code: MOVEMENT_SALE_CASH,
    input: { sourceRecordId: 'detail_cash_1', productRecordId: 'product_1', size: 40 },
    legacySource: (input) => String(input.sourceRecordId).trim(),
  },
  {
    label: '人工调增（盘点调整：requestId + 目标身份）',
    code: ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE,
    input: { requestId: 'req-1', productRecordId: 'product_1', size: 38, state: '门盒' },
    legacySource: LEGACY.adjustmentSourceId,
  },
  {
    label: '人工调减（盘点调整：requestId + 目标身份）',
    code: ADJUSTMENT_BEHAVIORS.MANUAL_DECREASE,
    input: { requestId: 'req-2', productRecordId: 'product_1', size: 38, state: '仓库' },
    legacySource: LEGACY.adjustmentSourceId,
  },
  {
    label: '人工转冻结（状态类：requestId + 起点状态）',
    code: ADJUSTMENT_BEHAVIORS.FREEZE,
    input: { requestId: 'req-3', productRecordId: 'product_1', size: 40, fromState: '门盒' },
    legacySource: LEGACY.stateTransitionSourceId,
  },
  {
    label: '人工转释放门盒（状态类：requestId + 起点状态）',
    code: ADJUSTMENT_BEHAVIORS.UNFREEZE,
    input: { requestId: 'req-4', productRecordId: 'product_1', size: 41, fromState: '仓库' },
    legacySource: LEGACY.stateTransitionSourceId,
  },
  {
    label: '样品转门盒（状态类：requestId + 起点状态）',
    code: ADJUSTMENT_BEHAVIORS.SAMPLE_TO_DOORBOX,
    input: { requestId: 'req-5', productRecordId: 'product_1', size: 42, fromState: '样品' },
    legacySource: LEGACY.stateTransitionSourceId,
  },
  {
    // ⚠️ 同一个行为有两条通路：状态变更通路的 kind = 行为编码（这里验），
    //    补样品通路的 kind = 'sample'（见下面单独的 golden 用例）。
    label: '门盒转样品（状态变更通路）',
    code: ADJUSTMENT_BEHAVIORS.DOORBOX_TO_SAMPLE,
    input: { requestId: 'req-6', productRecordId: 'product_1', size: 43, fromState: '门盒' },
    legacySource: LEGACY.stateTransitionSourceId,
  },
];

test('AC-K1 每个行为都声明了 operationKey（新增行为漏声明会被部署闸门拦红）', () => {
  const codes = Object.keys(STOCK_MOVEMENTS);
  const covered = [...new Set(GOLDEN_CASES.map((entry) => entry.code))];
  assert.deepEqual([...covered].sort(), [...codes].sort(),
    `golden 表要覆盖注册表里**每一个**行为（未覆盖：${codes.filter((code) => !covered.includes(code)).join(' / ')}）`);
  for (const code of codes) {
    const spec = STOCK_MOVEMENTS[code].operationKey;
    assert.ok(spec, `行为「${code}」缺少 operationKey 声明`);
    assert.equal(typeof spec.kind, 'string');
    assert.ok(Array.isArray(spec.sourceFields) && spec.sourceFields.length > 0,
      `行为「${code}」的 sourceFields 必须是非空数组`);
    assert.equal(typeof spec.perItem, 'boolean', `行为「${code}」的 perItem 必须是显式布尔`);
    assert.match(spec.missingMessage, /缺少|必须/, `行为「${code}」的 missingMessage 要能看懂`);
  }
  // 补样品是同一行为（门盒转样品）的另一条通路，单独声明在 operations.sample_promotion。
  const promotionKey = operationKeySpecOf(STOCK_MOVEMENTS[BEHAVIOR_SAMPLE_PROMOTION], SAMPLE_PROMOTION_OPERATION);
  assert.equal(promotionKey.kind, 'sample', '补样品通路的 operationId 前缀仍是历史值 sample（不许改）');
});

test('AC-K2 统一入口逐字复现改前 sourceRecordId / operationId / operationItemKey（每个行为）', () => {
  for (const entry of GOLDEN_CASES) {
    const movement = STOCK_MOVEMENTS[entry.code];
    const legacySource = entry.legacySource(entry.input);
    const spec = movement.operationKey;
    // ① 来源身份逐字一致
    assert.equal(operationSourceIdOf(movement, entry.input), legacySource,
      `${entry.label}：sourceRecordId 与改前不一致`);
    // ② operationId 逐字一致（kind 用改前传给 operationId() 的那个前缀）
    assert.equal(operationIdOf(movement, entry.input), operationId(spec.kind, legacySource),
      `${entry.label}：operationId 与改前不一致`);
    // ③ 每双的「库存操作键」逐字一致（第 1..3 双）
    for (const sequence of [1, 2, 3]) {
      assert.equal(operationItemKeyOf(movement, entry.input, sequence),
        `${operationId(spec.kind, legacySource)}:${sequence}`,
        `${entry.label}：第 ${sequence} 双的库存操作键与改前不一致`);
    }
  }
});

test('AC-K2 补样品通路：operationId 仍逐字等于历史 `operationId(\'sample\', 明细 id)`', () => {
  const movement = STOCK_MOVEMENTS[BEHAVIOR_SAMPLE_PROMOTION];
  for (const salesDetailRecordId of ['detail_1', 'recAbCdEf123456', 'detail_售后退货']) {
    const input = { salesDetailRecordId, productRecordId: 'product_1', size: 38 };
    assert.equal(
      operationIdOf(movement, input, SAMPLE_PROMOTION_OPERATION),
      LEGACY.samplePromotionId(salesDetailRecordId),
      '补样品的操作键与改前不一致（改前缀会认不出历史本地任务 / 库存流水）',
    );
    assert.equal(samplePromotionId(salesDetailRecordId), LEGACY.samplePromotionId(salesDetailRecordId),
      'deprecated 的 samplePromotionId 必须仍与历史输出逐字一致');
  }
});

test('AC-K2 deprecated 旧函数内部只调统一入口（行为只有一套，不是两套实现）', () => {
  const increaseInput = { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size: 38 };
  const returnInput = { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size: 38 };
  assert.equal(purchaseIncreaseSourceId(increaseInput),
    operationSourceIdOf(STOCK_MOVEMENTS[MOVEMENT_PURCHASE_INCREASE], increaseInput));
  assert.equal(purchaseReturnSourceId(returnInput),
    operationSourceIdOf(STOCK_MOVEMENTS[MOVEMENT_PURCHASE_DECREASE], returnInput));
  // 与冻结的旧实现再对一次（防"两边一起改错"）
  assert.equal(purchaseIncreaseSourceId(increaseInput), LEGACY.purchaseIncreaseSourceId(increaseInput));
  assert.equal(purchaseReturnSourceId(returnInput), LEGACY.purchaseReturnSourceId(returnInput));
});

test('AC-K2 人工盘点调整两条行为（增 / 减）的来源形状必须一致（幂等回查先于差额判定）', () => {
  // `adjustCount` 在算出差额之前就要按来源回查本地任务（重试语义），而那时还不知道走增还是减
  // ⇒ 两套声明的**来源**必须逐字相同；这里钉住（否则重试会算出两个不同的来源、重复加/减）。
  const input = { requestId: 'req-9', productRecordId: 'product_1', size: 38, state: '门盒' };
  assert.equal(
    operationSourceIdOf(STOCK_MOVEMENTS[ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE], input),
    operationSourceIdOf(STOCK_MOVEMENTS[ADJUSTMENT_BEHAVIORS.MANUAL_DECREASE], input),
  );
  // operationId 仍然按各自 kind 分开（增 / 减是两条不同的库存事实）
  assert.notEqual(
    operationIdOf(STOCK_MOVEMENTS[ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE], input),
    operationIdOf(STOCK_MOVEMENTS[ADJUSTMENT_BEHAVIORS.MANUAL_DECREASE], input),
  );
});

test('AC-K2 尺码写法归一：38 与 \'38\' 得到同一把键（与改前 normalizeSize 一致）', () => {
  const movement = STOCK_MOVEMENTS[MOVEMENT_PURCHASE_INCREASE];
  const base = { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1' };
  assert.equal(operationIdOf(movement, { ...base, size: 38 }),
    operationIdOf(movement, { ...base, size: '38' }));
  assert.equal(operationSourceIdOf(movement, { ...base, size: ' 38 ' }), 'purchase_increase:batch_1|product_1|38');
});

// ── AC-K3：缺字段必须按配置抛明确错误，绝不编 id ─────────────────────────────────
const MISSING_CASES = [
  {
    label: '采购入库缺全部批次身份',
    code: MOVEMENT_PURCHASE_INCREASE,
    input: { productRecordId: 'product_1', size: 38 },
    message: /采购入库缺少来源标识/,
  },
  {
    label: '采购入库缺货品 record_id',
    code: MOVEMENT_PURCHASE_INCREASE,
    input: { purchaseBatchRecordId: 'batch_1', size: 38 },
    message: /库存变化缺少商品 record_id/,
  },
  {
    label: '采购退货缺全部批次身份',
    code: MOVEMENT_PURCHASE_DECREASE,
    input: { productRecordId: 'product_1', size: 38 },
    message: /采购退货缺少来源标识/,
  },
  {
    label: '采购退货缺货品 record_id',
    code: MOVEMENT_PURCHASE_DECREASE,
    input: { purchaseBatchRecordId: 'batch_1', size: 38 },
    message: /库存变化缺少商品 record_id/,
  },
  {
    label: '销售交付缺销售明细 record_id',
    code: MOVEMENT_SALE_DECREASE,
    input: { productRecordId: 'product_1', size: 38 },
    message: /库存变化缺少来源明细 record_id/,
  },
  {
    label: '售后缺 sourceRecordId',
    code: MOVEMENT_SALE_RETURN,
    input: { productRecordId: 'product_1', size: 38 },
    message: /库存变化缺少来源明细 record_id/,
  },
  {
    label: '人工调增缺请求编号',
    code: ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE,
    input: { productRecordId: 'product_1', size: 38, state: '门盒' },
    message: /人工库存调整缺少来源标识/,
  },
  {
    label: '人工转冻结缺请求编号',
    code: ADJUSTMENT_BEHAVIORS.FREEZE,
    input: { productRecordId: 'product_1', size: 38, fromState: '门盒' },
    message: /库存状态变更缺少来源标识（requestId）/,
  },
];

test('AC-K3 缺字段按配置抛明确错误（绝不编 id / 绝不静默生成空来源）', () => {
  for (const entry of MISSING_CASES) {
    const movement = STOCK_MOVEMENTS[entry.code];
    assert.throws(() => operationSourceIdOf(movement, entry.input), entry.message,
      `${entry.label}：必须抛配置好的明确错误`);
    assert.throws(() => operationIdOf(movement, entry.input), entry.message,
      `${entry.label}：operationId 也不许在缺字段时生成`);
    // 空串 / 空白 / null 都算缺（trim 后为空）
    assert.throws(() => operationSourceIdOf(movement, { ...entry.input, requestId: '   ' }), entry.message);
    assert.throws(() => operationSourceIdOf(movement, { ...entry.input, sourceRecordId: null }), entry.message);
  }
});

test('AC-K3 补样品缺销售明细：按配置抛「补样品缺少销售明细或货品」', () => {
  const movement = STOCK_MOVEMENTS[BEHAVIOR_SAMPLE_PROMOTION];
  assert.throws(() => operationIdOf(movement, { productRecordId: 'product_1', size: 38 }, SAMPLE_PROMOTION_OPERATION),
    /补样品缺少销售明细或货品/);
});

test('AC-K3 尺码非法时仍抛改前那句「尺码必须是正整数」（不吞成"缺字段"）', () => {
  const movement = STOCK_MOVEMENTS[MOVEMENT_PURCHASE_INCREASE];
  for (const size of [undefined, null, '', 0, 'abc', 2.5, -1]) {
    assert.throws(
      () => operationSourceIdOf(movement, { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size }),
      /尺码必须是正整数/,
      `尺码 ${String(size)} 应抛「尺码必须是正整数」`,
    );
  }
});

test('AC-K3 未声明的行为通路明确报错（不静默退回默认前缀）', () => {
  const movement = STOCK_MOVEMENTS[MOVEMENT_SALE_DECREASE];
  assert.throws(() => operationIdOf(movement, { salesDetailRecordId: 'detail_1' }, 'sample_promotion'),
    /没有声明「sample_promotion」通路的操作键/);
});

// ── AC-K4：配置闸门 ──────────────────────────────────────────────────────────
test('AC-K4 现有注册表通过配置校验（部署闸门 `v1:schema-check:all` 会调它）', () => {
  assert.equal(validateOperationKeyConfigs(STOCK_MOVEMENTS), Object.keys(STOCK_MOVEMENTS).length);
});

test('AC-K4 行为漏声明 operationKey ⇒ 红（新增行为只改配置 + 行为表的兜底判据）', () => {
  assert.throws(() => validateOperationKeyConfigs({ NEW_BEHAVIOR: { direction: '增加' } }),
    /库存动作「NEW_BEHAVIOR」 缺失 operationKey/);
  assert.throws(() => validateOperationKeyConfigs({}),
    /库存动作注册表为空/);
});

test('AC-K4 声明不完整 ⇒ 红（缺字段 / perItem 漏尺码 / 缺 missingMessage 等逐条拦）', () => {
  const base = {
    kind: 'NEW_BEHAVIOR',
    sourceFields: ['productRecordId', 'size'],
    separator: '|',
    perItem: true,
    missingMessage: '新增行为缺少来源标识',
  };
  // 基线本身是合法的
  assert.doesNotThrow(() => validateOperationKeyConfigs({ NEW_BEHAVIOR: { operationKey: base } }));
  const broken = [
    [{ ...base, kind: '' }, /缺少 kind/],
    [{ ...base, sourceFields: [] }, /sourceFields 必须是非空数组/],
    [{ ...base, sourceFields: ['productRecordId', 'productRecordId'] }, /有重复字段/],
    [{ ...base, sourceFields: ['purchaseBatchRecordId', 'productRecordId'] }, /perItem=true 时必须把 productRecordId 与 size/],
    [{ ...base, separator: '' }, /多字段来源必须声明 separator/],
    [{ ...base, perItem: 'true' }, /perItem 必须是显式布尔/],
    [{ ...base, missingMessage: '' }, /缺少 missingMessage/],
    [{ ...base, fieldMessages: { batchNo: 'x' } }, /fieldMessages 指向了不在 sourceFields 里的「batchNo」/],
    [{ ...base, operations: { sample_promotion: {} } }, /sample_promotion\] 的 operationKey 缺少 kind/],
  ];
  for (const [spec, pattern] of broken) {
    assert.throws(() => validateOperationKeyConfigs({ NEW_BEHAVIOR: { operationKey: spec } }), pattern);
  }
});

test('AC-K4 部署闸门真的调了配置校验（`validateStockBehaviors` 源码哨兵）', () => {
  const source = readSource('services', 'inventoryService.js');
  assert.match(source, /validateOperationKeyConfigs\(STOCK_MOVEMENTS\)/,
    'validateStockBehaviors 必须先调静态配置校验，否则"漏声明"要等运行时才炸');
});

// ── AC-K5：新增行为只改配置 + 行为表，不改写入件 ───────────────────────────────
test('AC-K5 写入件里不再有 per-behavior 的来源拼法（只有统一入口 + deprecated 包装）', () => {
  const writerFiles = [
    ['services', 'inventoryService.js'],
    ['services', 'inventory', 'purchaseBatch.js'],
    ['services', 'inventory', 'purchaseReturnBatch.js'],
    ['services', 'inventory', 'saleBatch.js'],
    ['services', 'inventory', 'stateTransition.js'],
    ['services', 'inventory', 'samplePromotion.js'],
    ['services', 'inventoryAdjustmentService.js'],
  ];
  // ① 来源**组成字面量**一个都不许留在写入件里（拼法只声明在行为注册表）
  const forbiddenLiterals = [
    /purchase_increase:/,
    /purchase_return:/,
    /\$\{requestId\}:\$\{productRecordId\}/,
  ];
  for (const segments of writerFiles) {
    const source = readSource(...segments);
    for (const pattern of forbiddenLiterals) {
      assert.equal(pattern.test(source), false,
        `${segments.join('/')} 里还在自己拼来源标识（${pattern}）：新增行为只该改配置 + 行为表`);
    }
  }
  // ② deprecated 的旧函数**不许被调用**（只在 keys.js 里定义、facade 里原样导出）
  for (const segments of writerFiles) {
    const source = readSource(...segments);
    for (const name of ['purchaseIncreaseSourceId', 'purchaseReturnSourceId', 'samplePromotionId']) {
      assert.equal(new RegExp(`${name}\\s*\\(`).test(source), false,
        `${segments.join('/')} 仍在调用 deprecated 的 ${name}：写入件只该走统一入口`);
    }
  }
  // ③ 人工调整那条 deprecated 包装内部**只调统一入口**（不许自己拼 `${requestId}:...`）
  const adjustmentSource = readSource('services', 'inventoryAdjustmentService.js');
  assert.match(adjustmentSource, /const adjustmentSourceId = [\s\S]{0,240}operationSourceIdOf/,
    'adjustmentSourceId 必须委托统一入口（保留只为兼容，行为只有一套）');
  // ④ 来源拼法**只**声明在行为注册表里（keys.js 是纯工具，不该出现具体前缀）
  const keysSource = readSource('services', 'inventory', 'keys.js');
  assert.equal(/purchase_increase:/.test(keysSource), false, 'keys.js 不该写死采购入库的来源前缀');
  assert.equal(/purchase_return:/.test(keysSource), false, 'keys.js 不该写死采购退货的来源前缀');
  const movementsSource = readSource('services', 'inventory', 'movements.js');
  assert.match(movementsSource, /sourcePrefix: 'purchase_increase'/);
  assert.match(movementsSource, /sourcePrefix: 'purchase_return'/);
});

test('AC-K5 deprecated 旧函数只从 keys.js 导出，src 里没有第二份实现', () => {
  const keysSource = readSource('services', 'inventory', 'keys.js');
  assert.match(keysSource, /@deprecated/);
  const allSources = [
    ['services', 'inventoryService.js'],
    ['services', 'inventory', 'purchaseBatch.js'],
    ['services', 'inventory', 'saleBatch.js'],
    ['services', 'inventory', 'purchaseReturnBatch.js'],
    ['services', 'inventory', 'samplePromotion.js'],
  ].map((segments) => readSource(...segments)).join('\n');
  // 写入件 import 都不 import 了（只有 deprecated 包装的内部实现调统一入口）
  assert.equal(/require\('\.\/keys'\)[\s\S]{0,400}purchaseIncreaseSourceId/.test(allSources), false);
});

// ── AC-K6：历史撞键不再产生 ─────────────────────────────────────────────────────
test('AC-K6 同一批次不同尺码得到不同的操作键（历史撞键事故不再产生）', () => {
  const movement = STOCK_MOVEMENTS[MOVEMENT_PURCHASE_INCREASE];
  const keys = [38, 39, 40, 41].map((size) => operationItemKeyOf(movement,
    { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size }, 1));
  assert.equal(new Set(keys).size, keys.length, '不同尺码共用同一把键 = 历史撞键事故的形状');
  // 同批次、不同货品同样要分开
  const productKeys = ['product_1', 'product_2'].map((productRecordId) => operationItemKeyOf(movement,
    { purchaseBatchRecordId: 'batch_1', productRecordId, size: 38 }, 1));
  assert.notEqual(productKeys[0], productKeys[1]);
  // 同一输入重复生成必须稳定（重试命中同一把键）
  assert.equal(
    operationItemKeyOf(movement, { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size: 38 }, 2),
    operationItemKeyOf(movement, { purchaseBatchRecordId: 'batch_1', productRecordId: 'product_1', size: 38 }, 2),
  );
});

test('AC-K6 人工调整 / 状态变更：不同 requestId / 目标身份得到不同操作键', () => {
  const manual = STOCK_MOVEMENTS[ADJUSTMENT_BEHAVIORS.MANUAL_INCREASE];
  const a = operationIdOf(manual, { requestId: 'req-1', productRecordId: 'product_1', size: 38, state: '门盒' });
  const b = operationIdOf(manual, { requestId: 'req-2', productRecordId: 'product_1', size: 38, state: '门盒' });
  const c = operationIdOf(manual, { requestId: 'req-1', productRecordId: 'product_1', size: 39, state: '门盒' });
  const d = operationIdOf(manual, { requestId: 'req-1', productRecordId: 'product_1', size: 38, state: '仓库' });
  assert.equal(new Set([a, b, c, d]).size, 4, 'requestId / 尺码 / 状态任一不同都必须换一把键');
});
