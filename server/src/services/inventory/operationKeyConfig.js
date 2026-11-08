// 库存操作键的**声明式来源形状 + 配置校验**（issue #961，2026-11-08）。
//
// 与 `keys.js` 的分工：
//   · 本文件 = **配置面**：来源身份的共享形状（人工调整 / 销售明细 / 售后给定来源）+ 声明校验；
//   · `keys.js` = **工具面**：`operationSourceIdOf` / `operationIdOf` / `operationItemKeyOf`
//     三个入口 + 纯哈希 / 序号工具；
//   · `movements.js`（行为注册表）为每个行为引用这里的形状并补上自己的
//     `kind` / 来源前缀（点名声明仍在每个行为里）。
//
// 来源身份缺失 / 配置校验的用户可见文案（家在这些 config 里）。
const {
  SOURCE_MISSING,
  OPERATION_KEY_TEXT,
  OPERATION_KEY_CONFIG_ERROR,
} = require('../../config/inventoryOperationKeys');

// ── 操作键声明（2026-11-08 · issue #961「库存操作键统一配置化」）──────────────────
// 每个行为在 `operationKey` 里声明**这一次库存操作的来源身份**，由 `inventory/keys.js`
// 的唯一入口生成三把键（纯哈希 / 序号工具仍在 keys.js）：
//   · `operationSourceIdOf(movement, input)` —— 来源身份（= 本地幂等键的输入）；
//   · `operationIdOf(movement, input)`       —— `inventory_<kind>_<sha256(sourceId)>`；
//   · `operationItemKeyOf(movement, input, sequence)` —— `<operationId>:<sequence>`。
//
// ⚠️ **历史键字符串一个字节都不许变**（本地任务 / 库存流水 / 实时库存里已经写着那些键）。
//    所以 `kind` 用的仍是原先传给 `operationId()` 的那个前缀（大部分 = 行为编码，
//    采购入库 / 采购退货的**来源前缀**才是 `purchase_increase:` / `purchase_return:`）。
// ⚠️ 新增库存行为 = 「行为管理」表补一条 + `movements.js` 对应行为里补一条 `operationKey`
//    （**不改任何写入件**）；缺声明会被部署闸门 `validateStockBehaviors()` 里的
//    `validateOperationKeyConfigs` 拦红。
//
// `sourceFields` 的语义（按顺序、稳定、可空策略明确）：
//   · 第一个字段 = **身份字段**：取第一个非空（trim 后）的值；
//   · `sourceFallbacks` = 身份字段拿不到时的**回落顺序**（同样取第一个非空）；
//   · 其余字段 = **必需组成字段**：拿不到就按 `fieldMessages` / 通用文案**当场抛**，绝不编值；
//   · `size` 字段一律走 `normalizeSize`（与旧来源拼法逐字一致）；
//   · 多字段用 `separator` 连接；`sourcePrefix` 存在时结果是 `<prefix>:<body>`。
// `perItem` = 是否每个（货品 + 尺码）独立一把键（历史撞键事故就是采购入库漏了尺码）；
//   声明为 `true` 的行为必须把 `productRecordId` 与 `size` 纳入 `sourceFields`（校验会拦）。
// 人工调整 / 状态变更的来源身份 = 「工作台请求编号 + 目标身份」——`requestId` 由界面在
//   提交时生成一次、重试复用同一个；这两类**不混用**业务单据来源（见 docs 第 6.3 节）。
const MANUAL_COUNT_SOURCE = Object.freeze({
  // 与 `inventoryAdjustmentService.adjustmentSourceId` 历史输出逐字一致：
  //   `${requestId}:${productRecordId}:${size}:${state}`
  sourceFields: Object.freeze(['requestId', 'productRecordId', 'size', 'state']),
  separator: ':',
  perItem: false,
  missingMessage: SOURCE_MISSING.manualCount,
});
// 状态变更没有「数量方向」，来源身份带的是**起点状态**（fromState）。
const MANUAL_STATE_SOURCE = Object.freeze({
  sourceFields: Object.freeze(['requestId', 'productRecordId', 'size', 'fromState']),
  separator: ':',
  perItem: false,
  missingMessage: SOURCE_MISSING.manualState,
});
// 销售明细 record_id 直接就是来源身份（销售出库 / 补样品 / 售后三条）。
const SALE_DETAIL_SOURCE = Object.freeze({
  sourceFields: Object.freeze(['salesDetailRecordId']),
  perItem: false,
  missingMessage: SOURCE_MISSING.saleDetail,
});
// 售后链路和人工调整把**已经算好的真实来源**放在 `sourceRecordId` 上传进来
// （售后 = 销售明细 record_id；人工 = requestId 组合键，见上面的 MANUAL_*）。
const GIVEN_SOURCE = Object.freeze({
  sourceFields: Object.freeze(['sourceRecordId']),
  perItem: false,
  missingMessage: SOURCE_MISSING.saleDetail,
});


