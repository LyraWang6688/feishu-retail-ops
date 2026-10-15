'use strict';

/**
 * 2026-10-14（业务负责人口径）：「这个不应该是 if else，而是用配置文件的思路」。
 *
 * 把「全付 / 部分付 / 未付」的**判定**从 `services/scanWriteService.js` 的 if 链抽成
 * **一份表 + 一个纯函数**。三步走，本文件是**第 1 步（只做加法）**：
 *   ①【本文件】表 + `resolveSettlement()`（纯函数，可测）；
 *   ②【本文件】AC（含"换配置即换行为"）；
 *   ③ 之后才把 service 的 `:886-965` 换成"调 resolver + 按 action 分支" ——
 *      🔴 那时每个 fail code 的 `code` / `message` / 日志事件名 / `extra` 形状**逐字保留**。
 *
 * 三条硬规矩：
 *   1. **判据显式枚举/布尔**（不许 `|| fallback` ✗ —— 空串能关掉才是可配）；
 *   2. **文案只给 `labelKey`**，状态值只引用**语义键**（`full`/`partial`/`unpaid`；
 *      真正的取值真源在 `config/scanWrite.js` 的 `PAYMENT_STATUS`）⇒ 本文件**没有中文字面量**；
 *   3. **一份真源**：规则只在这里；将来 service 里那串 if **必删**（否则两份会漂）。
 *
 * ⚠️ 逐处按**代码**核出来的（不是按草案抄的）：
 *   · 「全付 + 没收款行」是**两种**：哪儿都没钱（收款行空 **且** 每件实收全空）⇒ `whenNoMoneyAtAll` = **block**；
 *     没有收款行但**实收有值** ⇒ `whenMissingRows` = **degrade → 未付**（她 2026-10-11 点头过的口径，不许改）；
 *   · `amount_mismatch` **两个 site**：全付两边不等、以及"已收 > 每件实收合计"（部分付/未付都可能撞）
 *     ⇒ 后者抽成共享的 `overpaid` 规则；
 *   · 一共 **4 个 fail code**：`full_without_money` · `amount_mismatch` · `partial_amount_missing` ·
 *     `partial_amount_mismatch`；
 *   · 「未付」在本表里 = `action: 'pending'`（**本表只用来判 block / 档位**）——
 *     ⚠️ 2026-10-16 晚**注释成对更正**（改前逐字 → 改后逐字 → 依据）：
 *       改前逐字：「「未付」= **状态未付 + 不写欠款行**（`owedCents = 0`）⇒ 这里叫 `action: 'pending'`（语义不变）」
 *       改后逐字：「「未付」= `action: 'pending'`；**差额不在这里算、也不在这里判** ——
 *         本表的 `owedCents` **一个消费者都没有**（只读 `action`/`code`/`reason`，见 `routes/scanPage.js`）；
 *         真正的差额 = `每件实收合计 − 已收合计`，由 `services/scanWriteService.js` 与
 *         `services/salesOrderService.js` 算 ⇒ **未付（本次付 0）也照补那条【未收款】**
 *         （差额 = 累计）」
 *       依据 = 她 2026-10-14 逐字「**只要本次付的金额小于累计的，那么差额都是未收款，
 *         包括本次付款为 0**」＋ 她 2026-10-16 晚裁定「**客户少付 ⇒ 自动记一条【未收款】（差额）**」。
 *     ⇒ 表的**取值一个字没改**（判据没放宽 ✗）—— 只是把"不写欠款行"这句**与实现相反**的注释更正 ✓
 *       （新口径的真源是纯函数 `autoModeOf()` 的 `owedCents` ＋ 落库那一层）。
 *   · ⚠️ **`SUBMIT_WRITES` 故意没有**：`scanWriteService` 这段**没有任何"按交易类型决定写几处"的分支**
 *     （库存/入库在别的链路决定）⇒ 加了就是"没人读的假真源" ✗。
 */

/** 三档付款（语义键；中文取值在 `config/scanWrite.js` 的 `PAYMENT_STATUS`）。 */
const PAY_MODES = Object.freeze(['full', 'partial', 'unpaid']);

/** 「已收 > 每件实收合计」这条在**部分付与未付**都可能撞 ⇒ 抽成共享规则（同一个 code）。 */
const OVERPAID = Object.freeze({ action: 'block', reason: 'amount_mismatch', code: 'amount_mismatch' });

