'use strict';

/**
 * 扫码页「售后换款式」flow 的接线（2026-10-29）——**薄模块**，把路由那一处 if 收进来。
 *
 * 口径：流程本身是配置（`config/scanFlows.js`）；这里只做两件事：
 *   ① GET：把 flow + 售后上下文交给渲染层（页面按配置隐藏"加一双/金额输入"、换提交文案）；
 *   ② POST：货品页提交时**不走资金页**——下一步（算差价 / 提交售后）未接 ⇒ 人话页、零写入。
 * 为什么单独成文件：`routes/scanPage/index.js` 是**大小棘轮**盯着的存量超限文件（只许缩小）。
 */
const { resolveFlowFromQuery, pickContext } = require('../../services/scanFlowService');

/** 认不出的 flow 一律回落 sales（与扫码页既有"不报错"口径一致）。 */
const safeFlowOf = (query) => {
  try { return resolveFlowFromQuery(query); } catch { return resolveFlowFromQuery({}); }
};

/** GET 用：返回交给渲染层的 { flow, flowContext }。 */
const renderFlowOf = (query) => {
  const flow = safeFlowOf(query);
  return { flow, flowContext: pickContext(flow, query) };
};

/**
 * POST 用：非销售 flow 的销售提交（货品页提交）到此为止 —— **不跳资金页、不写库**。
 * @returns {boolean} 是否已经应答（true = 调用方立即 return）
 */
const handlePendingExchangeSubmit = ({ req, res, requestId, action, actions, realm, sendHuman, markTapCode, postActionFor, backTargetFor }) => {
  const flow = safeFlowOf(req.query);
  if (flow.id === 'sales' || action !== actions.submitOrder) return false;
  markTapCode(res, 'flow_next_step_pending');
  const texts = flow.texts || {};
  sendHuman(res, 200, {
    title: texts.pendingTitle || '',
    body: texts.pendingBody || '',
    requestId,
    backPath: postActionFor(backTargetFor(req, decodeURIComponent(String(req.params.recordId || ''))), realm),
    backLabel: texts.backLabel || '',
  });
  return true;
};

module.exports = { renderFlowOf, handlePendingExchangeSubmit };
