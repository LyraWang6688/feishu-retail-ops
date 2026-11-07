'use strict';

/**
 * 「支付方式管理」表里**可选列**的列名（业务负责人 2026-11-08：支付方式也配置化）。
 *
 * 「可用于退款」（勾选框）：
 *   · **表里没有这一列** ⇒ 全部方式都可用于退款（向后兼容，生产还没加列时行为不变）；
 *   · 有这一列 ⇒ 只有勾了的方式能用于售后「直接退款」。
 * ⚠️ 列名可配（env），代码里不绑死一个中文名字。
 */
const PAYMENT_METHODS = Object.freeze({
  refundableField: String(process.env.PAYMENT_METHOD_REFUNDABLE_FIELD || '可用于退款').trim(),
});

module.exports = { PAYMENT_METHODS };
