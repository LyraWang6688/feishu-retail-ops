/**
 * ⭐⭐ **「生成报货单时按供应商拆分/分组」**（业务负责人 2026-10-16 拍板：**选 ⓐ** ✓）。
 *
 * ── 一个模块只干一件事（AGENTS.md《底层工程原则》的「模块化」）────────────────────
 *   给一串**明细**（`items`，每条自带 `supplier_record_id`），算出
 *   **同一个报货批次号下**按供应商分的几组 —— 每组带着**组级幂等键**与**单据幂等键**。
 *   🔴 它**不写任何表**、**不认识飞书**（不 require gateway / schema）、**不调任何写入件** ✗；
 *      也**不渲染**（出图是 `services/purchaseRequestImageService.js` 的事）。
 *
 * ── 她的口径（逐字，**权威**；别自己解释 ✗）──────────────────────────────────
 *   「在**同一个报货批次号**里面，有可能会**混杂着不同的供应商**。我们在**生成报货单**的时候，
 *    需要**按照供应商进行拆分和分组**。因为这个报货单是我们要**对接供应商**的，
 *    所以**必须按照供应商进行分组**。」
 *   ⭐ 追问后她明确 **ⓐ「同一批次号下按供应商分组」** ✓（**不是** ⓑ"每个供应商各开一个新批次号"✗）
 *   ⇒ 所以本模块**永远只输出一个批次号**（`batchCount: 1`）✓：
 *      · 分组 = **单内分组**（组的身份 = 批次号 ＋ 供应商），**不是**多个批次 ✗；
 *      · 落表就落在**已有的三处**（一个批次行 ＋ 每行自带供应商的明细 ＋ 单据列里每组一张图），
 *        **一个新列都不加** ✗（她 ADDENDUM-3 结论①）。
 *
 * ── 幂等（本模块只**算键**，判据在调用方）────────────────────────────────────
 *   · 每组一把 `group_key`（`supplier_group:{batchKey}:{supplierKey}`）——
 *     同一个批次号 ＋ 同一个供应商 ⇒ **永远是同一把键** ⇒ 重复生成不会多出一组 ✓；
 *   · 每组一张报货单：`document_key`（`supplier_document:{batchNo}:{supplierKey}`）
 *     ＋ 落到「单据」里的**文件名**（`{供应商名}-{后缀}.png`，`documentFileNameOf` 唯一一处实现 ✓）
 *     —— 文件名就是"这一组的报货单已经出过"的**持久化判据**（附件列天然去重 ✓）。
 *
 * ── 边界的两个"不猜"───────────────────────────────────────────────────────────
 *   · **拿不到供应商**（历史明细 / 货品没挂供应商）⇒ 落 `unspecified` 桶
 *     （= 出图那边照旧出"未标注供应商"的那一张 ✓），**不猜是谁、也不把这些行丢掉** ✗；
 *   · **组顺序 = 明细里第一次出现的顺序**（稳定、可复现；**不排序** ✗ —— 排序会让同一份草稿
 *     两次生成出不同的图序，反而更难对账）。
 */

const { SUPPLIER_SPLIT } = require('../config/supplierSplit');

/** `{name}` 占位符替换（与 `config/scanWrite.js` 的 `fillText` 同一种形状；**不互相 require** ✗）。 */
const fillTemplate = (template, values = {}) => String(template || '')
  .replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
  ));

/** 明细上的供应商（`supplier_record_id` / `supplierRecordId` 两种写法都认 ✓）。 */
const supplierRecordIdOf = (item = {}) => String(
  item?.supplier_record_id ?? item?.supplierRecordId ?? '',
).trim();

/**
 * 一条明细属于哪一组（**空供应商 = 明确的"没标注"桶**，不是"随便归到某一组" ✗）。
 * @returns {string} 组键（供应商记录 id，或配置里的 `unspecifiedKey`）
 */
const supplierKeyOf = (item = {}, config = SUPPLIER_SPLIT) => {
  const recordId = supplierRecordIdOf(item);
  return recordId || String(config?.unspecifiedKey ?? '');
};

/**
 * 按供应商分组（**纯函数**；出图那边与本模块**同一套**分桶 ⇒ 不会有第二份口径漂移 ✓）。
 *
 * 形状与 `services/purchaseWebhookService.js` 里原有的私有 `groupItemsBySupplier` **逐字兼容**
 * （那是"每个供应商一张图"的老实现），额外多出 `key`：
 * @returns {Array<{key:string, supplierRecordId:string, items:Array, indexes:Array<number>}>}
 */
