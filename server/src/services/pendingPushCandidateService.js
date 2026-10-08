// 「9 点待处理单推送」的**候选取数**（只读；一块只干一件事）。
//
// 为什么要单独一个 service（业务负责人 2026-10-08 的第一步）：
//   `SecondDeliveryService.listPendingDeliveries()` 现在被**两条**推送共用
//   —— 9 点待处理单推送，与「二次交付成交提醒」（`secondDeliveryService.sendDailyReminder`）。
//   她的新口径（见 `docs/push-blocks-caliber-2026-10-08.md`）是按
//   「**销售明细逐件** / **收款明细逐条**」取候选，与那一份"按销售主表聚合、按整单履约状态"
//   的口径**不是同一件事**。改那个方法两条推送都会变 ⇒ 只能给 9 点推送**单独取一条候选**。
//   ⇒ 本模块是那条候选；`listPendingDeliveries` **一个字都不动**。
//
// 三块的判据与取值口径全部在 `config/pendingPushCandidates`（配置先行；本文件里一行中文不写）。
// 三块的**渲染**（标题 / 段落 / 配色）不在这里 —— 这里只回答"哪些行该出现、每行有什么事实"。
//
// ── 与既有实现的复用关系（不新造第二份）──────────────────────────────────────
//   · 金额【预定】：`salesProgressService.progressFromRecords`（**已导出**，成交那条链路就是这么用的）
//     —— 把这一单的明细 + 收款明细喂进去，取 `pendingAmount`（= 成交额 − 已收 − 待平台结算）。
//   · 金额【现货待收】：那一条**收款明细自己的「收款金额」**（她的口径，不折算、不汇总）。
//   · 货号 / 颜色 / 尺码：`salesDetailItemFacts.itemFactsByDetail`（按**明细记录 id** 对齐）
//     + 调用方注入的 `loadItemIndex`（= `SecondDeliveryService.loadItemIndex`）与
//     `resolveSize`（= `SecondDeliveryService.resolveDetailSize`，走共享的尺码解析、有缓存）。
//   · 时间窗：「最近 7 天」，与那次提醒**同一个** `REMINDER_WINDOW_DAYS` 与
//     `isWithinLookupWindow` / `asDate`（`saleLookupService`），不另写一套日期算术。
//     【预定】按**销售明细的销售日**；【现货待收】按**收款明细的创建时间**（上海自然日）。
//   · 飞书读表偶发的 "Data not ready"（`1254607`）→ `withSalesReadRetry`（成交那条链路同款）。
//
// ── 缺字段怎么办（她的硬要求：**照推 + 记日志，绝不静默丢单**）─────────────────
//   · 一整单的金额算不出来（数据不自洽等）→ 这一单的行**照样出**，金额整段不渲染 + 一条 warn；
//   · 一条收款明细：关联的销售单读不出来 → 照样出一行（文字给"未读到货号/尺码"占位）+ warn；
//     交易类型读不出来 → **照样进候选**（宁可多显示一条，也不让一笔未收款消失）+ 一条 warn；
//   · 采购批次：报货日 / 录入数量读不出来 → 照样出这一批 + warn（渲染层给占位）。
//   ⚠️ 与"按判据排除"区别开：**读不到 ≠ 不符合判据**。读得到、判据不匹配的（例：
//      交易类型是`预定`的那条记录）才是真的不进候选，那一条记 info 便于对账。

