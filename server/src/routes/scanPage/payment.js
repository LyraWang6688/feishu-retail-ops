'use strict';

const { asList } = require('./shared');

/**
 * ⭐⭐ 2026-10-16 拆分（阶段二 · 纯搬运 ✓）：**资金页**相关的纯函数。
 *   本轮先落 `parsePaymentRows`（后续层：pay / skip 两支 ＋ step2WriteOf ✓）。
 */

/**
 * 表单 → **多笔收款**（`[{ method, amount }]`，按下标对齐）。
 * ⚠️ 这里**不判业务**（哪一行算一笔、方式必不必填 ⇒ 写服务说了算）；
 *    只负责把两个同名数组拼成行 —— 少一个字段的行也照拼（缺的那位是空串）。
 */
const parsePaymentRows = (body, fields) => {
  const methods = asList(body[fields.paymentMethod]);
  const amounts = asList(body[fields.paymentAmount]);
  const total = Math.max(methods.length, amounts.length);
  return Array.from({ length: total }, (_, index) => ({
    method: methods[index] ?? '', amount: amounts[index] ?? '',
  }));
};

module.exports = { parsePaymentRows };
