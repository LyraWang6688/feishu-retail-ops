// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 17-63 / 346-360 / 362-409 / 411-428 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 「键」相关的纯工具（幂等键 / 库存键 / 关联列 / 操作键），不碰远端读写。
// ⚠️ 2026-11-08（issue #961）：新增**操作键统一入口**（operationSourceIdOf / operationIdOf /
//    operationItemKeyOf + 配置校验）；原来的库存键 / 关联键工具**逐字未改**。
const crypto = require('node:crypto');
const { textValue } = require('../v1BitableGateway');
const { normalizeSize } = require('../sizeReferenceService');
// 操作键的**来源身份拼法**声明在行为注册表里（`STOCK_MOVEMENTS[x].operationKey`）——
// 本文件只实现「照配置生成键」的纯工具，不认具体行为、不碰远端。
// 依赖方向：keys.js（工具）→ movements.js（纯配置，无 import）——不会成环。
const { STOCK_MOVEMENTS } = require('./movements');
// 用户可见 / 部署闸门可见的文案：家在这些 config 里（不写死在 service 层）。
const { OPERATION_KEY_TEXT } = require('../../config/inventoryOperationKeys');
// 配置校验（部署闸门用；纯函数，不读远端）在 `./operationKeyConfig.js`（与本文件的工具面分开）。
const { validateOperationKeySpec, validateOperationKeyConfigs } = require('./operationKeyConfig');

// ── 「库存键」的两种写法（业务负责人 2026-10-07 拍板：两种都给）──────────────────
//   · `stock_key`       = `商品record_id|尺码|所属状态` —— **内部键**。库存任务的串行队列
//     （runForStock）、本地任务记录、幂等判据都用它；**原值一个字符都不许动**。
//   · `stock_key_label` = `货号|颜色|类别|尺码` —— 飞书侧「库存键」公式算好的那串，
//     人读得懂，也能直接拿去多维表格里搜（她举的例子：`5801-38|灰色|B|38`）。
//
// ⚠️ 这里**故意不重新拼** `stock_key_label`：实时库存记录上本来就有飞书算好的「库存键」列，
//    而库存引擎在挑要扣的那几双时**已经**把这张表读进来了
//    （applyChange / transitionState / promoteToSample 都读过）
//    ⇒ 抄一下就有：**零额外请求、零漂移**（货号/颜色/类别的取值规则在飞书那一侧，
//      代码这边一个字都不抄）。
// ⚠️ 抄不到时（这一款在店里一双都没有 —— 例如采购入库第一双新品）**不猜**：
//    只留 `stock_key_label_source: 'unavailable'`。要拼那一串就得多读一次「货品信息」，
//    本方案选择不读：宁可少一个字段，也不在写库路径上多一次请求。
//    ⭐ 调用方**已经知道**那一串时（例如它自己刚读过那张表），可以走
//    `options.stockKeyLabel` 直接给 —— 那会记成 `stock_key_label_source: 'caller'`。
//
// ⚠️ 统一约定：**只进日志的东西一律走尾部可选参数 `options`**（`correlation` /
//    `stockKeyLabel`），绝不塞进 `input`。这样"库存引擎的业务入参形状一个字段都没变"
//    是可以被既有测试里那些逐字 deepEqual 当场证明的。
const STOCK_KEY_LABEL_SOURCE = Object.freeze({
  LIVE_INVENTORY: 'live_inventory',
  CALLER: 'caller',
  UNAVAILABLE: 'unavailable',
});

const stockKeyLabelFields = ({ record, fieldName, fallback } = {}) => {
  const fromRecord = textValue(record?.fields?.[fieldName]).trim();
  if (fromRecord) {
    return { stock_key_label: fromRecord, stock_key_label_source: STOCK_KEY_LABEL_SOURCE.LIVE_INVENTORY };
  }
  const given = String(fallback || '').trim();
  if (given) return { stock_key_label: given, stock_key_label_source: STOCK_KEY_LABEL_SOURCE.CALLER };
  return { stock_key_label_source: STOCK_KEY_LABEL_SOURCE.UNAVAILABLE };
};

// 关联键（task_id / order_no / sales_entry_record_id）：只进日志，不改任何业务判断。
// 空对象不落进本地任务记录，免得每个任务文件都多一个 `"correlation": {}` 噪声键。
const correlationPatch = (correlation) =>
  (Object.keys(correlation).length ? { correlation } : {});

// 已经落在本地任务记录上的那两种键（日志用）：`stock_key_label` 只有真的抄到了才出现，
// `stock_key_label_source` 永远有值 —— 这样"这条日志为什么没有 label"是能直接读出来的。
const stockKeyLabelOfOperation = (operation = {}) => ({
  ...(operation.stock_key_label ? { stock_key_label: operation.stock_key_label } : {}),
  stock_key_label_source: operation.stock_key_label_source || STOCK_KEY_LABEL_SOURCE.UNAVAILABLE,
});

const positiveNumber = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
};

