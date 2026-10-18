'use strict';

/**
 * 采购「出单计划冻结」（幂等键的唯一来源）＋ 兜底取号 —— 2026-10-18 从
 * `services/purchaseWebhookService.js` **原样搬出**（文件大小门禁，见 task-6）。
 * 计划形状 / 幂等键 / 落盘时机 / 供应商分组冻结口径**全部逐字保留**。
 *
 * ⚠️ mixin：`this` = `PurchaseWebhookService` 实例（facade 保留同名薄委托方法）。
 */
const { splitBySupplier } = require('../supplierSplitService');
const { logInfo, logWarn } = require('../../utils/logger');

const postingPlan = {
  /**
   * 生成并持久化 Posting Plan。
   *
   * 这个计划有两个作用，缺一不可：
   * 1. 幂等键的唯一来源——重试时必须复用同一批键，每次重新生成等于没有幂等；
   * 2. 崩溃后的恢复清单——知道「应该写几条、写到哪一条」。
   *
   * 所以它必须在任何远端写入之前落盘；落盘失败就不能开始写。
   *
   * ⭐⭐ 2026-10-16（供应商拆分 · 业务负责人拍板 **ⓐ**）：**「按供应商分组」也在这里冻结** ✓
   *   —— 它在**任何远端写入之前**（建批次行 / 建明细 / 出图都在它之后）⇒ 正合她的口径
   *   「生成报货单那一下就要分好组」（生成完再拆就晚了 ✗）。落进 `plan.supplier_groups`：
   *     · **批次号仍然只有一个**（`batch_count` 恒为 1 ✓ 她选的 ⓐ —— 不是"每个供应商一个新号"✗）；
   *     · 每组带 `group_key`（组级幂等键）与 `document_key`（这一组那张报货单的幂等键），
   *       且**跟着计划一起落盘** ⇒ 重试时逐字复用（重试换键等于没有幂等 ✗）。
   *
   * options.supplierGroups：调用方（多货品引擎）**在调写入口之前**已经算好的那一份分组
   *   —— 优先用它；两边算出来的**供应商组不一致**时**当场 warn**（不静默挑一个 ✗），
   *   并按**草稿（= 真正要写的事实）**这一份继续（写谁就以谁为准）。
   */
  async ensurePostingPlan(taskId, task, options = {}) {
    if (task.posting_plan?.version === 1) return task.posting_plan;
    const draft = task.draft || {};
    const items = draft.items || [];
    if (!items.length) throw new Error('采购申请草稿没有任何明细，无法生成采购计划');
    const plan = {
      version: 1,
      batch_key: `purchase_batch:${taskId}`,
      // 批次号也只生成一次：重试时重新取号会变成一个已存在批次的新号。
      batch_no: draft.batch_no || (await this.nextBatchNo()),
      items: items.map((item, index) => ({
        // item_key 是「计划里第几条」的稳定标识，随计划一起持久化，
        // 因此重试时不会因为数组顺序变化而换键。
        item_key: `${taskId}:${index}`,
        request_key: `purchase_request:${taskId}:${index}`,
        // ⛔ `report_record_id`（「信息填写」那条报单记录）**已删除（2026-10-09）**：
        //    报单入口退场 ⇒ 这个字段没有任何读方，留着只会在日志/排查里误导。
        product_record_id: item.product_record_id,
        // ⭐ 2026-10-16（供应商拆分）：**每条明细自己的供应商也要冻结进计划** ——
        //   分组就是按它分的（明细没带才退回批次级那一个；两个都没有 ⇒ 落"没标注"桶 ✓）。
        //   ⚠️ 只管**分组/出图**，**不写表**：「采购明细.供应商」是公式列 /「采购主表.供应商」
        //      是她在表上维护的（代码只读不写 ✗）——分组落在"每组一张报货单"上 ✓。
        supplier_record_id: String(item.supplier_record_id || draft.supplier_record_id || ''),
        // 历史草稿可能带 `size: null`（采购退货那条链路，已退场）：这里保留 null，
        // 写入时**不写「尺码」字段**。不能写 Number(null)=0（0 会被尺码解析判成非法）。
        size: item.size === null || item.size === undefined ? null : Number(item.size),
        quantity: Number(item.quantity),
        // 行为按明细走（明细没带才退回批次级的那一个）。「报货信息.采购行为」是关联
        // 「行为管理」，出图/查询都要用它。
        behavior_record_id: item.behavior_record_id || draft.behavior_record_id || '',
      })),
    };
    // ⭐⭐ 供应商拆分：**同一个批次号下**按供应商分组（她选的 ⓐ）—— 组顺序 = 明细里第一次出现的顺序。
    const split = splitBySupplier({
      items: plan.items,
      batchNo: plan.batch_no,
      batchKey: plan.batch_key,
      taskId,
      config: this.supplierSplit,
    });
    // 计划里只留**组的身份与键**（不塞一份明细副本进本地任务文件 —— 明细已经在 `plan.items` 里 ✓）。
    plan.supplier_groups = split.groups.map((group) => ({
      supplier_record_id: group.supplier_record_id,
      supplier_key: group.supplier_key,
      group_key: group.group_key,
      document_key: group.document_key,
      indexes: group.indexes,
      detail_count: group.detail_count,
      pair_count: group.pair_count,
    }));
    // 调用方（引擎）也算过一遍 ⇒ **交叉核对**：不一致就是真 bug（比如两边读的明细不是同一份），
    // 如实吵一条，谁也别静默挑一个 ✗。写出去的那一份**以草稿为准**（写谁就以谁为准 ✓）。
    const supplied = Array.isArray(options.supplierGroups) ? options.supplierGroups : [];
    if (supplied.length) {
      const suppliedKeys = supplied.map((group) => String(group?.supplier_key || '')).join('|');
      if (suppliedKeys !== split.summary.supplier_keys.join('|')) {
        logWarn(this.supplierSplit.events.mismatch, {
          task_id: taskId, batch_no: plan.batch_no,
          supplied_supplier_keys: suppliedKeys,
          draft_supplier_keys: split.summary.supplier_keys.join('|'),
          note: '调用方在调写入口之前算的那一组 与 写入口按草稿算的这一组 对不上，按草稿写',
        });
      }
    }
    // 单供应商（今天绝大多数情况）**不打**这条 —— 免得日常日志被刷屏（她只关心"混了供应商"那种）✓
    if (split.groupCount > 1) {
      logInfo(this.supplierSplit.events.grouped, {
        task_id: taskId, batch_no: plan.batch_no, batch_count: split.batchCount,
        group_count: split.groupCount, supplier_keys: split.summary.supplier_keys,
        group_keys: split.summary.group_keys, policy: split.policy, stage: split.stage,
      });
    }
    const updated = await this.store.update(taskId, { posting_plan: plan, posting_stage: 'posting_plan_created' });
    return updated.posting_plan;
  },

  /**
   * **兜底**的取号（业务负责人 2026-10-07 把格式改成 `CGD-YYYYMMDD-NNNN`）。
   *
   * ⚠️ 正常路径**不走这里**：号在**入口**就按包生成并写回「信息填写」了
   *（见 ensureReportBatchNo）—— 所以归批、出图、写「报货批次」用的都是同一个号。
   * 这个方法只在"入口没写成"时兜底（入口读不到那条记录、没权限等），
   * 由 `ensurePostingPlan` 调用，**只生成、不写回**。
   *
   * ⚠️ 生成的号会落进「报货批次」的「报货批次号」，而生成器的计数**同时数**两张表
   *   （见 `PurchaseBatchNoGenerator` 文件头 ②），所以兜底路径占掉的号也不会被别人重发。
   * ⚠️ 走串行队列 + 生成器内部的"本进程已发集合"：即便是兜底，也不会连发两个同号。
   */
  async nextBatchNo() {
    const table = this.gateway.table('purchaseOrderBatch');
    if (!table.tableId) throw new Error('未配置「采购主表」的表 ID：FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID');
    return this.batchNoGenerator.runExclusive(async () => {
      const generated = await this.batchNoGenerator.next({ source: 'fallback' });
      return generated.batchNo;
    });
  },
};

module.exports = postingPlan;