// 配置校验（部署闸门用；纯函数，不读远端）：新增行为漏了 `operationKey` / 声明不完整 ⇒ 红。
const validateOperationKeySpec = (spec, label) => {
  if (!spec || typeof spec !== 'object') {
    throw new Error(`${label} 缺失 operationKey（新增库存行为必须声明幂等来源）`);
  }
  const fail = (message) => { throw new Error(`${label} 的 operationKey ${message}`); };
  if (!String(spec.kind || '').trim()) fail(OPERATION_KEY_CONFIG_ERROR.kindMissing);
  const fields = spec.sourceFields;
  if (!Array.isArray(fields) || !fields.length) fail(OPERATION_KEY_CONFIG_ERROR.sourceFieldsRequired);
  for (const field of fields) {
    if (!String(field || '').trim()) fail(OPERATION_KEY_CONFIG_ERROR.sourceFieldsEmptyField);
  }
  if (new Set(fields).size !== fields.length) fail(OPERATION_KEY_CONFIG_ERROR.sourceFieldsDuplicate);
  const fallbacks = spec.sourceFallbacks === undefined ? [] : spec.sourceFallbacks;
  if (!Array.isArray(fallbacks)) fail(OPERATION_KEY_CONFIG_ERROR.sourceFallbacksRequired);
  for (const field of fallbacks) {
    if (!String(field || '').trim()) fail(OPERATION_KEY_CONFIG_ERROR.sourceFallbacksEmptyField);
    if (fields.includes(field)) fail(OPERATION_KEY_CONFIG_ERROR.sourceFallbacksDuplicate(field));
  }
  if (fields.length > 1 && !String(spec.separator || '')) fail(OPERATION_KEY_CONFIG_ERROR.separatorRequired);
  if (typeof spec.perItem !== 'boolean') fail(OPERATION_KEY_CONFIG_ERROR.perItemBoolean);
  if (spec.perItem && (!fields.includes('productRecordId') || !fields.includes('size'))) {
    fail(OPERATION_KEY_CONFIG_ERROR.perItemFields);
  }
  if (!String(spec.missingMessage || '').trim()) {
    fail(OPERATION_KEY_CONFIG_ERROR.missingMessageRequired);
  }
  if (spec.fieldMessages !== undefined) {
    if (!spec.fieldMessages || typeof spec.fieldMessages !== 'object') fail(OPERATION_KEY_CONFIG_ERROR.fieldMessagesObject);
    for (const field of Object.keys(spec.fieldMessages)) {
      if (!fields.includes(field)) fail(OPERATION_KEY_CONFIG_ERROR.fieldMessagesUnknown(field));
    }
  }
  if (spec.operations !== undefined) {
    if (!spec.operations || typeof spec.operations !== 'object') fail(OPERATION_KEY_CONFIG_ERROR.operationsObject);
    for (const [path, override] of Object.entries(spec.operations)) {
      validateOperationKeySpec(override, `${label}[${path}]`);
    }
  }
};

// ⚠️ 必须显式传行为注册表（部署闸门传 `STOCK_MOVEMENTS`）——本文件不反向依赖
//    `movements.js`（避免循环：movements → operationKeyConfig → movements）。
const validateOperationKeyConfigs = (movements) => {
  const codes = Object.keys(movements || {});
  if (!codes.length) throw new Error('库存动作注册表为空，无法校验操作键配置');
  for (const code of codes) {
    validateOperationKeySpec(movements[code] && movements[code].operationKey, OPERATION_KEY_TEXT.actionLabel(code));
  }
  return codes.length;
};

module.exports = {
  MANUAL_COUNT_SOURCE,
  MANUAL_STATE_SOURCE,
  SALE_DETAIL_SOURCE,
  GIVEN_SOURCE,
  validateOperationKeySpec,
  validateOperationKeyConfigs,
};
