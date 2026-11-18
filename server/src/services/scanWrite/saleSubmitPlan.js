'use strict';

/**
 * 货品页提交后的去向（2026-11-18）。
 *
 * 目标（业务负责人）：整单实收全为 0 ⇒ 不跳资金页，直接走异步销售；
 * 混合单（0 + 有金额）仍走资金页；异步不可用则回落资金页。
 *
 * 🔴 入口不写 `if (金额 === 0)`：事实由本文件算，去向由 `config/scanWrite.js`
 *    的 `sale.submitPlans` 声明；入口只按返回的 `action` 做映射。
 */

const { SALE_SUBMIT_PLANS } = require('../../config/saleSubmitPlans');

const normalizedAmounts = (lineAmounts) => (Array.isArray(lineAmounts) ? lineAmounts : [])
  .map((value) => String(value ?? '').trim());

/** 本次提交的“事实”，供配置规则匹配。 */
const saleSubmitFacts = ({ lineAmounts, salesAsyncEnabled } = {}) => {
  const amounts = normalizedAmounts(lineAmounts);
  return {
    // 空行不算 0：必须**每一行都显式填了 0**。空金额由更早的闸门拦住。
    allLineAmountsZero: amounts.length > 0
      && amounts.every((value) => value !== '' && Number(value) === 0),
    salesAsyncEnabled: salesAsyncEnabled === true,
  };
};

const matches = (when, facts) => Object.entries(when || {})
  .every(([key, expected]) => facts[key] === expected);

/**
 * @param {object} input
 * @param {string[]} input.lineAmounts
 * @param {boolean} input.salesAsyncEnabled
 * @param {object} input.config  `config/scanWrite.js` 的 SCAN_WRITE（取 `sale.submitPlans`）
 * @returns {{id:string, action:'payment_step'|'async_sale', when:object}}
 */
const resolveSaleSubmitPlan = ({ lineAmounts, salesAsyncEnabled, config } = {}) => {
  const plans = Array.isArray(config?.sale?.submitPlans) && config.sale.submitPlans.length
    ? config.sale.submitPlans
    : SALE_SUBMIT_PLANS;
  const facts = saleSubmitFacts({ lineAmounts, salesAsyncEnabled });
  const matched = plans.find((plan) => matches(plan?.when, facts));
  const fallback = plans.find((plan) => plan?.action === 'payment_step')
    || { id: 'normal', action: 'payment_step', when: {} };
  return matched || fallback;
};

module.exports = { resolveSaleSubmitPlan, saleSubmitFacts };