const SETTLEMENTS = Object.freeze({
  full: Object.freeze({
    labelKey: 'paymentStatusFull',
    requirePaymentRows: true,
    // 哪儿都没钱（收款行空 **且** 每件实收全空）⇒ 直接拦住（`:886` full_without_money）
    whenNoMoneyAtAll: Object.freeze({ action: 'block', reason: 'full_without_money', code: 'full_without_money' }),
    // 没有收款行但实收有值 ⇒ **降级成未付**（`:898-899`；只在上面那条之后判）
    whenMissingRows: Object.freeze({ action: 'degrade', to: 'unpaid', reason: 'full_without_payment_rows' }),
    // 填了收款行 ⇒ 两边必须相等（`:900-910`）
    whenAmountMismatch: Object.freeze({ action: 'block', reason: 'amount_mismatch', code: 'amount_mismatch' }),
  }),
  partial: Object.freeze({
    labelKey: 'paymentStatusPartial',
    requirePaymentRows: true,
    requirePositiveAmount: true,
    // 资金区"实付多少"必须填（`:916-935`）
    whenMissingAmount: Object.freeze({ action: 'block', reason: 'partial_amount_missing', code: 'partial_amount_missing' }),
    // 实付 ≠ 收款合计（`:938-948`）
    whenAmountMismatch: Object.freeze({ action: 'block', reason: 'partial_amount_mismatch', code: 'partial_amount_mismatch' }),
  }),
  unpaid: Object.freeze({
    labelKey: 'paymentStatusUnpaid',
    requirePaymentRows: false,
    // 未付 = `action: 'pending'`（本表只用来判 block / 档位）。
    // ⚠️ 2026-10-16 晚注释更正：**这里不再代表"不写欠款行"** ——
    //    新口径（她 2026-10-14「包括本次付款为 0」＋ 2026-10-16 晚裁定「客户少付 ⇒ 自动记一条【未收款】」）
    //    下，**未付也照补那条【未收款】**（差额 = 累计）。差额与那条记录都不由本表产生：
    //    差额算法在 `scanWriteService` / `salesOrderService`，落库在 `PaymentService.recordInitialBatch`。
    whenNoMoney: Object.freeze({ action: 'pending', reason: 'pending_supplement' }),
  }),
});

/** 拿不到档位 ⇒ `null`（**不猜** ✗ —— 猜错档位会写错账）。 */
const settlementOf = (mode, table = SETTLEMENTS) => table[String(mode || '')] || null;

const money = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * ⭐ 纯函数：给定档位与这一单的钱，返回**该做什么**（不碰任何 IO、不产生文案）。
 *
 * @param {object} input
 *   `mode`          语义键（`full` / `partial` / `unpaid`）
 *   `hasPaymentRows` 收款行有没有内容
 *   `anyLineAmount`  每件实收里有没有值（全付那条要靠它区分"两种没收款行"）
 *   `itemsCents`     每件实收合计（分）
 *   `paymentsCents`  收款行合计（分）
 *   `paidCents`      资金区"实付多少"（分；`null` = 没填；**未付/全付忽略它**）
 * @param {object} [table] 规则表（**可注入** ⇒ 用例能"换配置即换行为"）
 * @returns {{action:'allow'|'block'|'degrade'|'pending', reason:string, code:(string|null),
 *            effectiveMode:(string|null), owedCents:number}}
 */
const resolveSettlement = (input = {}, table = SETTLEMENTS) => {
  const mode = String(input.mode || '');
  const entry = settlementOf(mode, table);
  if (!entry) {
    return { action: 'block', reason: 'unknown_mode', code: 'unknown_mode', effectiveMode: null, owedCents: 0 };
  }
  const itemsCents = money(input.itemsCents);
  const paymentsCents = money(input.paymentsCents);
  const hasPaymentRows = input.hasPaymentRows === true;
  const anyLineAmount = input.anyLineAmount === true;

  if (mode === 'full') {
    if (!hasPaymentRows && !anyLineAmount) {
      return { ...entry.whenNoMoneyAtAll, effectiveMode: null, owedCents: 0 };
    }
    if (!hasPaymentRows) {
      return {
        action: entry.whenMissingRows.action,
        reason: entry.whenMissingRows.reason,
        // 规则里给了 code 就带上（真实配置里没有 ⇒ null）；这样"换配置即换行为"才真成立 ✓
        code: entry.whenMissingRows.code === undefined ? null : entry.whenMissingRows.code,
        effectiveMode: entry.whenMissingRows.to,
        owedCents: 0,
      };
    }
    if (itemsCents !== paymentsCents) {
      return { ...entry.whenAmountMismatch, effectiveMode: null, owedCents: 0 };
    }
    return { action: 'allow', reason: 'paid_in_full', code: null, effectiveMode: 'full', owedCents: 0 };
  }

  if (mode === 'partial') {
    const paidCents = input.paidCents === null || input.paidCents === undefined
      ? null
      : money(input.paidCents);
    if (paidCents === null) {
      return { ...entry.whenMissingAmount, effectiveMode: null, owedCents: 0 };
    }
    if (paidCents !== paymentsCents) {
      return { ...entry.whenAmountMismatch, effectiveMode: null, owedCents: 0 };
    }
    if (paidCents > itemsCents) {
      return { ...OVERPAID, effectiveMode: null, owedCents: 0 };
    }
    return { action: 'allow', reason: 'partial_paid', code: null, effectiveMode: 'partial', owedCents: itemsCents - paidCents };
  }

  // unpaid
  if (paymentsCents > itemsCents) {
    return { ...OVERPAID, effectiveMode: null, owedCents: 0 };
  }
  return { ...entry.whenNoMoney, code: null, effectiveMode: 'unpaid', owedCents: 0 };
};

