/**
 * ⭐⭐ **「生成报货单时按供应商拆分/分组」的配置** —— 业务负责人 2026-10-16 **当天拍板：选 ⓐ** ✓。
 *
 * ── 她的口径（逐字，**权威**；本文件是它在代码里的唯一落点）────────────────────────
 *   「在**同一个报货批次号**里面，有可能会**混杂着不同的供应商**。我们在**生成报货单**的时候，
 *    需要**按照供应商进行拆分和分组**。因为这个报货单是我们要**对接供应商**的，
 *    所以**必须按照供应商进行分组**。」
 *
 *   ⭐ 我追问之后她明确：**ⓐ「同一批次号下按供应商分组」** ✓
 *      （**不是** ⓑ「每个供应商各开一个新批次号」✗）。
 *   ⭐ 这条也是 `config/scanDraft.js` 里那个 **`supplierSplit.batchNoPolicy`** 的落定
 *      ——S1（#732）当时把它**如实标成 `undecided`** ✗（"拆成几单 / 几个批次号要列成问题问她"），
 *      本刀按她 2026-10-16 的选择**落成 `same_batch_no`** ✓（那边现在从本文件读，**不抄第二份** ✗）。
 *
 * ── 为什么单独一个文件（AGENTS.md《底层工程原则》的「配置先行」）────────────────────
 *   · 分组口径（同一批次号 vs 每供应商一个新号）· 每组的**幂等键前缀** ·
 *     "拿不到供应商"落在哪个桶 · 事件名 —— **全是会改的口径**，改的时候只动这里，
 *     逻辑里一行都不许写死 ✗（`services/supplierSplitService.js` 里没有任何中文字面量）；
 *   · 🔴 **不碰 `config/scanWrite.js`**（红线：那个文件一个字不动 ✗）
 *     ⇒ 本文件**不 require 它**，也不 require `config/scanDraft.js`（**单向**：那边 require 这边 ✓）。
 *
 * ── 表结构能不能表达"同一个批次号下多组"（**只读核对过，结论：能** ✓）────────────────
 *   三张落点全部**已有**，**一个新列都不需要** ✗（她 ADDENDUM-3 结论①：不加列）：
 *   · 「采购主表」（`purchaseOrderBatch`，真表 14 列）—— **一行一个批次号**：
 *     `报货批次号` / `供应商`(SingleLink，**代码只读不写**，她自己维护) / `单据`(Attachment，**多文件**)
 *     / `录入数量` / `采购行为` / `到货状态` …
 *     ⇒ **多组共用这一行** ✓（她的 ⓐ 就是"单内分组"✓，**不是**多开一行 ✗）
 *   · 「采购明细」（`purchaseRequest`，真表 10 列）—— **每个尺码一行**，行上带 `编号`(→货品)
 *     ⇒ 货品的供应商由关联/公式**逐行体现**（`采购明细.供应商` 是 **Formula / 只读**，代码不写 ✗）；
 *   · 「单据」附件列**支持多文件**：每个供应商**各一张**报货单 PNG 都挂在**同一行**上
 *     （`services/purchaseOrderBatchService.js` 的 `writeDocument` 是"已有附件原样带上再追加" ✓）。
 *   ⇒ 所以"同一批次号下按供应商分几组"落在：**主表一行 ＋ 明细行各带自己的供应商 ＋
 *     单据列里每个供应商一张图**；**批次号只有同一个** ✓（`AC-SS3` 钉着"不许新增批次号"）。
 *
 * ── 其余口径的出处 ───────────────────────────────────────────────────────────
 *   · **不新增批次号**：她选 ⓐ ✓ ⇒ `batchNoPolicy` 只认 `same_batch_no`（其余值**当场抛** ✗）；
 *   · **每组的幂等键**：前缀**独立**（`supplier_group:` / `supplier_document:`）——
 *     不与 `purchase_batch:*` / `purchase_request:*` / `purchase_return_doc:*` / `scan_draft:*` 撞 ✓；
 *   · **拿不到供应商**（历史明细 / 货品没挂供应商）：归一个**明确的**桶
 *     （`unspecified` ⇒ 出图仍出"未标注供应商"那一张 ✓ 与 `purchaseGroupNoticeText` 的兜底一致），
 *     **不猜、不编、也不丢** ✗。
 */

const { readString } = require('./envValue');

/**
 * 批次号口径的取值域 —— **只有 ⓐ**。
 *   · `same_batch_no` = 她的原话（同一个报货批次号下按供应商分组）✓ **缺省**；
 *   · ⛔ 刻意**不提供** `new_batch_no_per_supplier`（= ⓑ）：写成可选就等于把"她没选的方案"
 *     留在配置里，哪天有人顺手配上就是另一套业务 ✗ ⇒ 认不出的值**当场抛** ✓。
 */