const positiveInteger = (value, label) => {
  const number = positiveNumber(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label}必须是正整数`);
  return number;
};

const operationId = (kind, sourceRecordId) =>
  `inventory_${kind}_${crypto.createHash('sha256').update(String(sourceRecordId)).digest('hex').slice(0, 20)}`;

// ── 操作键统一入口（2026-11-08 · issue #961）───────────────────────────────────
// 三把键的唯一生成口。**行为注册表声明来源，写入件只调这里**：
//   operationSourceIdOf(movement, input)            → 来源身份（本地幂等键的输入）
//   operationIdOf(movement, input)                  → inventory_<kind>_<sha256(sourceId)>
//   operationItemKeyOf(movement, input, sequence)   → <operationId>:<sequence>
//
// `movement.operationKey` 声明形状（见 `inventory/movements.js` 顶部的注释）：
//   kind             operationId 前缀（历史键逐字兼容）
//   sourcePrefix     可选：来源身份前缀（`<prefix>:<body>`）
//   sourceFields     来源身份组成字段（第一个是"身份字段"，其余必需）
//   sourceFallbacks  可选：身份字段拿不到时的回落顺序
//   separator        多字段连接符
//   perItem          是否每个（货品 + 尺码）独立一把键（声明 true ⇒ 必须含 productRecordId + size）
//   missingMessage   身份字段缺失时的明确错误（**绝不编 id**）
//   fieldMessages    可选：必需组成字段缺失时的逐字段错误
//   operations       可选：同一行为的另一条通路的独立键声明（例：补样品通路 kind='sample'）
//
// ⚠️ 同一个行为的两条通路用不同 kind 是**历史事实**（`sample` vs 行为编码），由配置声明，
//    不允许在写入件里各自拼一份 —— 那就是 issue 要消灭的"两套行为"。
const SAMPLE_PROMOTION_OPERATION = 'sample_promotion';

const operationKeySpecOf = (movement, operationPath) => {
  const spec = movement && movement.operationKey;
  if (!spec) {
    throw new Error('库存动作缺少 operationKey 声明：新增库存行为必须先在行为注册表里声明幂等来源');
  }
  if (!operationPath) return spec;
  const override = spec.operations && spec.operations[operationPath];
  if (!override) {
    throw new Error(`库存动作没有声明「${operationPath}」通路的操作键（operationKey.operations）`);
  }
  return override;
};

const sourceFieldMessage = (spec, field) => {
  const configured = spec.fieldMessages && spec.fieldMessages[field];
  if (configured) return configured;
  return OPERATION_KEY_TEXT.sourceFieldMissing(field);
};

// 必需组成字段：`size` 一律走 normalizeSize（与旧来源拼法逐字一致）；其余按"非空"取值。
const requiredSourceFieldValue = (spec, input, field) => {
  const raw = input && input[field];
  if (field === 'size') return String(normalizeSize(raw));
  if (!raw) throw new Error(sourceFieldMessage(spec, field));
  return String(raw);
};

const operationSourceIdOf = (movement, input, operationPath) => {
  const spec = operationKeySpecOf(movement, operationPath);
  const identityChain = [spec.sourceFields[0], ...(spec.sourceFallbacks || [])];
  let identity = '';
  for (const field of identityChain) {
    const raw = input && input[field];
    if (!raw) continue;
    const text = String(raw).trim();
    if (text) { identity = text; break; }
  }
  if (!identity) throw new Error(spec.missingMessage);
  const parts = [identity];
  for (const field of spec.sourceFields.slice(1)) {
    parts.push(requiredSourceFieldValue(spec, input, field));
  }
  const body = parts.join(spec.separator || '');
  return spec.sourcePrefix ? `${spec.sourcePrefix}:${body}` : body;
};

const operationIdOf = (movement, input, operationPath) =>
  operationId(operationKeySpecOf(movement, operationPath).kind,
    operationSourceIdOf(movement, input, operationPath));

const operationItemKeyOf = (movement, input, sequence, operationPath) =>
  operationItemKey(operationIdOf(movement, input, operationPath),
    positiveInteger(sequence, OPERATION_KEY_TEXT.sequenceLabel));

// ── `ledgerLink`：**只写不查**的"库存流水 → 来源表"关联列（2026-10-08 加）─────────────
// 与 `ledgerSource` 的分工见 STOCK_MOVEMENTS[采购增加] 的注释。两个 helper 只在
// `applyChange`（落本地任务）与 `executeOperation`（写流水）里各用一次，配置驱动、无 if 分支。
//
// ① 落本地任务：**必须在 prepare 那一刻就存下来** —— 流水只创建一次，
//    崩溃后经 `resumePending` 补写的那一次也必须有得写（否则重放的那条会静默丢关联）。
const movementLedgerLinkPatch = (movement, input) => (movement.ledgerLink
  ? { [movement.ledgerLink.operationKey]: String(input?.[movement.ledgerLink.inputKey] || '').trim() }
  : {});

// ② 写流水时取值：**拿不到就返回空串 ⇒ 整列不写**（绝不回退成批次号 / 任务 id / 三元组键）。
const movementLedgerLinkValue = (movement, operation) => (movement.ledgerLink
  ? String(operation?.[movement.ledgerLink.operationKey] || '').trim()
  : '');

// 一次库存操作里「第 N 双」的远端标识。实时库存是一双一条记录，
// 本地日志丢失时只能靠这个键回答「这一双是不是已经建过了」。
const operationItemKey = (inventoryOperationId, sequence) => `${inventoryOperationId}:${sequence}`;

module.exports = {
  STOCK_KEY_LABEL_SOURCE,
  stockKeyLabelFields,
  correlationPatch,
  stockKeyLabelOfOperation,
  positiveNumber,
  positiveInteger,
  operationId,
  // 操作键统一入口（issue #961）
  SAMPLE_PROMOTION_OPERATION,
  operationKeySpecOf,
  operationSourceIdOf,
  operationIdOf,
  operationItemKeyOf,
  validateOperationKeySpec,
  validateOperationKeyConfigs,
  // 旧入口：deprecated 一个版本，内部只调统一入口（行为只有一套）
  movementLedgerLinkPatch,
  movementLedgerLinkValue,
  operationItemKey,
};
