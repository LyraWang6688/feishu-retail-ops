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
 *   · 「未付」= **状态未付 + 不写欠款行**（`owedCents = 0`）⇒ 这里叫 `action: 'pending'`（语义不变）；
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
    // 未付 = 状态未付 + **不写欠款行**（`owed = 0`；她明说"先付 X、还欠 Y"才算欠）
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

module.exports = { PAY_MODES, SETTLEMENTS, OVERPAID, settlementOf, resolveSettlement };
