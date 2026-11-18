'use strict';

/**
 * 货品页提交后的去向（2026-11-18，业务负责人）。
 *
 * 整单实收全为 0 ⇒ 不跳资金页，直接异步销售；
 * 混合单（0 + 有金额）仍走资金页；异步不可用则回落资金页。
 *
 * ⚠️ 单独一个文件：`config/scanWrite.js` 已超过文件大小基线，
 *    再往里加会触发 size 闸门；规则本身放这里仍然属于 `config/**`（配置先行）。
 */
const SALE_SUBMIT_PLANS = Object.freeze([
  Object.freeze({
    id: 'free_order',
    when: Object.freeze({ allLineAmountsZero: true, salesAsyncEnabled: true }),
    action: 'async_sale',
  }),
  Object.freeze({
    id: 'normal',
    when: Object.freeze({}),
    action: 'payment_step',
  }),
]);

module.exports = { SALE_SUBMIT_PLANS };
