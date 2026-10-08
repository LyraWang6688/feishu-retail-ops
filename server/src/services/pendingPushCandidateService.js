// 「9 点待处理单推送」的**候选取数**（只读；一块只干一件事）。
//
// 为什么要单独一个 service（业务负责人 2026-10-08 的第一步）：
//   `SecondDeliveryService.listPendingDeliveries()` 现在被**两条**推送共用
//   —— 9 点待处理单推送，与「二次交付成交提醒」（`secondDeliveryService.sendDailyReminder`）。
//   她的口径（见 `docs/push-blocks-caliber-2026-10-08.md`）是按**行为编码 + 单号聚合**
//   取候选，与那一份"按销售主表聚合、按整单履约状态"的口径**不是同一件事**。
//   改那个方法两条推送都会变 ⇒ 只能给 9 点推送**单独取一条候选**。
//   ⇒ 本模块是那条候选；`listPendingDeliveries` **一个字都不动**。
//
// 三块的判据与取值口径全部在 `config/pendingPushCandidates`（配置先行；本文件里一行中文不写）。
// 三块的**渲染**（标题 / 段落 / 配色）不在这里 —— 这里只回答"哪些行该出现、每行有什么事实"。
//
// ── 与既有实现的复用关系（不新造第二份）──────────────────────────────────────
//   · 金额（**两块共用同一个口径**）：**该销售单号在「收款明细」里所有 `收款状态 = 未收款`
//     的「收款金额」之和**（业务负责人 2026-10-08 晚的口径）——
//     ⚠️ 不是"整单成交额 − 已收 − 待平台结算"（那是上一版用的 `progressFromRecords`），
//        也不是"某一条收款明细自己的金额"（那是上一版【现货待收】按条聚合时的取法）。
//   · 交易类型：**只认行为编码**（`SALE_PREPAID` / `SALE_CASH`，取值在
//     `config/pendingPushCandidates`）。真表上那两列形状不同 ——
//     销售明细是**关联「行为管理」**（格里是记录 id）、收款明细是**查表引用**（格里是 `{ text }`）——
//     两种都在 `matchesTradeType` 里收敛到同一个编码；中文↔编码的对照表只有
//     `config/salesMovements` 一处（本文件不写「现货 / 预定」）。
//   · 货号 / 颜色 / 尺码：`salesDetailItemFacts.itemFactsByDetail`（按**明细记录 id** 对齐）
//     + 调用方注入的 `loadItemIndex`（= `SecondDeliveryService.loadItemIndex`）与
//     `resolveSize`（= `SecondDeliveryService.resolveDetailSize`，走共享的尺码解析、有缓存）。
//   · 时间窗：「最近 7 天」，与那次提醒**同一个** `REMINDER_WINDOW_DAYS` 与
//     `isWithinLookupWindow` / `asDate`（`saleLookupService`），不另写一套日期算术。
//     【预定】按**销售明细的销售日**；【现货未收】按**收款明细的创建时间**（上海自然日）。
//   · 飞书读表偶发的 "Data not ready"（`1254607`）→ `withSalesReadRetry`（成交那条链路同款）。
//
// ── 聚合单位（2026-10-08 晚她的纠正，逐字：「**直接按照销售单号去进行聚合**」）─────────
//   · 两块都是**一张销售单一行**（`rowId` = 销售单 record id）；多件时把几件的
//     `货号 颜色 尺码` **并列在同一行的 `facts` 里**（渲染层用 `、` 连起来）；
//   · 同一单**多条未收款** ⇒ 仍然只有一行，金额是那些「未收款」的**合计**。
//
// ── 缺字段怎么办（她的硬要求：**照推 + 记日志，绝不静默丢单**）─────────────────
//   · 一整单的金额算不出来（有一条「未收款」的金额读不出来）→ 这一单的行**照样出**，
//     金额整段不渲染 + 一条 warn；
//   · 交易类型读不出来（那一列没映射 / 单元格为空 / 关联悬空）→ **照样进候选**
//     （宁可多显示一行，也不让一件货 / 一笔未收款消失）+ 一条汇总 warn；
//   · 货号 / 颜色 / 尺码取不到 → 那一行照出（渲染层给占位）+ 一条汇总 warn；
//   · 采购批次：报货日 / 录入数量读不出来 → 照样出这一批 + warn（渲染层给占位）。
//   ⚠️ 与"按判据排除"区别开：**读不到 ≠ 不符合判据**。读得到、判据不匹配的（例：
//      交易类型是 `SALE_CASH` 的那件明细，进不了【预定】）才是真的不进候选，
//      那一条记 info 便于对账。

