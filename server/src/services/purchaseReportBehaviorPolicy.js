/**
 * 「采购行为」分流（纯函数）。
 *
 * 业务负责人 2026-10-05 改了「供应商报单」表的字段结构：两种格式都走表单，
 * 靠「采购行为」（关联字段）区分——
 *   · 采购申请：编号 + 尺码 + 数量说明（文字，例如「3 个 40、2 个 41」）
 *   · 采购退货：编号 + 数量（数字），**没有尺码**
 * 所以处理前必须先认出这条记录是哪一种，再决定怎么解析。
 *
 * 判定只认一个信号：行为记录（「行为管理」表）的「行为名称」或「行为编码」里
 * 带「退货 / RETURN」。⚠️ 具体是哪个名称/编码由业务负责人的表决定，这里不做假设：
 *   · 认出来是退货 → 走退货解析（数量字段、不写尺码）；
 *   · 其它一切（含读不到行为记录、名称不认识）→ **维持现状**（采购申请）。
 * 默认成采购申请是有意的：这是这条链路今天的行为，也是"读不到任何信息时唯一
 * 不会凭空发明业务规则"的选择。宁可退回现状，也不要把一条普通报货当成退货。
 */

const REPORT_BEHAVIOR = Object.freeze({
  PURCHASE_REQUEST: 'purchase_request',
  PURCHASE_RETURN: 'purchase_return',
});

const text = (value) => String(value ?? '').trim();

// 「退货」判定：中文名称含「退货」，或编码里带 RETURN（不看大小写）。
const RETURN_PATTERN = /退货|return/i;

/**
 * @param {{ name?: string, code?: string }} [behavior] 行为记录上的名称/编码
 * @returns {'purchase_request'|'purchase_return'}
 */
const classifyReportBehavior = (behavior = {}) => {
  const label = `${text(behavior?.name)} ${text(behavior?.code)}`.trim();
  return RETURN_PATTERN.test(label) ? REPORT_BEHAVIOR.PURCHASE_RETURN : REPORT_BEHAVIOR.PURCHASE_REQUEST;
};

module.exports = {
  REPORT_BEHAVIOR,
  classifyReportBehavior,
  // 导出给单测钉住正则口径，不必复制一份。
  RETURN_PATTERN,
};
