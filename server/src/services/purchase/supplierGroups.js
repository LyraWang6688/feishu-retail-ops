'use strict';

/**
 * 采购「按供应商分组 / 出图分组身份」—— 2026-10-18 从 `services/purchaseWebhookService.js`
 * **原样搬出**（文件大小门禁，见 task-6）。分桶口径仍在 `services/supplierSplitService.js`
 * （唯一一处），这里只做"从计划里取键 / 现算兜底"的薄编排，一字未改。
 */
const { textValue } = require('../v1BitableGateway');
const { splitBySupplier, groupItemsBySupplier: groupItemsBySupplierOf } = require('../supplierSplitService');

const supplierGroups = {
  // 同一个供应商的明细合成一张图。没有供应商的明细（历史草稿）归到一组，
  // 宁可出一张"未标注供应商"的图，也不能拆成一人一张。
  //
  // ⭐⭐ 2026-10-16（供应商拆分 · 她选的 ⓐ）：**分桶口径搬进 `services/supplierSplitService.js`**
  //   —— 出图 / 分组键 / 判据现在是**同一个纯函数**（`groupItemsBySupplierOf`）✓。
  //   行为**一个字没变**（同一趟遍历、同样"第一次出现的顺序"、同样把空供应商归一组 ✓）；
  //   这里保留方法名，是因为它已经是被调用方与用例认识的口子（换名只会制造无谓的 diff ✗）。
  groupItemsBySupplier(items) {
    return groupItemsBySupplierOf(items, this.supplierSplit);
  },

  /**
   * ⭐⭐ 2026-10-16（供应商拆分 · 业务负责人拍板 **ⓐ**）：**这一次要出的报货单 = 按供应商分的几组**。
   *
   * 组的**顺序与键**优先取「计划冻结」里那一份（= **生成报货单那一步**算好的 ✓，
   * `ensurePostingPlan` → `plan.supplier_groups`）；拿不到（老计划 / 冻结计划没有那两个字段）
   * 就按**同一条口径**现算（同一个纯函数 ✓ 不会漂）。
   *
   * 🔴 **批次号仍然是同一个**（她选的 ⓐ）⇒ 这里**只分组、不换号**：
   *   所有组共用 `posting.batch_no`，出图那一步把每组的图都挂到**同一行**的「单据」上 ✓。
   * 🔴 **不做"哪一组不在计划里就丢掉"** 这种事 ✗：草稿里有的供应商**必须都出图**
   *   （丢一组 = 那一家的货没人去报，是最坏的一种静默失败）。
   *
   * @returns {Array<{key:string, supplierRecordId:string, items:Array, indexes:Array<number>,
   *                  groupKey:string, documentKey:string, planned:boolean}>}
   */
  supplierReportGroups(task, posting = {}) {
    const draft = task?.draft || {};
    const items = Array.isArray(draft.items) ? draft.items : [];
    const batchNo = posting.batch_no || draft.batch_no || '';
    const plan = task?.posting_plan || {};
    const batchKey = String(posting.batch_key || plan.batch_key || '');
    const planned = Array.isArray(posting.supplier_groups) && posting.supplier_groups.length
      ? posting.supplier_groups
      : (Array.isArray(plan.supplier_groups) ? plan.supplier_groups : []);
    const byKey = new Map((planned || []).map((group) => [String(group?.supplier_key || ''), group]));
    return this.groupItemsBySupplier(items).map((group) => {
      const match = byKey.get(String(group.key || '')) || null;
      // 计划里有 ⇒ **逐字用它那把键**（那是"这一组"的身份）；没有 ⇒ 按同一条模板现算 ✓
      const computed = splitBySupplier({
        items: group.items,
        batchNo,
        batchKey,
        config: this.supplierSplit,
      }).groups[0] || { group_key: '', document_key: '' };
      return {
        key: group.key,
        supplierRecordId: group.supplierRecordId,
        items: group.items,
        indexes: group.indexes,
        groupKey: String(match?.group_key || computed.group_key || ''),
        documentKey: String(match?.document_key || computed.document_key || ''),
        planned: Boolean(match),
      };
    });
  },

  async resolveSupplierName(supplierRecordId) {
    if (!supplierRecordId) return '';
    const table = this.gateway.table('supplier');
    const record = await this.gateway.get('supplier', supplierRecordId).catch(() => null);
    return textValue(record?.fields?.[table.fields.name]).trim();
  },
};

module.exports = supplierGroups;
