// 「9 点推送」的【团购券待结算】块 —— **取数 + 点击「确认到账」的落库**（一个 service 干一件事）。
//
// 业务负责人 2026-10-08 批准并逐字给的口径（见 docs/push-blocks-caliber-2026-10-08.md 第六节）：
//   「是收款明细里**待平台结算**的记录，**左栏说明**是按照 **5 个自然日**今日该到账的待结算金额，
//     **右栏**是用户的**确认按钮**，点击之后这笔待平台结算就会**变为已收款**」
//   「从收款明细里的**创建时间**开始算，比如创建时间是 1001，那么就是 1006 应该 1001 维度下的
//     所有待平台结算的总额……把这些记录状态的收款状态改为**已收款**，同时更新**收款时间**」
//   「**逾期未点的要展示**，展示的维度是**按照结算日**（今天应该结算多少 / 昨天应该结算多少）」
//   「团购券那笔的金额用券的「**平台结算款**」」
//
// 本模块只做两件事，**都不认识"卡片长什么样"**（渲染在 `PendingDealPushService` +
// `utils/pendingDealPushCard`，文案在 `config/voucherSettlement`）：
//   ① `listSettlements()` —— 只读：把「收款明细.收款状态 = 待平台结算」按**结算日**分组，
//      只留 `结算日 ≤ 今天` 的（今天 / 昨天 / 更早），金额逐笔取**券的平台结算款**；
//   ② `confirmSettlementDay(settleDay)` —— 按**结算日重新查**那一批（**不信任卡片上的旧名单**），
//      整批「待平台结算 → 已收款」+ 写「收款时间 = 点击那一刻」，**幂等**。
//
// ── 为什么写在这条链路上（分工）────────────────────────────────────────────────
//   · 「哪些行该推」= `PendingPushCandidateService`（另一个 service）——它管销售两块 + 采购，
//     **一个字都没改**；这一块是**新的一块**，自己取数（她的口径与那两块不同：按**结算日**聚合，
//     不是按销售单号）。
//   · 「写库」= **复用** `PaymentService.settlePlatformReceipt`（**不重写**）：状态 → 已收款、
//     补 `receivedAt`、补方向，这三件事只有那一处实现。本模块只负责"哪一批、什么时候写"。
//
// ── 缺字段怎么办（她的硬要求：**不静默、不编数**）────────────────────────────────
//   · 券解析不到（名字里没有价 / 券表里没有这一档 / 没配券表）⇒ **退回该笔「收款金额」**
//     + 一条 warn（`voucher_settlement.amount.fallback`）；金额**读不出来**才整段给占位；
//   · 「创建时间」读不出来 ⇒ 那一条**照样进候选**，按**今天**当结算日 + 一条 warn
//     （`voucher_settlement.created_at_unreadable`）——宁可多显示一行，也不让一笔待结算消失；
//   · 券表整表读挂了 ⇒ 全部走"退回收款金额"那条，**不静默丢笔**。

const { textValue } = require('./v1BitableGateway');
const { PaymentService } = require('./paymentService');
// 券目录的**取值口径**（售价 / 面值 / 平台结算款 / 只在售）由 `config/groupBuyVouchers` 与
// `config/v1BitableSchema` 定义；本模块不写死券种，也不猜价。
// ⚠️ **刻意不用 `findVoucher`**：那个函数按「**售价 + 面值**」两把钥匙匹配，
//    而这里能从「收款方式」名字里拿到的**只有售价**（名字形如 `抖音代金券（89.9）`，
//    没有面值）。拿它去配会得到 `售价|NaN` 而恒不命中（试过，会把每一笔都退回收款金额）。
//    所以这里按**售价**匹配 —— 真表上只有 89.9 / 49.9 两档，售价本身就能区分。
const { toCents } = require('../config/groupBuyVouchers');
const {
  resolveVoucherSettlementConfig, paymentFieldNames, voucherFieldNames,
} = require('../config/voucherSettlement');
const { shanghaiDayKey, asDate } = require('./saleLookupService');
const { logInfo, logWarn } = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;

/** 把模板里的 `{名字}` 换成值（认不出来的占位符在 config 里**启动时**就拦下了）。 */
const fillTemplate = (template, values) => String(template ?? '')
  .replace(/\{([^{}]*)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])));