const groupItemsBySupplier = (items, config = SUPPLIER_SPLIT) => {
  const groups = new Map();
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const key = supplierKeyOf(item, config);
    if (!groups.has(key)) {
      groups.set(key, { key, supplierRecordId: supplierRecordIdOf(item), items: [], indexes: [] });
    }
    const group = groups.get(key);
    group.items.push(item);
    group.indexes.push(index);
  });
  return [...groups.values()];
};

/** 这一组几张（`quantity` 求和；**口径与出图那条**「这批 N 双」逐字相同 ✓）。 */
const pairCountOf = (items) => (Array.isArray(items) ? items : [])
  .reduce((sum, item) => sum + Number(item?.quantity || 0), 0);

/**
 * ⭐ **生成报货单时那一下要的分组**（本模块的主入口）。
 *
 * 🔴 **批次号一个都不多**：`batchCount` 恒为 `1`、`batchNo` 原样返回（她选的 ⓐ ✓）——
 *    要"每个供应商一个新批次号"（ⓑ）的话**不是改这里**，而是**回 Lead 让她重新拍** ✗。
 *
 * @param {object} input
 * @param {Array}  input.items     明细（每条可带 `supplier_record_id` / `quantity`）
 * @param {string} [input.batchNo] 这一次的报货批次号（**已经在生成那一步定好了** ✓）
 * @param {string} [input.batchKey] 批次幂等键（`purchase_batch:<taskId>`）—— 组键里用它 ⇒ 同一批同一组恒等 ✓
 * @param {string} [input.taskId]  本地采购任务 id（**只进日志/键，不改批次号** ✗）
 * @param {object} [input.config]
 */
const splitBySupplier = ({ items = [], batchNo = '', batchKey = '', taskId = '', config = SUPPLIER_SPLIT } = {}) => {
  const list = Array.isArray(items) ? items : [];
  const groups = groupItemsBySupplier(list, config).map((group) => ({
    supplier_record_id: group.supplierRecordId,
    supplier_key: group.key,
    group_key: fillTemplate(config.groupKeyTemplate, { batchKey, supplierKey: group.key }),
    document_key: fillTemplate(config.documentKeyTemplate, { batchNo, supplierKey: group.key }),
    indexes: group.indexes,
    items: group.items,
    detail_count: group.indexes.length,
    pair_count: pairCountOf(group.items),
  }));
  return {
    policy: config.batchNoPolicy,
    stage: config.stage,
    // ⭐ 她的 ⓐ：**同一个批次号**（分组是单内分组）—— 这里恒为 1，判据 AC-SS3 钉着它 ✓
    batchCount: 1,
    batchNo: String(batchNo || ''),
    batchKey: String(batchKey || ''),
    taskId: String(taskId || ''),
    // 单供应商（今天绝大多数情况）⇒ `single: true` ⇒ 调用方**逐字按今天走**（零回归 ✓）
    single: groups.length <= 1,
    groupCount: groups.length,
    groups,
    summary: {
      batch_count: 1,
      group_count: groups.length,
      supplier_keys: groups.map((group) => group.supplier_key),
      group_keys: groups.map((group) => group.group_key),
      detail_count: list.length,
    },
  };
};

/**
 * 「单据」里那一张图叫什么名字 —— **唯一一处实现** ✓
 * （`services/purchaseWebhookService.js` 的 `writeSupplierImageAttachment` 与
 *  "这一组是不是已经出过了"的前置判据**共用它** ⇒ 判据与落点不会漂 ✓）。
 *
 * ⚠️ 规则沿用既有语义（**一个字没改**）：把供应商名里不安全的字符去掉；
 *    去完为空（名字全是符号）或**压根没给名字** ⇒ 用 `supplier` 兜底，
 *    后面拼 `-{后缀}.png`。
 */
const documentFileNameOf = (supplierName, fileNameSuffix = '') => {
  const safeName = String(supplierName || 'supplier').replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'supplier';
  return `${safeName}-${fileNameSuffix}.png`;
};

module.exports = {
  splitBySupplier,
  groupItemsBySupplier,
  supplierKeyOf,
  supplierRecordIdOf,
  documentFileNameOf,
  pairCountOf,
  fillTemplate,
};
