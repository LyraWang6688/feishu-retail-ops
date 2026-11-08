/**
 * 库存操作键（issue #961）相关文案 —— **用户可见 / 部署闸门可见**。
 *
 * 为什么单独一个 config 文件：按项目约定「新的用户可见文案抽到 config，不许写死在 service 里」
 * （`test/noHardcodedChinese.test.js` 会拦"新增硬编码中文"）。
 * 行为注册表（`services/inventory/movements.js`）与统一入口（`services/inventory/keys.js`）
 * 只引用这里的键名。
 *
 * ⚠️ 这些是**错误文案**：来源身份 / 组成字段拿不到时**当场抛**（绝不编 id）。
 *    改文案**不会**改变任何键字符串 —— 键只由 `sourceFields` / `separator` /
 *    `sourcePrefix` / `kind` 决定（见 `inventory/keys.js` 的 `operationSourceIdOf`）。
 */

// 来源身份缺失（按行为区分；与 2026-11-08 重构前的报错**逐字相同**）。
const SOURCE_MISSING = Object.freeze({
  purchaseIncrease: '采购入库缺少来源标识（批次记录 id / 批次号 / 到货核对任务 id 至少要有一个）',
  purchaseReturn: '采购退货缺少来源标识（批次记录 id / 批次号 / 退货任务 id 至少要有一个）',
  saleDetail: '库存变化缺少来源明细 record_id',
  sourceRecordId: '库存变化缺少来源明细 record_id',
  manualCount: '人工库存调整缺少来源标识（请求编号 requestId）',
  manualState: '库存状态变更缺少来源标识（requestId）',
  samplePromotion: '补样品缺少销售明细或货品',
});

// 来源身份的**必需组成字段**缺失（例如采购三元组里的货品 record_id）。
const FIELD_MISSING = Object.freeze({
  productRecordId: '库存变化缺少商品 record_id',
});

// 统一入口的通用文案。
const OPERATION_KEY_TEXT = Object.freeze({
  sequenceLabel: '库存操作序号',
  actionLabel: (code) => `库存动作「${code}」`,
  sourceFieldMissing: (field) => `库存操作的来源字段「${field}」缺失（来源身份需要它，不能编一个值）`,
});

// 配置校验（部署闸门 `validateStockBehaviors()` 的一部分）的报错片段。
// 键名对应 `inventory/keys.js` 的 `validateOperationKeySpec`。
const OPERATION_KEY_CONFIG_ERROR = Object.freeze({
  kindMissing: '缺少 kind（operationId 前缀）',
  sourceFieldsRequired: '的 sourceFields 必须是非空数组',
  sourceFieldsEmptyField: '的 sourceFields 里有空字段名',
  sourceFieldsDuplicate: '的 sourceFields 有重复字段',
  sourceFallbacksRequired: '的 sourceFallbacks 必须是数组',
  sourceFallbacksEmptyField: '的 sourceFallbacks 里有空字段名',
  sourceFallbacksDuplicate: (field) => `的 sourceFallbacks 不能重复 sourceFields 里的「${field}」`,
  separatorRequired: '多字段来源必须声明 separator',
  perItemBoolean: '的 perItem 必须是显式布尔',
  perItemFields: '声明 perItem=true 时必须把 productRecordId 与 size 纳入 sourceFields'
    + '（漏字段就是历史撞键事故：同款不同码共用一把键）',
  missingMessageRequired: '缺少 missingMessage（来源身份缺失时要抛明确错误，绝不编 id）',
  fieldMessagesObject: '的 fieldMessages 必须是对象',
  fieldMessagesUnknown: (field) => `的 fieldMessages 指向了不在 sourceFields 里的「${field}」`,
  operationsObject: '的 operations 必须是对象',
});

module.exports = {
  SOURCE_MISSING,
  FIELD_MISSING,
  OPERATION_KEY_TEXT,
  OPERATION_KEY_CONFIG_ERROR,
};
