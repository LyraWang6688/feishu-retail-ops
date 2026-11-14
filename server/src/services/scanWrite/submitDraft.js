'use strict';

/**
 * 扫码销售提交 · 「提交上下文」的取值与状态标记（2026-11-14 #48，从
 * `routes/scanPage/handlers/salesSubmit.js` **只搬不改**搬出）。
 *
 * 这里承载三件原本写在入口层的事：
 *   ① 每件实收的**回落链**（body → 会话草稿行 → 一单一笔的 `fields.amount`）；
 *   ② 提交这一步的**会话状态标记**（`paymentStep: 'pending'` + `status: draft`）；
 *   ③ 点按钮那一刻要存的 `submitPending`（尺码/金额/赠品/收款行/付款情况/实付）。
 * 入口只负责"取 ctx → 调这里 → 渲染/跳转"，不再自己判业务。
 *
 * ⚠️ 行为逐字保持（含注释里记录的历史 P0）；改动前先看本文件底部两条回归判据。
 */

/** 本单已有的草稿行（兼容 `sale.lines` 与旧形状 `lines`）。 */
const resolvePendingDraftLines = (session) => (Array.isArray(session?.sale?.lines)
  ? session.sale.lines
  : (Array.isArray(session?.lines) ? session.lines : []));

/**
 * 每件实收：body → 会话草稿行 → 一单一笔的 `fields.amount`（逐字搬自 handler）。
 *
 * 🔴 2026-10-16 P0（她真机：「货品信息里填了 240 ⇒ 资金页显示 0 ⇒ 提交没反应」）：
 *   资金页那张表单**不带** `line_amount`，值先写进会话草稿行 ⇒ 这里必须回落草稿行，
 *   否则空数组/静默 0 会让结算读点拿到 0。
 */
const resolveLineAmounts = ({ body, fields, asList, draftLines = [] }) => {
  const bodyLineAmounts = asList(body[fields.lineAmount]);
  const draftLineAmounts = draftLines
    .map((line) => String(line?.amount ?? '').trim()).filter(Boolean);
  // 第三档：一单一笔那条默认路径（草稿 0 行 ⇒ 她那一下填的就在 `fields.amount`）
  const singleRowAmount = String(body[fields.amount] ?? '').trim();
  return {
    bodyLineAmounts,
    lineAmounts: bodyLineAmounts.some((value) => String(value ?? '').trim())
      ? bodyLineAmounts
      : (draftLineAmounts.length ? draftLineAmounts : (singleRowAmount ? [singleRowAmount] : [])),
  };
};

/** 点提交那一刻原样存下来的那一双（拿不到就不存，不编）。 */
const buildSubmitPending = ({ body, fields, parsePaymentRows }) => ({
  size: String(body[fields.size] ?? '').trim(),
  amount: String(body[fields.amount] ?? '').trim(),
  gift: String(body[fields.gift] ?? '').trim(),
  // ⭐ 逐件实收只存 `sale.lines[].amount`，不再在 submitPending 里存第二份（2026-10-29）。
  payments: parsePaymentRows(body, fields),
  paymentStatus: String(body[fields.paymentStatus] || '').trim(),
  paidAmount: String(body[fields.paidAmount] ?? ''),
});

/**
 * 提交上下文 + 会话状态标记（**状态标记必须先写**：闸门拦住时仍要停在资金页）。
 *
 * ⚠️ `status` 必须写回 `draft`（2026-10-15 task-22 的回退修复）：否则上一单的
 * `submitted` 会留在会话里，第 2 单刷新就被打回录入页。该状态不会被"重启补跑"误抓
 * （那两个扫描器同时要求 `draft` + `order_no` + `lines`，提交这一步前两者都没有）。
 */
const prepareSubmitDraft = async ({
  writeService, openId, body, fields, asList, parsePaymentRows, writeConfig,
}) => {
  const submitSession = await writeService.sessions?.get?.(openId).catch(() => null);
  const pendingDraftLines = resolvePendingDraftLines(submitSession);
  const { bodyLineAmounts, lineAmounts } = resolveLineAmounts({
    body, fields, asList, draftLines: pendingDraftLines,
  });
  const payments = parsePaymentRows(body, fields);
  await writeService.saveDraftLines?.(openId, {
    lines: pendingDraftLines,
    // 她（或 GET）据此判断"已经走到资金这一步了" ⇒ 刷新仍停在资金页
    paymentStep: 'pending',
    status: writeConfig.session.statuses.draft,
    submitPending: buildSubmitPending({ body, fields, parsePaymentRows }),
  });
  return { submitSession, pendingDraftLines, bodyLineAmounts, lineAmounts, payments };
};

module.exports = {
  resolvePendingDraftLines, resolveLineAmounts, buildSubmitPending, prepareSubmitDraft,
};
