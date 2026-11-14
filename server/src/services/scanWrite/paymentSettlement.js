'use strict';

/**
 * 扫码资金页 · 「按金额自动定档 → 结算校验」的纯计算（2026-11-14 #48，从
 * `routes/scanPage/handlers/payment.js` **只搬不改**搬出）。
 *
 * 入口只负责"拿到 ctx → 调这里 → 按 settlement.action 渲染/放行"，不再自己算业务。
 *
 * 历史口径（随代码搬过来，别删）：
 *   · 档位**按金额自动定**（`autoModeOf({itemsCents,paymentsCents})`），不再从请求体反查
 *     （2026-10-16 A2a：页面去掉了三个单选框 ⇒ 反查必然查不到 ⇒ unknown_mode 拦住）；
 *   · 交给写服务的档位必须换回**中文取值**（`PAYMENT_STATUS` 是语义键 ↔ 中文的唯一真源）；
 *   · 「本次已收」= **收款行合计**（与 `resolveSettlement` 的 `paidCents` 同一口径，不两套算法）；
 *   · `resolveSettlement` 的入参用**解析后**的那一份（券行已有金额 / 货品侧已扣券抽佣）。
 */
const { resolveSettlement, autoModeOf } = require('../../config/saleSettlement');
const { PAYMENT_STATUS } = require('../../config/scanWrite');
const { sumCents } = require('../../utils/money');

/**
 * @param {object} input
 * @param {Array<string|number>} input.effectiveLineAmounts 解析后的逐件实收（券行已有金额）
 * @param {Array<{amount: any}>} input.paidPayments 解析后的收款行（券行 = 平台结算款）
 * @param {any} input.pendingPaidAmount 旧形状兜底值（一行收款都没有时沿用）
 * @returns {{itemsCents:number,paymentsCents:number,pendingMode:string,
 *   effectivePaymentStatus:string,effectivePaidAmount:any,settlement:object}}
 */
const resolvePaymentSettlement = ({
  effectiveLineAmounts = [], paidPayments = [], pendingPaidAmount = '',
} = {}) => {
  const itemsCents = sumCents(effectiveLineAmounts);
  const paymentsCents = sumCents(paidPayments.map((row) => row.amount));
  const auto = autoModeOf({ itemsCents, paymentsCents });
  const payStatusMap = PAYMENT_STATUS || {};
  const pendingMode = auto.mode || '';
  // 交给写服务的档位 = 自动定出来的那一档（不是请求体里的旧档位）
  const effectivePaymentStatus = payStatusMap[pendingMode] || '';
  // 「本次已收」= 收款行合计（元）；一行都没有 ⇒ 沿用旧值（空 ⇒ 不写；未付/全付本来就不读它）
  const effectivePaidAmount = paymentsCents > 0 ? String(paymentsCents / 100) : pendingPaidAmount;
  // 收多了 ⇒ 纯函数已给 block（与既有 amount_mismatch 同一句话，不新编中文）
  const settlement = auto.action === 'block' ? auto : resolveSettlement({
    mode: pendingMode,
    itemsCents,
    paymentsCents,
    hasPaymentRows: paidPayments.filter((row) => String(row.amount ?? '').trim()).length > 0,
    anyLineAmount: effectiveLineAmounts.some((value) => String(value ?? '').trim()),
    // ⚠️ 传 null 会被判 partial_amount_missing（旧形状才有的失败）⇒ 不传
    paidCents: paymentsCents,
  });
  return { itemsCents, paymentsCents, pendingMode, effectivePaymentStatus, effectivePaidAmount, settlement };
};

module.exports = { resolvePaymentSettlement };
