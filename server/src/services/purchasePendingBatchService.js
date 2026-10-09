const { textValue } = require('./v1BitableGateway');
const { buildSalesThreadLink } = require('../config/salesThreadLink');
const { resolvePurchaseArrivalStatusConfig } = require('../config/purchaseArrivalStatus');
const { logInfo, logWarn } = require('../utils/logger');

// 「**还没到货**的报货批次」—— 9 点推送【采购】区的候选来源。
//
// 业务负责人的口径（逐字，2026-10-07）：
//   「你每天 9 点发通知的时候，看未到货的情况就**直接去那个表里查**，
//    然后再把消息**深链**发到用户群里」
// ⇒ 候选判据 = 「报货批次」表里 **到货状态 = 未到货**（配置里的那个取值，不写死中文）。
//
// 这个 service 只干一件事：**把"该推哪些批次"的事实查出来**。
// 它不拼文案、不发消息、不认识"9 点"——那些都是 `PendingDealPushService` 的事
//（模块化：换推送形式不影响这里，换候选口径也不影响那边）。
//
// ── 三个字段各从哪来（核过再写，**取不到就不显示，绝不编**）──────────────────
//   · 批次号   ：「报货批次.报货批次号」自己那一列；
//   · 供应商   ：⭐ **「报货批次.供应商」自己那一列**（2026-10-09 改）。
//                ⚠️ 原先是从「信息填写」里同批次的记录上取 —— 那张表被业务负责人
//                **整个删掉**了，而她在「报货批次」上**新加的那一列「供应商」**
//                （SingleLink → 供应商管理）本来就是为这件事加的 ⇒ 这里改读它。
//                好处：**零额外请求**（关联单元格自带被关联记录的主字段文本）、
//                且不再跨表。一格可能多个 ⇒ 返回**去重后的数组**，怎么拼是渲染层的事。
//   · 深链     ：本地映射 `data/purchase_group_messages/`（`chat_id` + `thread_id`）
//                → 拼话题深链（`config/salesThreadLink` 那条**销售侧现役**的格式）。
//                ⚠️ **不是** `client/message/link?message_id=` 那一种（实测拿不到）。
//                拿不到就留空 —— 由渲染层决定"照发 + 脚注"，**绝不因此漏掉候选**。
class PurchasePendingBatchService {
  constructor({ gateway, batchLocator, settings } = {}) {
    if (!gateway) throw new Error('PurchasePendingBatchService 需要 gateway');
    this.gateway = gateway;
    this.batchLocator = batchLocator || null;
    this.settings = settings || resolvePurchaseArrivalStatusConfig();
  }

  /** 「未到货」那个取值（配置来的，不是中文字面量）。 */
  get pendingStatus() {
    return this.settings.pending;
  }