const BATCH_NO_POLICIES = Object.freeze({ sameBatchNo: 'same_batch_no' });

/** 「拆」发生在那一步（= 生成报货单；**不是**存草稿 —— 存草稿阶段一个字节都不拆 ✓）。 */
const SPLIT_STAGE = 'generate_report';

/** 拿不到供应商时落哪个桶（出图那边照旧出"未标注供应商"那一张 ✓）。 */
const DEFAULT_UNSPECIFIED_KEY = 'unspecified';

/** 每组一把**组级幂等键**（`{batchKey}` / `{supplierKey}` 两个占位符 ✓ —— 不写死拼法 ✗）。 */
const DEFAULT_GROUP_KEY_TEMPLATE = 'supplier_group:{batchKey}:{supplierKey}';

/** 每组一张**报货单**的幂等键（`{batchNo}` / `{supplierKey}` ✓）。 */
const DEFAULT_DOCUMENT_KEY_TEMPLATE = 'supplier_document:{batchNo}:{supplierKey}';

/**
 * 解析一份配置（**每次调用都重新读 env** ⇒ 用例可以传不同的 env 验"改配置即改行为" ✓，
 * 与 `resolveScanDraftConfig` / `resolveMultiItemOrderConfig` 同一种形状）。
 * @param {object} [env] 默认 `process.env`
 */
const resolveSupplierSplitConfig = (env = process.env) => {
  const batchNoPolicy = readString(env, 'SUPPLIER_SPLIT_BATCH_NO_POLICY', BATCH_NO_POLICIES.sameBatchNo);
  if (batchNoPolicy !== BATCH_NO_POLICIES.sameBatchNo) {
    throw new Error(
      `SUPPLIER_SPLIT_BATCH_NO_POLICY 只认 ${BATCH_NO_POLICIES.sameBatchNo}`
      + '（业务负责人 2026-10-16 拍板选 ⓐ：同一批次号下按供应商分组；'
      + 'ⓑ「每个供应商各开一个新批次号」她没有选 ⇒ 不是可配置项），'
      + `当前值无法识别：${batchNoPolicy}`,
    );
  }
  return Object.freeze({
    // ⭐ 她的选择（ⓐ）—— 本文件是它的唯一真源；`config/scanDraft.js` 从这里读，不抄第二份 ✓
    batchNoPolicy,
    stage: readString(env, 'SUPPLIER_SPLIT_STAGE', SPLIT_STAGE),
    // 「拿不到供应商」的桶（**显式可配**：留空串 = 空键 ⇒ 调用方按"认不出"处理，不静默回退 ✓）
    unspecifiedKey: readString(env, 'SUPPLIER_SPLIT_UNSPECIFIED_KEY', DEFAULT_UNSPECIFIED_KEY),
    // 组级幂等键 / 单据级幂等键的**模板**（配置先行 ⇒ 换拼法不用改代码 ✓）
    groupKeyTemplate: readString(env, 'SUPPLIER_SPLIT_GROUP_KEY', DEFAULT_GROUP_KEY_TEMPLATE),
    documentKeyTemplate: readString(env, 'SUPPLIER_SPLIT_DOCUMENT_KEY', DEFAULT_DOCUMENT_KEY_TEMPLATE),
    // 事件名（日志口径；排查时按它们 grep ✓）。全部可配 ⇒ 改名不用改逻辑 ✓。
    events: Object.freeze({
      // 一个批次号下**真的分了组**（>1 组）—— 单供应商**不打**这条（免得日常刷屏 ✓）
      grouped: readString(env, 'SUPPLIER_SPLIT_EVENT_GROUPED', 'supplier.split.grouped'),
      // 某一组**已经出过报货单**（重复生成那一组被跳过：只出一次 ✓ AC-SS4）
      groupAlreadyReported: readString(
        env, 'SUPPLIER_SPLIT_EVENT_ALREADY_REPORTED', 'supplier.split.group_already_reported',
      ),
      // 调用方（引擎）算出来的组 与 写入口按草稿算出来的组**对不上** ⇒ 如实吵（不静默选一个 ✗）
      mismatch: readString(env, 'SUPPLIER_SPLIT_EVENT_MISMATCH', 'supplier.split.mismatch'),
    }),
  });
};

/** 默认那一份（进程级；跟 `process.env` 走）。 */
const SUPPLIER_SPLIT = resolveSupplierSplitConfig();

module.exports = {
  resolveSupplierSplitConfig,
  SUPPLIER_SPLIT,
  BATCH_NO_POLICIES,
  SPLIT_STAGE,
  DEFAULT_UNSPECIFIED_KEY,
  DEFAULT_GROUP_KEY_TEMPLATE,
  DEFAULT_DOCUMENT_KEY_TEMPLATE,
};
