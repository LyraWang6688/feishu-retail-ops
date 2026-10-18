// ⚠️ 2026-10-18（task-5 · `inventoryService.js` 大文件拆分）**只搬不改**：
//    本文件内容逐字节来自拆分前的 `services/inventoryService.js`（原 17-63 / 346-360 / 362-409 / 411-428 行）；
//    方法体一个字符未改（仍用 `this.`），由 facade 用 `Object.defineProperty`
//    以**与 class 方法相同的属性描述符**挂回 `InventoryService.prototype`。
// 「键」相关的纯工具（幂等键 / 库存键 / 关联列 / 操作键），不碰远端读写。
const crypto = require('node:crypto');
const { textValue } = require('../v1BitableGateway');
const { normalizeSize } = require('../sizeReferenceService');

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
const samplePromotionId = (salesDetailRecordId) => operationId('sample', salesDetailRecordId);

/**
 * 采购加库存的**来源标识**（＝ `operationId(kind, source)` 的本地幂等键）。
 *
 * ⚠️ 2026-10-07 深夜：业务负责人把「采购入库」表**整表删掉**了 ⇒ **没有入库行 id 了**。
 *    改用一个**真实三元组**：`采购批次身份 | 货品 record_id | 尺码`。
 *    · 为什么必须带「货品 + 尺码」：`operationId` 是"这一次加库存"的键，而**一个批次里
 *      每个（货品+尺码）各加一次**；只用批次 id 会让同一批第二个尺码撞上一个键，
 *      直接抛「库存操作内容与首次提交不一致」。
 *    · 为什么按可靠度取「批次记录 id → 批次号 → 到货核对任务 id」：前两个是业务身份
 *      （`draft.batch_record_id` / `batch_no`），第三个只在"孤儿调用"（历史草稿上两个都空）
 *      时兜底 —— 它同样是**真实** id（`arrival_reconcile_…`）。
 *    · 🔴 一个都拿不到时**当场抛错** —— **绝不编一个 id** 出来当幂等键。
 *    ⚠️ 它**只进本地任务记录与日志**（`ledgerLink` 那个远端关联值**另算**，
 *      见 `movementLedgerLinkPatch` / `movementLedgerLinkValue`）。
 */
const purchaseIncreaseSourceId = (input) => {
  const identity = String(
    input.purchaseBatchRecordId || input.purchaseBatchNo || input.arrivalTaskId || '',
  ).trim();
  if (!identity) {
    throw new Error('采购入库缺少来源标识（批次记录 id / 批次号 / 到货核对任务 id 至少要有一个）');
  }
  if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
  return `purchase_increase:${identity}|${input.productRecordId}|${normalizeSize(input.size)}`;
};

/**
 * ⭐ 2026-10-11：**采购退货**的来源标识（= 本地幂等键）。
 *
 * 与 `purchaseIncreaseSourceId` 同一个形状与同一条纪律：**真实三元组**
 * （批次身份 | 货品 record_id | 尺码），一个都拿不到就**当场抛**，绝不编一个 id。
 *
 * ⚠️ 为什么不能拿"退货明细行的 record_id"当来源：那条行**先写、库存后扣**，
 *    崩溃后重放要看的是"这一次退货的（货品+尺码）"是不是已经扣过 —— 用三元组最稳
 *    （与采购入库那条同源；「库存流水.关联采购」是**只写不查**的关联列，不参与幂等）。
 * ⚠️ 退货批次的身份优先用「报货批次」那一行的 record_id（最准、零额外请求），
 *    拿不到才回落到批次号。
 */
const purchaseReturnSourceId = (input) => {
  const identity = String(
    input.purchaseBatchRecordId || input.purchaseBatchNo || input.returnTaskId || '',
  ).trim();
  if (!identity) {
    throw new Error('采购退货缺少来源标识（批次记录 id / 批次号 / 退货任务 id 至少要有一个）');
  }
  if (!input.productRecordId) throw new Error('库存变化缺少商品 record_id');
  return `purchase_return:${identity}|${input.productRecordId}|${normalizeSize(input.size)}`;
};

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
  samplePromotionId,
  purchaseIncreaseSourceId,
  purchaseReturnSourceId,
  movementLedgerLinkPatch,
  movementLedgerLinkValue,
  operationItemKey,
};