/**
 * `核销日 + N 个自然日` = 结算日。
 *
 * 两条口径都要**按上海自然日**做（门店按上海时间营业，线上服务器是 UTC）：
 *   ① 核销日 = 「收款明细.创建时间」的上海自然日（`shanghaiDayKey`，与取数那边同一处实现）；
 *   ② 「+ N 天」按自然日加（不是 +N×24 小时）—— 她说的是"1001 → 1006"。
 */
const addDays = (dayKey, days) =>
  shanghaiDayKey(new Date(Date.parse(`${dayKey}T00:00:00+08:00`) + Number(days) * DAY_MS));

/** 两个上海自然日键之间差几天（`2026-10-05` - `2026-10-02` = 3）。 */
const dayDiff = (fromDayKey, toDayKey) =>
  Math.round((Date.parse(`${toDayKey}T00:00:00+08:00`) - Date.parse(`${fromDayKey}T00:00:00+08:00`)) / DAY_MS);

/** 金额显示：两位小数 + 币种符号（口径在 config，本文件不写死 `¥`）。 */
const formatAmount = (value, symbol) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${symbol}${number.toFixed(2)}`;
};

class VoucherSettlementService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('VoucherSettlementService 需要 gateway');
    this.gateway = options.gateway;
    this.settings = options.settings || resolveVoucherSettlementConfig();
    // 「待平台结算 → 已收款」那一下**只经 PaymentService**（复用，不重写语义）。
    this.payments = options.payments || new PaymentService({ gateway: this.gateway });
    // 「现在」可注入：单测的日期断言不能跟着真实时钟走。
    this.now = options.now || (() => new Date());
    this.settleDays = Number(options.settleDays ?? this.settings.settleDays);
  }

  fieldNames() {
    return {
      payment: { ...paymentFieldNames(), ...(this.settings.paymentFields || {}) },
      voucher: { ...voucherFieldNames(), ...(this.settings.voucherFields || {}) },
    };
  }

  /**
   * 只读：`收款明细.收款状态 = 待平台结算` 的**全部**记录（含逾期未确认的）。
   * ⚠️ 不做时间窗过滤 —— 逾期的（结算日 < 今天）**必须一起回来**，否则那笔账再也不会出现。
   */
  async loadPendingPayments() {
    const { payment } = this.fieldNames();
    const records = await this.gateway.listAll('paymentRecord');
    const pending = [];
    for (const record of records || []) {
      const status = textValue(record.fields?.[payment.status]).trim();
      if (status !== this.settings.pendingStatus) continue;
      pending.push(record);
    }
    return pending;
  }

  /**
   * 「收款明细.收款方式」的名字里那个价 —— 售价和面值都没写在名字里，只有那个价。
   * 取**最后一个**数字（可配正则，默认即可；`抖音代金券（89.9）` → 89.9）。
   * 取不到 → `null`（调用方退回「收款金额」+ warn，**绝不编一个价**）。
   */
  priceFromMethod(methodName) {
    const text = String(methodName ?? '').trim();
    if (!text) return null;
    let match = null;
    try {
      match = text.match(new RegExp(this.settings.pricePattern));
    } catch (error) {
      logWarn('voucher_settlement.price_pattern.invalid', {
        pattern: this.settings.pricePattern, error: error.message,
      });
      return null;
    }
    if (!match) return null;
    const value = Number(match[1] ?? match[0]);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * 「团购券管理」目录（只取在售）——与 `LarkMvpService.listGroupBuyVouchers` **同一套映射**。
   * 读挂了 ⇒ 空目录：这一轮所有笔都走"退回收款金额"，**不静默丢笔**（见文件头）。
   */
  async loadVoucherCatalog() {
    const table = this.gateway.table?.('groupBuyVoucher');
    if (!table?.tableId) return { vouchers: [], error: 'table_unconfigured' };
    const fields = this.fieldNames().voucher;
    try {
      const records = await this.gateway.listAll('groupBuyVoucher');
      const vouchers = (records || [])
        .map((record) => ({
          recordId: record.record_id,
          name: textValue(record.fields?.[fields.name]).trim(),
          status: textValue(record.fields?.[fields.status]).trim(),
          purchasePrice: Number(record.fields?.[fields.purchasePrice]),
          faceValue: Number(record.fields?.[fields.faceValue]),
          settlementAmount: Number(record.fields?.[fields.settlementAmount]),
        }))
        .filter((voucher) => voucher.status === this.settings.voucherOnSaleStatus
          && Number.isFinite(voucher.purchasePrice)
          && Number.isFinite(voucher.faceValue)
          && Number.isFinite(voucher.settlementAmount));
      return { vouchers, error: '' };
    } catch (error) {
      logWarn('voucher_settlement.voucher_catalog.failed', {
        error: error.message,
        hint: '券目录读挂了 ⇒ 这一轮所有笔都退回「收款金额」；**不静默丢笔**',
      });
      return { vouchers: [], error: error.message };
    }
  }

  /**
   * 按**售价**在券目录里找那一张券（名字里只有售价，没有面值 —— 见文件头的说明）。
   * 用**分**比（避免 89.9 这类小数在浮点上比不相等）；找不到返回 `undefined`（**不拿别的券顶替**）。
   */
  findVoucherByPrice(catalog, price) {
    const wanted = toCents(price);
    return (catalog || []).find((voucher) => toCents(voucher.purchasePrice) === wanted);
  }

  /**
   * 一条收款明细的**结算金额**：优先取它那张券的「平台结算款」，解析不到就**退回「收款金额」**。
   *
   * 定位链路（她的口径）：收款方式名字里的价 → 按**售价**匹配「团购券管理」→ 取该券**平台结算款**。
   * @returns {{ amount:number|null, source:'voucher'|'receipt', reason:string }}
   *   · `source:'voucher'` —— 取到了券的平台结算款（口径正解）；
   *   · `source:'receipt'` —— 解析不到券，退回这笔的「收款金额」（**记 warn**）；
   *   · `amount:null`      —— 两边都读不出来（渲染层给占位）。
   */
  resolveAmount(record, payment, catalog) {
    const methodName = textValue(record.fields?.[payment.method]).trim();
    const receiptAmount = this.numberOrNull(record.fields?.[payment.amount]);
    const price = this.priceFromMethod(methodName);
    if (price === null) {
      return { amount: receiptAmount, source: 'receipt', reason: methodName ? 'no_price_in_method' : 'method_empty' };
    }
    const voucher = this.findVoucherByPrice(catalog.vouchers || [], price);
    if (!voucher) {
      return { amount: receiptAmount, source: 'receipt', reason: 'voucher_not_found' };
    }
    if (!Number.isFinite(voucher.settlementAmount)) {
      return { amount: receiptAmount, source: 'receipt', reason: 'settlement_amount_unreadable' };
    }
    return { amount: voucher.settlementAmount, source: 'voucher', reason: '' };
  }

  numberOrNull(value) {
    const raw = textValue(value).trim();
    if (raw === '') return null;
    const number = Number(raw.replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  /**
   * 一条收款明细的**结算日**：`创建时间(上海日) + N 个自然日`。
   * 创建时间读不出来 ⇒ 当**今天**（照进候选）+ `unreadable:true`（调用方记 warn）。
   */
  settlementDayOf(record, payment, now) {
    const createdAt = asDate(record.fields?.[payment.createdAt]);
    if (!createdAt) {
      return { settleDay: shanghaiDayKey(now), unreadable: true };
    }
    return { settleDay: addDays(shanghaiDayKey(createdAt), this.settleDays), unreadable: false };
  }

  /**
   * 只读：按**结算日**分组的待结算（**一行 = 一个结算日**），只留 `结算日 ≤ 今天`。
   *
   * @returns {Promise<{rows:Array,pendingRowCount:number,totalAmount:number}>}
   *   `rows` 已按**结算日倒序**（最近的在前）：`{ settleDay, isToday, overdueDays, count,
   *   totalAmount, amountKnown, records:[payment_record_id], warnings }`。
   */
  async listSettlements({ now = this.now() } = {}) {
    const { payment } = this.fieldNames();
    const todayKey = shanghaiDayKey(now);
    const records = await this.loadPendingPayments();
    if (!records.length) return { rows: [], pendingRowCount: 0, totalAmount: 0 };
    const catalog = await this.loadVoucherCatalog();
    const groups = new Map();
    const warnings = { amountFallback: [], createdAtUnreadable: [] };
    for (const record of records) {
      const { settleDay, unreadable } = this.settlementDayOf(record, payment, now);
      if (unreadable) {
        warnings.createdAtUnreadable.push({
          payment_record_id: record.record_id,
          created_at_field: payment.createdAt || '',
        });
      }
      if (settleDay > todayKey) continue; // 还没到结算日的**不显示**（她的口径：结算日 ≤ 今天）
      const resolved = this.resolveAmount(record, payment, catalog);
      if (resolved.source === 'receipt' && resolved.reason !== 'method_empty') {
        warnings.amountFallback.push({
          payment_record_id: record.record_id,
          method: textValue(record.fields?.[payment.method]).trim(),
          reason: resolved.reason,
        });
      }
      const group = groups.get(settleDay) || {
        settleDay, count: 0, totalAmount: 0, amountKnown: true, records: [],
      };
      group.count += 1;
      group.records.push(record.record_id);
      if (resolved.amount === null) group.amountKnown = false;
      else group.totalAmount += resolved.amount;
      groups.set(settleDay, group);
    }
    this.logWarnings(warnings, { todayKey, pendingCount: records.length });
    const rows = [...groups.values()]
      .map((group) => ({
        ...group,
        // 金额按两位小数落定（分）——否则 85.4 + 47.4 会留一串浮点尾巴。
        totalAmount: Math.round(group.totalAmount * 100) / 100,
        isToday: group.settleDay === todayKey,
        overdueDays: Math.max(0, dayDiff(group.settleDay, todayKey)),
      }))
      // ⭐ 排序 = **结算日倒序**（最近的在前：「今天 / 昨天 / 更早」就是这么读的）。
      .sort((left, right) => (left.settleDay < right.settleDay ? 1 : (left.settleDay > right.settleDay ? -1 : 0)));
    return {
      rows,
      pendingRowCount: records.length,
      totalAmount: Math.round(rows.reduce((sum, row) => sum + row.totalAmount, 0) * 100) / 100,
    };
  }

  /** 缺字段的日志**汇总成一条**（不是每笔一条，否则日志会被刷满）。 */
  logWarnings(warnings = {}, meta = {}) {
    if (warnings.amountFallback?.length) {
      logWarn('voucher_settlement.amount.fallback', {
        ...meta,
        fallback_count: warnings.amountFallback.length,
        payment_record_ids: warnings.amountFallback.map((entry) => entry.payment_record_id),
        methods: warnings.amountFallback.map((entry) => entry.method),
        reasons: warnings.amountFallback.map((entry) => entry.reason),
        hint: '「收款方式」名字里解析不到券（没有价 / 券表里没这一档）⇒ 这一笔退回它的「收款金额」；'
          + '**不静默、也不编一个价**。要按券的「平台结算款」算，请在「团购券管理」里配这一档券',
      });
    }
    if (warnings.createdAtUnreadable?.length) {
      logWarn('voucher_settlement.created_at_unreadable', {
        ...meta,
        payment_record_ids: warnings.createdAtUnreadable.map((entry) => entry.payment_record_id),
        created_at_field: warnings.createdAtUnreadable[0]?.created_at_field || '',
        hint: '「创建时间」读不到（没映射 / 空值）⇒ 这些笔按**今天**当结算日照进候选，'
          + '**绝不静默丢一笔待结算**',
      });
    }
  }

  /**
   * 「确认到账」：把那**一个结算日**的全部「待平台结算」→ **已收款** + 写「收款时间 = 点击那一刻」。
   *
   * 🔴 **不信任卡片上的旧名单**：这里**按结算日重新查一次**（卡片可能是昨天发的、名单早过期了）。
   * 🔴 **幂等**：按结算日重新查之后**一条 `待平台结算` 都没有** ⇒ 直接回
   *    「这一批已经确认过了」，**一个字节都不写**（连点两次只写一次）。
   *
   * @returns {Promise<{settleDay:string,confirmedCount:number,totalAmount:number,alreadySettled:boolean,
   *   failures:Array<{payment_record_id:string,error:string}>,notFoundDay:boolean}>}
   */
  async confirmSettlementDay(settleDay, { now = this.now(), correlation } = {}) {    const day = String(settleDay ?? '').trim();
    if (!day) throw new Error('缺少结算日 settle_day，无法确认到账');
    const { payment } = this.fieldNames();
    // ⚠️ 「点击那一刻」：一次点击里**所有笔用同一个时间戳**（同一批到账，收款时间不该有毫秒差）。
    const receivedAt = now instanceof Date ? now.getTime() : Number(now);
    const records = await this.loadPendingPayments();
    const batch = records.filter((record) =>
      this.settlementDayOf(record, payment, new Date(receivedAt)).settleDay === day);
    if (!batch.length) {
      logInfo('voucher_settlement.confirm.already_settled', {
        settle_day: day, pending_count: 0,
      });
      return {
        settleDay: day, confirmedCount: 0, totalAmount: 0,
        alreadySettled: true, failures: [], notFoundDay: true,
      };
    }
    const failures = [];
    let confirmedCount = 0;
    let totalAmount = 0;
    for (const record of batch) {
      const amount = this.numberOrNull(record.fields?.[payment.amount]);
      try {
        // ⚠️ 复用既有实现（**不重写语义**）：它自己会回查状态——
        //    已是「已收款」就原样返回、**不重复写**（这是幂等的最后一道）。
        // ⚠️ 关联键**逐笔给**（`payment_record_id` = 这一次写的是哪一条 + `settle_day` = 她点的那一行）：
        //    一次点击写一批，只有逐笔的 `record_id` 才能把 `bitable.record.updated` 对回业务。
        await this.payments.settlePlatformReceipt(record.record_id, receivedAt, {
          correlation: { ...(correlation || {}), payment_record_id: record.record_id, settle_day: day },
        });
        confirmedCount += 1;
        if (amount !== null) totalAmount += amount;
      } catch (error) {
        failures.push({ payment_record_id: record.record_id, error: error.message });
      }
    }
    // ⚠️ 合计金额**照实说**：用**真正写成功的那些笔**的「收款金额」合计（不是券的结算款 ——
    //    点完之后她要对的是"钱到账了多少"，与收款明细里那一列对齐；口径不一致时以明细为准）。
    const result = {
      settleDay: day,
      confirmedCount,
      totalAmount: Math.round(totalAmount * 100) / 100,
      alreadySettled: false,
      failures,
      notFoundDay: false,
    };
    if (failures.length) {
      logWarn('voucher_settlement.confirm.partial_failed', {
        settle_day: day, confirmed_count: confirmedCount, failed_count: failures.length,
        payment_record_ids: failures.map((entry) => entry.payment_record_id),
        errors: failures.map((entry) => entry.error),
      });
    } else {
      logInfo('voucher_settlement.confirm.settled', {
        settle_day: day, confirmed_count: confirmedCount, total_amount: result.totalAmount,
        payment_record_ids: batch.map((record) => record.record_id),
        received_at: receivedAt,
      });
    }
    return result;
  }

  /** 点完之后回的那句话（`config/voucherSettlement.messages.*`；**不静默**、失败带原因）。 */
  confirmationToast(result = {}) {
    const { messages = {}, currencySymbol = '' } = this.settings;
    const amount = formatAmount(result.totalAmount || 0, currencySymbol);
    if (!result.confirmedCount && !result.failures?.length) {
      return { type: 'info', content: fillTemplate(messages.already, { settleDay: result.settleDay }) };
    }
    if (result.failures?.length && !result.confirmedCount) {
      return {
        type: 'error',
        content: fillTemplate(messages.failed, { error: result.failures[0]?.error || '' }),
      };
    }
    if (result.failures?.length) {
      return {
        type: 'warning',
        content: fillTemplate(messages.partial, {
          count: result.confirmedCount,
          amount,
          failed: result.failures.length,
          error: result.failures[0]?.error || '',
        }),
      };
    }
    return {
      type: 'success',
      content: fillTemplate(messages.confirmed, {
        count: result.confirmedCount, amount, settleDay: result.settleDay,
      }),
    };
  }
}

module.exports = {
  VoucherSettlementService, addDays, dayDiff, formatAmount, fillTemplate,
};
