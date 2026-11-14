'use strict';

/**
 * 库存状态策略（业务负责人 2026-11-12 定稿）。
 *
 * 两层语义：
 *   · 看库存 / 统计：不看「所属状态」，有记录就算有库存；
 *   · 写库存（新增 / 删除记录）：状态参与选行与新行状态。
 *
 * 出库（减少）：
 *   同一个「编号 + 尺码」内，门盒与空状态先扣（空状态按门盒算），样品最后扣；
 *   同一优先级内按创建时间 FIFO。
 *
 * 入库（增加）：
 *   维度是同一个「编号」的所有尺码合计：
 *     · 合计 = 0 → 这一批第一双写「样品」，其余写「门盒」
 *     · 合计 > 0 → 全部写「门盒」
 *   注意：这里不是按单个尺码判断，而是按编号（product_record_id）整体判断。
 */

const INBOUND_STATE = Object.freeze({
  SAMPLE: '样品',
  DOOR_BOX: '门盒',
});


/** 空状态按门盒算；其余未知状态也按门盒算（只有明确的「样品」排最后）。 */
const outboundStateRank = (state) => {
  const value = Array.isArray(state) ? state[0] : state;
  return String(value || '').trim() === INBOUND_STATE.SAMPLE ? 1 : 0;
};

/**
 * 一批入库要写的状态序列。
 * @param {{ existingTotal: number, quantity: number }} input
 *   existingTotal = 同一个编号所有尺码的实时库存合计（含空状态）
 * @returns {string[]}
 */
const inboundStatesFor = ({ existingTotal = 0, quantity = 0 } = {}) => {
  const total = Number(existingTotal) || 0;
  const count = Number(quantity) || 0;
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, index) => (
    total === 0 && index === 0 ? INBOUND_STATE.SAMPLE : INBOUND_STATE.DOOR_BOX
  ));
};

/** 人工调整明确指定状态时：整批都按用户选择，不套自动规则。 */
const explicitInboundStates = (state, quantity = 0) => {
  const value = String(state || '').trim();
  if (!Object.values(INBOUND_STATE).includes(value)) throw new Error('库存所属状态无效');
  return Array.from({ length: Number(quantity) || 0 }, () => value);
};

module.exports = {
  INBOUND_STATE,
  outboundStateRank,
  inboundStatesFor,
  explicitInboundStates
};