  /**
   * 一条「报货批次」记录上的供应商名（SingleLink；可能一格多个、可能一格没有）。
   * ⚠️ **去重、保序**：关联单元格里同一个供应商可能连着出现（历史数据 / 多次关联），
   *    直接拼会把「金猴、金猴、奥康」原样发给她。去重在这里做一次，渲染层不必再管。
   */
  supplierLabelsOf(record, table) {
    const raw = textValue(record?.fields?.[table?.fields?.supplier]);
    const labels = String(raw || '').split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean);
    const unique = [];
    for (const label of labels) if (!unique.includes(label)) unique.push(label);
    return unique;
  }

  /**
   * 候选批次（**只读**）：
   * @returns {Promise<Array<{ batchNo: string, recordId: string, suppliers: string[],
   *   reportedAt: (number|string|''), quantity: string }>>}
   *
   * ⭐ 2026-10-08 晚（业务负责人逐字）：「这里的文字说明，包括**供应商和创建时间以及报货数量**」，
   *    补充口径把两个名字钉死：「采购数量用**「录入数量」**」、时间那一列的真表名是**「报货日」**
   *    （飞书自动字段，schema 语义键 `createdAt`）。
   *    ⇒ 这里**只多带两个字段**（`reportedAt` 原始值、`quantity` 文本），
   *      「怎么显示 / 读不到给不给占位」是渲染层的事（模块化：换推送形式不影响这里）。
   *    ⚠️ 两个字段都**只读**，且**读不到不算"这一批不该推"** —— 照出（她那句"绝不静默丢单"）。
   */
  async listPendingBatches() {
    const table = this.gateway.table('purchaseOrderBatch');
    const statusField = table?.fields?.arrivalStatus;
    const batchField = table?.fields?.batchNo;
    if (!statusField || !batchField) return [];
    const records = await this.gateway.listAll('purchaseOrderBatch');
    const pending = (records || []).filter((record) => {
      const value = textValue(record?.fields?.[statusField]).trim();
      return value === this.pendingStatus;
    });
    if (!pending.length) return [];
    return pending.map((record) => {
      const batchNo = textValue(record?.fields?.[batchField]).trim();
      return {
        batchNo,
        recordId: record?.record_id || '',
        // ⭐ 供应商就地取（同一行、同一份已读数据）——**不**再为它多读一张表。
        suppliers: this.supplierLabelsOf(record, table),
        // 报货日（原值；格式化与"读不到怎么办"在渲染层）。
        reportedAt: record?.fields?.[table?.fields?.createdAt] ?? '',
        // 录入数量（表里的文本 / 数字都取成文本；读不到是空串）。
        quantity: textValue(record?.fields?.[table?.fields?.quantity]).trim(),
      };
    }).filter((item) => item.batchNo);
  }

  // ⛔ `loadSupplierIndex`（整表读「信息填写」、按批次号建索引）**已删除（2026-10-09）**：
  //   供应商现在就在批次行上（`supplierLabelsOf` 就地取）。**不再有任何跨表请求**。
  //   ⚠️ 连带删掉的是那条 `sales.pending_deal_push.purchase_supplier_index_failed` 日志
  //      —— 它监视的那次读表已经不存在了。

  /**
   * 这一批的深链素材（本地映射 → 话题深链）。
   *
   * ⚠️ 只**返回素材**，不决定"显示不显示"：真正的取值交给 `LarkMessageLinkResolver`
   *   （与销售侧**同一个**解析器：本地存的 → 现查 `message_app_link` → 都没有就空）。
   * ⚠️ 映射里同一批次可能有多条（图一条 + 文字一条）：挑**第一个同时有 chat_id 与 thread_id** 的。
   * ⚠️ 映射**整目录只读一次**（`linkIndex`），逐条查会把同一份目录读 N 遍。
   */
  resolveThreadLinkFrom(linkIndex, batchNo) {
    const records = linkIndex.get(batchNo) || [];
    const usable = records.find(
      (record) => String(record?.chat_id || '').trim() && String(record?.thread_id || '').trim(),
    );
    if (!usable) {
      if (records.length) {
        logInfo('sales.pending_deal_push.purchase_link.unmapped', {
          batch_no: batchNo, mapping_count: records.length,
        });
      }
      return { mapped: false, threadLink: '', messageId: '', threadId: '', chatId: '' };
    }
    return {
      mapped: true,
      // 她给的那条话题深链格式（与销售侧**同一个** config，缺 chat/thread 就返回空串）。
      threadLink: buildSalesThreadLink({ chatId: usable.chat_id, threadId: usable.thread_id }),
      messageId: usable.message_id || '',
      threadId: usable.thread_id || '',
      chatId: usable.chat_id || '',
    };
  }

  /** 批次号 → 群消息映射记录（整目录读一次）。读不到就空索引（**不抛**：推送不被它拖死）。 */
  async loadLinkIndex() {
    const index = new Map();
    if (!this.batchLocator) return index;
    let records = [];
    try {
      records = typeof this.batchLocator.listGroupMessages === 'function'
        ? await this.batchLocator.listGroupMessages()
        : [];
    } catch (error) {
      logWarn('sales.pending_deal_push.purchase_link.mapping_lookup_failed', { error: error.message });
      return index;
    }
    for (const record of records || []) {
      const batchNo = String(record?.batch_no || '').trim();
      if (!batchNo) continue;
      const current = index.get(batchNo) || [];
      current.push(record);
      index.set(batchNo, current);
    }
    return index;
  }
}

module.exports = { PurchasePendingBatchService };