const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { progressFromRecords } = require('./salesProgressService');
const { itemFactsByDetail } = require('./salesDetailItemFacts');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
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
    const warnings = { amountFailed: [], orphanPayment: [], tradeTypeUnreadable: [] };
    // ⚠️ 货号尺码是**增强**：索引读挂了只记一条 warn、这一轮没有货号尺码，
    //    **绝不让整条推送失败**（与 listPendingDeliveries 的 includeItems 同一档处理）。
    //    没有销售侧候选时**一次多余的读表都不发**。
    const facts = this.hasSalesCandidate(context, { now })
      ? await this.loadItemFacts(context)
      : new Map();
    const sales = this.reservationRows(context, { now, facts, warnings });
    const cash = this.cashRows(context, { now, facts, warnings });
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
    // 销售单 record id → 那一单的条目：现货待收那块要从**收款明细**反查它关联的单。
    const byEntryId = new Map(eligible.map((item) => [item.entry.record_id, item]));
    return { eligible, byEntryId, entryFields, detailFields, paymentFields };
  }

  /** 这一轮**有没有**销售侧候选（决定要不要去读货品表 / 尺码表 —— 那是额外请求）。 */
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

  /** 这一单的待收款（**唯一**口径：`progressFromRecords`）。算不出来 → `null`（金额整段不渲染）。 */
  resolveOrderAmount(item, context, warnings) {
    try {
      const progress = progressFromRecords(
        item.details, item.payments, context.detailFields, context.paymentFields,
      );
      return progress.pendingAmount;
    } catch (error) {
      // ⚠️ 数据不自洽（例：收款超过成交额）**不等于这笔单不该推** —— 照推、金额留空、留日志。
      warnings.amountFailed.push({ sales_entry_record_id: item.entry.record_id, error: error.message });
      return null;
    }
  }

  /**
   * ① 【预定】= 「销售明细」里 **履约状态 = 未交付** 的明细行，**逐件一行**。
   * 金额 = **该销售单号的待收款**（同一单的多行共用同一个数）。
   */
  reservationRows(context, { now, facts, warnings }) {
    const { eligible, detailFields } = context;
    const rows = [];
    for (const item of eligible) {
      const undelivered = item.details.filter((detail) =>
        textValue(detail.fields?.[detailFields.fulfillmentStatus]).trim() !== this.settings.deliveredStatus
        && isWithinLookupWindow(asDate(detail.fields?.[detailFields.soldAt]),
          { now, days: this.windowDays }));
      if (!undelivered.length) continue;
      const pendingAmount = this.resolveOrderAmount(item, context, warnings);
      for (const detail of undelivered) {
        rows.push({
          // 明细逐件一行 ⇒ 行身份 = 明细记录 id（落盘/日志排查用）。
          rowId: detail.record_id,
          salesEntryRecordId: item.entry.record_id,
          criterion: 'undelivered',
          facts: facts.get(detail.record_id) || null,
          pendingAmount,
          url: '',
        });
      }
    }
    return rows;
  }

  /**
   * ② 【现货待收】= 「收款明细」里 **收款状态 = 未收款** 且 **交易类型含「现货」**，一条一行。
   * 金额 = **那一条收款明细自己的「收款金额」**；文字里的货号/颜色/尺码取它**关联销售单下的明细**。
   */
  cashRows(context, { now, facts, warnings }) {
    const { eligible, paymentFields } = context;
    const rows = [];
    for (const item of eligible) {
      for (const payment of item.payments) {
        if (textValue(payment.fields?.[paymentFields.status]).trim() !== this.settings.unpaidPaymentStatus) continue;
        if (!isWithinLookupWindow(asDate(payment.fields?.[paymentFields.createdAt]),
          { now, days: this.windowDays })) continue;
        const match = this.matchesCashTradeType(payment, context);
        if (match.unknown) {
          // ⚠️ 读不到（那一列没映射 / 单元格为空 / 关联悬空）⇒ **照样进候选**，
          //    宁可多显示一条，也不让一笔未收款静默消失（她的硬要求）；汇总记一条 warn。
          warnings.tradeTypeUnreadable.push({
            payment_record_id: payment.record_id,
            trade_type_field: context.paymentFields?.tradeType || '',
          });
        } else if (!match.include) {
          // 读得到、判据不匹配（例：`预定`）⇒ **真的**不进候选；记 info 便于对账。
          logInfo('sales.pending_deal_push.candidate.payment_skipped', {
            payment_record_id: payment.record_id,
            sales_entry_record_id: item.entry.record_id,
            reason: 'trade_type_not_cash',
            trade_type: match.text,
          });
          continue;
        }
        // 一行 = **一条收款明细**，文字里并列它关联销售单下的明细（逐件的货号/颜色/尺码）。
        rows.push({
          rowId: payment.record_id,
          salesEntryRecordId: item.entry.record_id,
          criterion: 'delivered_unpaid',
          facts: (item.details || []).map((detail) => facts.get(detail.record_id) || null).filter(Boolean),
          pendingAmount: this.paymentAmount(payment, context),
          url: '',
        });
      }
    }
    return rows;
  }

  /**
   * 这条收款明细的「交易类型」算不算现货。
   * @returns {{ include: boolean, unknown: boolean, text: string }}
   *   · 读得到且**含**关键词 → `include:true`；
   *   · 读得到但**不含**       → `include:false`（那条记录**真的**不属于现货待收）；
   *   · 读不到（那一列没映射 / 单元格为空 / 关联悬空）→ `include:true` + `unknown:true`，
   *     由调用方汇总记一条 warn（**宁可多显示，也不静默丢单**）。
   */
  matchesCashTradeType(payment, context) {
    const fieldName = context?.paymentFields?.tradeType;
    const text = String(textValue(payment?.fields?.[fieldName]) || '').trim();
    if (!fieldName || !text) return { include: true, unknown: true, text };
    return { include: text.includes(this.settings.cashTradeTypeKeyword), unknown: false, text };
  }

  /** 一条收款明细的「收款金额」原样取用（她的口径）。读不出来 → `null`（金额整段不渲染）。 */
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
        errors: warnings.amountFailed.map((entry) => entry.error),
        hint: '这些单的金额算不出来（数据不自洽等）；**行照出、金额整段不渲染**，绝不静默丢单',
      });
    }
    if (warnings.tradeTypeUnreadable?.length) {
      logWarn('sales.pending_deal_push.candidate.trade_type_unreadable', {
        payment_record_ids: warnings.tradeTypeUnreadable.map((entry) => entry.payment_record_id),
        trade_type_field: warnings.tradeTypeUnreadable[0]?.trade_type_field || '',
        hint: '这些未收款记录的「交易类型」读不到（没映射 / 空值）；**按现货待收照推**，绝不静默丢单',
      });
    }
  }

  /** 报货日 → 上海自然日 `YYYY-MM-DD`（飞书自动字段；读不出来返回空串，由渲染层给占位）。 */
  formatReportedAt(value) {
    return formatReportedAtText(value);
  }
}

module.exports = { PendingPushCandidateService, REMINDER_WINDOW_DAYS };