const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { itemFactsByDetail } = require('./salesDetailItemFacts');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
// 「查表引用」形状的交易类型（收款明细那一列）怎么收敛成行为编码：中文↔编码的对照表
// **只有 `config/salesMovements` 一处**（关联形状走「行为管理」的「行为编码」，见 `matchesTradeType`）。
const { tradeTypeCodeFromLabel } = require('../config/salesMovements');
// 退过 / 换过 / 赔过的单**不进候选** —— 判据（唯一一处）在售后配置里，与成交那条链路共用。
const { isAfterSalesFulfillment } = require('../config/afterSales');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
// 「最近 7 天」的窗口口径与上海自然日工具：与「二次交付成交提醒」**同一处实现**。
const { asDate, isWithinLookupWindow } = require('./saleLookupService');
// 「报货日」在消息里的样子（上海自然日）：与渲染层**共用同一处实现**。
const { formatReportedAtText } = require('./reportedAt');
const { withSalesReadRetry } = require('./salesReadRetry');
const { resolvePendingPushCandidateConfig } = require('../config/pendingPushCandidates');
const { logInfo, logWarn } = require('../utils/logger');

// 与 `SecondDeliveryService.REMINDER_WINDOW_DAYS` 同名同值：两条推送的窗口口径必须一致
// （她定的是「最近 7 天」）。⚠️ 那个常量**没有导出**，所以这里显式声明一份 ——
// 将来要改窗口，**两处一起改**（或者把它提到一份共享配置里）。
const REMINDER_WINDOW_DAYS = 7;

