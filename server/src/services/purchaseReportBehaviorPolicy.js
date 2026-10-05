/**
 * 「采购行为」分流（纯函数）。
 *
 * 业务负责人 2026-10-05 把「供应商报货」改名为「供应商对接」，并给了两种填法，
 * 靠表单上的「采购行为」（关联「行为管理」）区分：
 *   · 采购申请：编号 + 尺码 + 数量说明（文字，例如「3 个 40、2 个 41」）
 *   · 采购退货：编号 + 数量（number），**没有尺码**
 * 处理前必须先认出这条记录是哪一种：采购退货要直接扣库存、出「采购退货单」，
 * **不走采购到货和采购入库**；采购申请维持现状。
 *
 * 判定只认行为记录自己的名称/编码，不做别的假设：
 *   · 名称/编码里带「退货」或 RETURN → 采购退货（表单上的选项名就是「采购退货」）；
 *   · 编码是 STOCK_PURCHASE_DECREASE → 也算退货：业务负责人给退货的「库存行为」就是这个
 *     编码（名称「采购减少」），而「采购申请」那条永远是 STOCK_PURCHASE_INCREASE，
 *     所以多认一个**编码**信号不会把普通报货误判成退货。
 *     ⚠️ 刻意**不**按中文名「采购减少」认：「采购减少」是库存行为的叫法，万一
 *     「行为管理」里同时存在这条记录、又有人把它挂到一条采购申请上，就会误扣库存。
 *     编码是稳定的契约，中文名不是（这条链路上改中文名不影响代码的原则见 inventoryService）。
 *   · 其它一切（含读不到行为记录、名称不认识）→ **维持现状**（采购申请）。
 * 默认成采购申请是有意的：那是这条链路今天的行为，也是"读不到任何信息时唯一
 * 不会凭空发明业务规则"的选择。宁可退回现状，也不要把一条普通报货当成退货。
 */

const REPORT_BEHAVIOR = Object.freeze({
  PURCHASE_REQUEST: 'purchase_request',
  PURCHASE_RETURN: 'purchase_return',
});

const text = (value) => String(value ?? '').trim();

// 「退货」判定：中文名称含「退货」，或编码里带 RETURN / STOCK_PURCHASE_DECREASE。
const RETURN_PATTERN = /退货|return|stock_purchase_decrease/i;

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