/**
 * ⭐⭐ 2026-10-16（业务负责人逐字 · 她的两点之二/之一）：
 *   「**1. 未付、全付的差额怎么进未收款**」
 *   ⇒ 资金页**不再让她选档**：档位由「**本次填写的金额 vs 货品累计金额**」**自动定**出来。
 *     这条纯函数就是那个"自动定档"——**只算档位与差额，不碰任何 IO、不产生文案**。
 *
 * 规则（与 `config/scanWrite.js` 的「未付/部分付/全付」三档同一个语义，**语义键不新造** ✗）：
 *   · 本次已收 **>** 累计        ⇒ `block`（`amount_mismatch`，沿用既有那条"收多了"的口径 ✗ 不放宽）；
 *   · 累计不可知（≤ 0）          ⇒ `unpaid`（**不猜"全付"** ✗ —— 累计都没有，说"收齐了"是编）；
 *   · 本次已收 **= 0**           ⇒ `unpaid`，差额 = 累计（她逐字：「**包括本次付款为 0**」✓）；
 *   · 0 < 本次已收 < 累计        ⇒ `partial`，差额 = 累计 − 本次已收（那一笔差额 ⇒ 既有业务层写一条【未收款】✓）；
 *   · 本次已收 **=** 累计        ⇒ `full`，差额 0（**一条【未收款】都不写** ✓）。
 *
 * ⚠️ 差额的**落库**不在本文件（也不由扫码侧拼那条记录）：本函数只把 `owedCents` 交出去，
 *    写那一条的是既有业务层（`services/salesOrderService.js` 的 `owed` 协议）。
 * ⚠️ `code` / `reason` 一律**复用既有词汇**（`amount_mismatch`）：路由能直接拿它取既有文案 ✓
 *    （既不新造错误码、也不在这里放中文 ✗ —— 文案只给 labelKey/码，与 `SETTLEMENTS` 同规矩）。
 * ⚠️ 规则表**可注入**（第 2 参）⇒ 用例能"换配置即换行为"，代码零改动 ✓。
 */
const AUTO_MODES = Object.freeze({
  /** 本次已收 = 0 ⇒ 未付（差额 = 累计）。 */
  zeroPaid: 'unpaid',
  /** 0 < 本次已收 < 累计 ⇒ 部分付（差额 = 累计 − 已收）。 */
  underItems: 'partial',
  /** 本次已收 = 累计 ⇒ 全付（差额 0）。 */
  exact: 'full',
  /** 累计 ≤ 0（还没填实收 / 读不到）⇒ 未付：**不猜"全付"**。 */
  unknownItems: 'unpaid',
  /** 本次已收 > 累计 ⇒ 拦住（既有那条"收多了"的口径）。 */
  over: Object.freeze({ action: 'block', reason: 'amount_mismatch', code: 'amount_mismatch' }),
});

/**
 * ⭐ 纯函数：给定「货品累计」与「本次填写的金额」（**分**）⇒ 档位 + 差额（**分**）。
 *
 * @param {object} input `itemsCents`（累计）· `paymentsCents`（本次已收）
 * @param {object} [rules] 规则表（**可注入**）
 * @returns {{action:'allow'|'block', mode:(string|null), owedCents:number, reason:string, code:(string|null)}}
 *   `mode` 只可能是 `settlementOf()` 认得的语义键（`full` / `partial` / `unpaid`）或 `null`（block）。
 */
const autoModeOf = (input = {}, rules = AUTO_MODES) => {
  // 只接受非负数（负数/非数字一律当 0 ⇒ 与 `money()` 同一套保守口径，不猜 ✗）。
  const itemsCents = Math.max(0, money(input.itemsCents));
  const paymentsCents = Math.max(0, money(input.paymentsCents));
  if (paymentsCents > itemsCents) {
    return { ...rules.over, mode: null, owedCents: 0 };
  }
  if (itemsCents <= 0) {
    return { action: 'allow', mode: rules.unknownItems, owedCents: 0, reason: 'no_known_total', code: null };
  }
  if (paymentsCents <= 0) {
    return { action: 'allow', mode: rules.zeroPaid, owedCents: itemsCents, reason: 'nothing_paid', code: null };
  }
  if (paymentsCents === itemsCents) {
    return { action: 'allow', mode: rules.exact, owedCents: 0, reason: 'paid_in_full', code: null };
  }
  return {
    action: 'allow',
    mode: rules.underItems,
    owedCents: itemsCents - paymentsCents,
    reason: 'partial_paid',
    code: null,
  };
};

module.exports = {
  PAY_MODES, SETTLEMENTS, OVERPAID, settlementOf, resolveSettlement, AUTO_MODES, autoModeOf,
};