class PendingPushCandidateService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('PendingPushCandidateService 需要 gateway');
    this.gateway = options.gateway;
    // 货号 / 颜色 / 尺码的事实用它那两张表的索引（整表各读一次，不是每件读一次）。
    this.secondDelivery = options.secondDelivery || null;
    this.settings = options.settings || resolvePendingPushCandidateConfig();
    this.windowDays = Number(options.windowDays) > 0 ? Number(options.windowDays) : REMINDER_WINDOW_DAYS;
    // 采购那半边（「报货批次」里 到货状态 = 未到货）；没注入就不产采购候选。
    this.purchasePending = options.purchasePending || null;
    // ⚠️ 名字与它要接的东西同名（`resolveDetailSize`）：注入的优先，否则从
    //    `secondDelivery.resolveDetailSize` 取（生产就是这一条）；都没有就自己按网关建
    //    （同一个类、同一套 30 秒缓存语义）。
    //    ⚠️ 曾经叫 `resolveSizeReference`，调用点却按 `secondDelivery.resolveDetailSize` 拿
    //    ⇒ 注入的那个**一次都没被调用**、尺码静默变空（由 `pendingPushCandidateCaliber`
    //    的「一单多件并列」那个用例抓出来的）。别把这个名字再拆开。
    this.resolveDetailSize = options.resolveDetailSize
      || (typeof options.secondDelivery?.resolveDetailSize === 'function'
        ? (detail, detailFields) => options.secondDelivery.resolveDetailSize(detail, detailFields)
        : null);
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway });
  }

  /**
   * 三块候选（**只读**）。一次调用里**整表各读一次**，两块销售候选共用同一批数据。
   * @param {{ now?: Date }} [options]
   * @returns {Promise<{ sales: Array, cash: Array, purchase: Array }>}
   *   · `sales` / `cash` —— 两个销售侧区块的**行**（`{ rowId, salesEntryRecordId, criterion,
   *     facts, pendingAmount, url }`）；行怎么分块由渲染层按 `criterion` 做。
   *   · `purchase` —— 原样转发 `PurchasePendingBatchService.listPendingBatches()` 的结果
   *     （那一处已经带上 报货日 / 录入数量）。
   */
  async listCandidates({ now = new Date() } = {}) {
    const context = await withSalesReadRetry(
      () => this.readSalesContext(), 'pending_push_candidates',
    );
    const warnings = { amountFailed: [], tradeTypeUnreadable: { details: [], payments: [] } };
    // ⚠️ 货号尺码是**增强**：索引读挂了只记一条 warn、这一轮没有货号尺码，
    //    **绝不让整条推送失败**（与 listPendingDeliveries 的 includeItems 同一档处理）。
    //    没有销售侧候选时**一次多余的读表都不发**。
    const hasCandidate = this.hasSalesCandidate(context, { now });
    const facts = hasCandidate ? await this.loadItemFacts(context) : new Map();
    // 交易类型是**关联 / 查表引用** ⇒ 关联形状要先读一次「行为管理」，把记录 id 换成
    // **行为编码**（判据只认编码，不认中文）。按文字就能认出来的那种形状**不读这张表**。
    const behaviorCodeById = hasCandidate ? await this.loadBehaviorCodeIndex(context) : new Map();
    const sales = this.reservationRows(context, { now, facts, behaviorCodeById, warnings });
    const cash = this.cashRows(context, { now, facts, behaviorCodeById, warnings });
    this.logWarnings(warnings);
    // ⚠️ 采购那半边**读表失败不许拖垮销售那半边**（销售是既有的、每天都在用的那条）：
    //    读失败只记 warn，当成"今天没有采购候选"（与改动前同一档处理）。
    let purchase = [];
    if (this.purchasePending) {
      try {
        purchase = await this.purchasePending.listPendingBatches();
      } catch (error) {
        logWarn('sales.pending_deal_push.purchase_candidates_failed', {
          error: error.message,
          ...(error?.response?.data?.code ? { code: error.response.data.code } : {}),
        });
      }
    }
    return { sales, cash, purchase };
  }

  /**
   * 要用的那几张表的事实，**整表各读一次**。
   *
   * ⚠️ 主表只保留**已入账**（`postedOf`）与**不含售后件**的：前者是既有候选的前提
   *    （未入账的单还没写明细，推了也没有货号），后者是业务负责人 2026-10-08 的明确口径
   *    （「不需要退货和换货的」）—— 判据从 `config/afterSales` 取，本文件不写第二份中文。
   * ⚠️ 不在这里判 7 天窗口：窗口是**逐明细 / 逐收款**的（判据不同），放在各自的切片里。
   */
  async readSalesContext() {
    const [entries, allDetails, allPayments] = await Promise.all([
      this.gateway.listAll('salesEntry'), this.gateway.listAll('salesDetail'),
      this.gateway.listAll('paymentRecord'),
    ]);
    const entryFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;

    const eligible = [];
    for (const entry of entries || []) {
      if (!isPosted(postedOf(entry, entryFields))) continue;
      const details = (allDetails || []).filter((record) =>
        linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(entry.record_id));
      const afterSales = details
        .map((record) => textValue(record.fields?.[detailFields.fulfillmentStatus]).trim())
        .filter((status) => isAfterSalesFulfillment(status));
      if (afterSales.length) {
        logInfo('sales.pending_deal_push.candidate.order_skipped', {
          sales_entry_record_id: entry.record_id,
          reason: 'after_sales_fulfillment',
          fulfillment_status: afterSales.join(','),
        });
        continue;
      }
      eligible.push({
        entry,
        details,
        payments: (allPayments || []).filter((record) =>
          linkedRecordIds(record.fields?.[paymentFields.salesEntry]).includes(entry.record_id)),
      });
    }
    return { eligible, entryFields, detailFields, paymentFields };
  }

  /**
   * 这一轮**有没有**销售侧候选（决定要不要去读货品表 / 尺码表 / 行为表 —— 那些是额外请求）。
   *
   * ⚠️ 它是**宽松的上界**（不判交易类型），不是真判据：真判据在 `reservationRows` / `cashRows`。
   *    为什么故意宽松：交易类型要先读「行为管理」才能判，而"要不要读那张表"正是这里决定的
   *    ⇒ 这里只能按**结构性**条件预判。宁可多读一次表，也不能因为判早了而**少读** ——
   *    那会让本该有货号尺码的行只剩占位。反过来（这里判 true、真判据判 false）只是白读一次。
   */
  hasSalesCandidate(context, { now }) {
    const { eligible, detailFields, paymentFields } = context;
    return eligible.some((item) => {
      const undeliveredInWindow = item.details.some((detail) =>
        textValue(detail.fields?.[detailFields.fulfillmentStatus]).trim() !== this.settings.deliveredStatus
        && isWithinLookupWindow(asDate(detail.fields?.[detailFields.soldAt]),
          { now, days: this.windowDays }));
      if (undeliveredInWindow) return true;
      return item.payments.some((payment) =>
        textValue(payment.fields?.[paymentFields.status]).trim() === this.settings.unpaidPaymentStatus
        && isWithinLookupWindow(asDate(payment.fields?.[paymentFields.createdAt]), { now, days: this.windowDays }));
    });
  }

  /**
   * 明细记录 id → 事实（货号 / 颜色 / 尺码）。
   *
   * ⚠️ 按**明细记录 id** 对齐，不按下标：取不到货号的那一件**不产出条目**，
   *    按下标对齐会把后面每一件都错位挂到前一行上（这是真实错误形态，不是假想）。
   */
  async loadItemFacts(context) {
    if (typeof this.secondDelivery?.loadItemIndex !== 'function') return new Map();
    let itemIndex = null;
    try {
      itemIndex = await this.secondDelivery.loadItemIndex();
    } catch (error) {
      logWarn('sales.pending_deal_push.candidate.items_index_failed', { error: error.message });
      return new Map();
    }
    const details = context.eligible.flatMap((item) => item.details || []);
    const byDetail = await itemFactsByDetail({
      details,
      detailFields: context.detailFields,
      itemIndex,
      resolveSize: (detail) => this.resolveSize(detail, context),
    });
    const facts = new Map();
    let unlabeled = 0;
    let missingSize = 0;
    for (const item of context.eligible) {
      for (const detail of item.details || []) {
        const entry = byDetail.get(detail.record_id);
        if (!entry) { unlabeled += 1; continue; }
        if (entry.missingSize) missingSize += 1;
        facts.set(detail.record_id, entry.item);
      }
    }
    if (unlabeled || missingSize) {
      logWarn('sales.pending_deal_push.candidate.items_incomplete', {
        unlabeled_item_count: unlabeled,
        missing_size_count: missingSize,
        hint: '有明细行取不到货号/配品名称，或鞋的尺码解析不出来；这些件只给占位，但那一行照出',
      });
    }
    return facts;
  }

  /**
   * 明细的尺码：优先用注入的那一个（= `SecondDeliveryService.resolveDetailSize`，与成交链路同一套）。
   * ⚠️ 注入的那个**签名就是** `(detail, detailFields)`（`secondDeliveryService` 里就是这么定义的），
   *    所以这里两处都读 `detail.fields[detailFields.size]`，不存在"读错那一格"的分叉。
   */
  async resolveSize(detail, context) {
    if (typeof this.resolveDetailSize === 'function') {
      return this.resolveDetailSize(detail, context?.detailFields);
    }
    try {
      const entry = await this.getSizeReferences()
        .resolveLinkedCell(detail?.fields?.[context?.detailFields?.size]);
      return entry?.size === undefined || entry?.size === null ? '' : String(entry.size);
    } catch (error) {
      const fallback = textValue(detail?.fields?.[context?.detailFields?.size]).trim();
      return /^[1-9]\d*$/.test(fallback) ? fallback : '';
    }
  }

  // ── 交易类型：只认**行为编码**（关联 / 查表引用两种形状都收敛到同一个编码）──────────

  /**
   * 「交易类型」那一格里的**可判定值**（记录 id 或 文字）。
   *
   * 真表上这一列不同表形状不同：
   *   · 销售明细 —— **关联「行为管理」**：格里是记录 id（`['rec…']` 或 `[{ record_ids, text }]`）；
   *   · 收款明细 —— **查表引用**（指到销售单那一侧）：格里是 `{ text }`（可能还带 `record_ids`）。
   * ⇒ 两种形状的"值"都收进来，由 `tradeTypeCodesOf` 各自收敛成**行为编码**。
   */
  tradeTypeValuesOf(cell) {
    if (cell === null || cell === undefined || cell === '') return [];
    const list = Array.isArray(cell) ? cell.flat(Infinity) : [cell];
    const values = [];
    for (const value of list) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') {
        for (const id of linkedRecordIds(value)) values.push(id);
        const text = textValue(value).trim();
        if (text) values.push(text);
        continue;
      }
      const raw = String(value).trim();
      if (raw) values.push(raw);
    }
    return values;
  }

  /**
   * 那一格 → **行为编码**集合：
   *   · 记录 id → 「行为管理」的「行为编码」（`loadBehaviorCodeIndex`）；
   *   · 文字     → `config/salesMovements` 的中文↔编码对照表（全仓唯一一处，本文件不写中文）。
   */
  tradeTypeCodesOf(cell, behaviorCodeById) {
    const codes = new Set();
    for (const raw of this.tradeTypeValuesOf(cell)) {
      const byId = behaviorCodeById?.get?.(raw);
      if (byId) { codes.add(byId); continue; }
      const code = tradeTypeCodeFromLabel(raw);
      if (code) codes.add(code);
    }
    return codes;
  }

  /** 有没有哪一格是"按文字认不出来"的（= 关联形状，要读「行为管理」才能换出编码）。 */
  needsBehaviorCodeIndex(context) {
    const { eligible, detailFields, paymentFields } = context;
    const unresolved = (cell) => this.tradeTypeValuesOf(cell)
      .some((raw) => !tradeTypeCodeFromLabel(raw));
    return eligible.some((item) =>
      (item.details || []).some((detail) => unresolved(detail.fields?.[detailFields.tradeType]))
      || (item.payments || []).some((payment) => unresolved(payment.fields?.[paymentFields.tradeType])));
  }

  /**
   * 「行为管理」的记录 id → 「行为编码」（**一次整表读**；只在真有候选、且格里确实是记录 id 时读）。
   * 读挂了 ⇒ 空表：那些格会被当成"判据读不到"，由各自的切片**照推 + warn**（绝不静默丢单）。
   */
  async loadBehaviorCodeIndex(context) {
    if (!this.needsBehaviorCodeIndex(context)) return new Map();
    try {
      const records = await this.gateway.listAll('behavior');
      const fields = this.gateway.table('behavior').fields;
      const index = new Map();
      for (const record of records || []) {
        const code = textValue(record.fields?.[fields.code]).trim();
        if (code) index.set(record.record_id, code);
      }
      return index;
    } catch (error) {
      logWarn('sales.pending_deal_push.candidate.behavior_index_failed', {
        error: error.message,
        hint: '「行为管理」读挂了 ⇒ 交易类型只能按文字认；按文字也认不出的那些格按"读不到判据"处理：照推 + warn',
      });
      return new Map();
    }
  }

  /**
   * 那一格「交易类型」算不算要的那一种（**按行为编码比**）。
   * @param {*} cell 「交易类型」单元格（关联 / 查表引用两种形状都认）
   * @param {string} wantedCode 要的行为编码（`config/pendingPushCandidates` 给的）
   * @returns {{ match: boolean, unknown: boolean, codes: string[] }}
   *   · 读得到且**含**目标编码 → `match:true`；
   *   · 读得到但**不含**       → `match:false`（那条记录**真的**不属于这一块）；
   *   · 读不到（那一列没映射 / 单元格为空 / 关联悬空）→ `match:true` + `unknown:true`，
   *     由调用方汇总记一条 warn（**宁可多显示，也不静默丢单**）。
   */
  matchesTradeType(cell, wantedCode, behaviorCodeById) {
    if (!this.tradeTypeValuesOf(cell).length) return { match: true, unknown: true, codes: [] };
    const codes = [...this.tradeTypeCodesOf(cell, behaviorCodeById)];
    if (!codes.length) return { match: true, unknown: true, codes };
    return { match: codes.includes(wantedCode), unknown: false, codes };
  }

  /**
   * 一张销售单的「未收款」合计 —— **两块共用的唯一金额口径**。
   * = 该单在「收款明细」里**所有** `收款状态 = 未收款` 的「收款金额」之和
   * （业务负责人 2026-10-08：「这笔销售单号对应的未收款金额」/「该销售单号下所有未收款的金额之和」）。
   * ⚠️ 不是"整单成交额 − 已收 − 待平台结算"，也不是"某一条收款明细自己的金额"。
   * 有一条金额读不出来 ⇒ 整段不渲染（`null`）+ 一条 warn，**行照出**。
   */
  sumUnpaidAmount(item, context, warnings) {
    const { paymentFields } = context;
    let total = 0;
    for (const payment of item.payments || []) {
      if (textValue(payment.fields?.[paymentFields.status]).trim() !== this.settings.unpaidPaymentStatus) continue;
      const amount = this.paymentAmount(payment, context);
      if (amount === null) {
        // ⚠️ 少算一笔也是错的（金额会偏小、看起来像"收得差不多了"）⇒ 整段不给，宁可留空。
        // ⚠️ 两块**共用**这个金额口径 ⇒ 同一单可能被算两次，日志**按单+笔去重**（不刷两遍）。
        const recorded = warnings.amountFailed.some((entry) =>
          entry.sales_entry_record_id === item.entry.record_id
          && entry.payment_record_id === payment.record_id);
        if (!recorded) {
          warnings.amountFailed.push({
            sales_entry_record_id: item.entry.record_id,
            payment_record_id: payment.record_id,
            error: 'unpaid_amount_unreadable',
          });
        }
        return null;
      }
      total += amount;
    }
    return total;
  }

  /**
   * ① 【预定】= 「销售明细」里 **交易类型 = 预定（`SALE_PREPAID`）** 且 **履约状态 ≠ 已交付**
   * 且**销售日在最近 7 天窗口内**的件；**一张销售单一行**（`rowId` = 销售单 record id）。
   *   · 文字：该单里**符合上述条件的那几件**的 `货号 颜色 尺码`（并列在同一行的 `facts` 里）；
   *   · 金额：**该销售单号的未收款合计**（`sumUnpaidAmount`）。
   */
  reservationRows(context, { now, facts, behaviorCodeById, warnings }) {
    const { eligible, detailFields } = context;
    const rows = [];
    for (const item of eligible) {
      const qualifying = [];
      for (const detail of item.details || []) {
        // 履约状态 ≠ 已交付（取值与 `salesProgressService` 同一档；本文件不写中文）。
        if (textValue(detail.fields?.[detailFields.fulfillmentStatus]).trim() === this.settings.deliveredStatus) {
          continue;
        }
        if (!isWithinLookupWindow(asDate(detail.fields?.[detailFields.soldAt]),
          { now, days: this.windowDays })) continue;
        const type = this.matchesTradeType(
          detail.fields?.[detailFields.tradeType], this.settings.prepaidTradeTypeCode, behaviorCodeById,
        );
        if (type.unknown) {
          // ⚠️ 读不到判据 ≠ 不符合判据 ⇒ **照进**（宁可多显示一件，也不让一件预定货消失）；汇总记 warn。
          warnings.tradeTypeUnreadable.details.push({
            detail_record_id: detail.record_id,
            trade_type_field: detailFields.tradeType || '',
          });
        } else if (!type.match) {
          // 读得到、判据不匹配（例：`SALE_CASH` = 现货那件）⇒ **真的**不进【预定】；记 info 便于对账。
          logInfo('sales.pending_deal_push.candidate.detail_skipped', {
            detail_record_id: detail.record_id,
            sales_entry_record_id: item.entry.record_id,
            reason: 'trade_type_not_prepaid',
            trade_type_codes: type.codes,
          });
          continue;
        }
        qualifying.push(detail);
      }
      if (!qualifying.length) continue;
      // ⭐ 聚合单位 = **一张销售单一行**（多件并列在同一行的 `facts` 里）。
      rows.push({
        rowId: item.entry.record_id,
        salesEntryRecordId: item.entry.record_id,
        criterion: 'undelivered',
        facts: qualifying.map((detail) => facts.get(detail.record_id) || null).filter(Boolean),
        pendingAmount: this.sumUnpaidAmount(item, context, warnings),
        url: '',
      });
    }
    return rows;
  }

  /**
   * ② 【现货未收】= 「收款明细」里 **交易类型 = 现货（`SALE_CASH`）** 且 **收款状态 = 未收款**
   * 且**创建时间在最近 7 天窗口内**的记录；**一张销售单一行**（同一单多条未收款 ⇒ 一行）。
   *   · 文字：该单的 `货号 颜色 尺码`（该单的明细，取法与上一版一致：整单明细并列）；
   *   · 金额：**该销售单号的未收款合计**（`sumUnpaidAmount`）。
   */
  cashRows(context, { now, facts, behaviorCodeById, warnings }) {
    const { eligible, paymentFields } = context;
    const rows = [];
    for (const item of eligible) {
      let matched = null;
      for (const payment of item.payments || []) {
        if (textValue(payment.fields?.[paymentFields.status]).trim() !== this.settings.unpaidPaymentStatus) continue;
        if (!isWithinLookupWindow(asDate(payment.fields?.[paymentFields.createdAt]),
          { now, days: this.windowDays })) continue;
        const type = this.matchesTradeType(
          payment.fields?.[paymentFields.tradeType], this.settings.cashTradeTypeCode, behaviorCodeById,
        );
        if (type.unknown) {
          // ⚠️ 读不到判据 ≠ 不符合判据 ⇒ **照进**（宁可多显示一笔，也不让一笔未收款消失）；汇总记 warn。
          warnings.tradeTypeUnreadable.payments.push({
            payment_record_id: payment.record_id,
            trade_type_field: paymentFields.tradeType || '',
          });
        } else if (!type.match) {
          // 读得到、判据不匹配（例：`SALE_PREPAID` = 预定那笔）⇒ **真的**不进【现货未收】；记 info 便于对账。
          logInfo('sales.pending_deal_push.candidate.payment_skipped', {
            payment_record_id: payment.record_id,
            sales_entry_record_id: item.entry.record_id,
            reason: 'trade_type_not_cash',
            trade_type_codes: type.codes,
          });
          continue;
        }
        matched = matched || payment;
      }
      if (!matched) continue;
      // ⭐ 聚合单位 = **一张销售单一行**（同一单多条未收款只出一行，金额是合计）。
      rows.push({
        rowId: item.entry.record_id,
        salesEntryRecordId: item.entry.record_id,
        criterion: 'delivered_unpaid',
        facts: (item.details || []).map((detail) => facts.get(detail.record_id) || null).filter(Boolean),
        pendingAmount: this.sumUnpaidAmount(item, context, warnings),
        url: '',
      });
    }
    return rows;
  }

  /** 一条收款明细的「收款金额」。读不出来 → `null`（金额整段不渲染，`sumUnpaidAmount` 处理）。 */
  paymentAmount(payment, context) {
    const raw = textValue(payment.fields?.[context.paymentFields.amount]).trim();
    if (raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  /** 缺字段的日志**汇总成一条/一类**（不是每行一条，否则日志会被刷满）。 */
  logWarnings(warnings = {}) {
    if (warnings.amountFailed?.length) {
      logWarn('sales.pending_deal_push.candidate.amount_unavailable', {
        order_count: warnings.amountFailed.length,
        sales_entry_record_ids: warnings.amountFailed.map((entry) => entry.sales_entry_record_id),
        payment_record_ids: warnings.amountFailed.map((entry) => entry.payment_record_id).filter(Boolean),
        errors: warnings.amountFailed.map((entry) => entry.error),
        hint: '这些单的金额算不出来（有一条「未收款」的金额读不出来）；**行照出、金额整段不渲染**，绝不静默丢单',
      });
    }
    const details = warnings.tradeTypeUnreadable?.details || [];
    const payments = warnings.tradeTypeUnreadable?.payments || [];
    if (details.length || payments.length) {
      logWarn('sales.pending_deal_push.candidate.trade_type_unreadable', {
        detail_record_ids: details.map((entry) => entry.detail_record_id),
        payment_record_ids: payments.map((entry) => entry.payment_record_id),
        trade_type_field: (details[0] || payments[0])?.trade_type_field || '',
        hint: '这些记录的「交易类型」读不到（没映射 / 空值 / 关联悬空）；**按各自那一块照推**，绝不静默丢单',
      });
    }
  }

  /** 报货日 → 上海自然日 `YYYY-MM-DD`（飞书自动字段；读不出来返回空串，由渲染层给占位）。 */
  formatReportedAt(value) {
    return formatReportedAtText(value);
  }
}

module.exports = { PendingPushCandidateService, REMINDER_WINDOW_DAYS };
