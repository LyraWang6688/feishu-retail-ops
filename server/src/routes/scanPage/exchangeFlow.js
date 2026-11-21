'use strict';

/**
 * 扫码页「售后换款式」flow 的接线（2026-10-29）——**薄模块**，把路由那一处 if 收进来。
 *
 * 口径：流程本身是配置（`config/scanFlows.js`）；这里只做两件事：
 *   ① GET：把 flow + 售后上下文交给渲染层（页面按配置隐藏"加一双/金额输入"、换提交文案）；
 *   ② POST：货品页提交时**不走资金页**——原生 POST 兜底 303 回带 flow 的原页（零写入），由页面差价弹窗继续。
 * 为什么单独成文件：`routes/scanPage/index.js` 是**大小棘轮**盯着的存量超限文件（只许缩小）。
 */
const { getFlow, resolveFlowFromQuery, pickContext } = require('../../services/scanFlowService');

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
 * 原生 POST（前端差价脚本未拦住）⇒ 303 回带 flow 的原页；页面再走差价弹窗。
 * @returns {boolean} 是否已经应答（true = 调用方立即 return）
 */
const handlePendingExchangeSubmit = ({ req, res, requestId, action, actions }) => {
  const body = req.body || {};
  const hasExchangeContext = body.flow === 'afterSalesExchange'
    || ['requestId', 'salesEntryRecordId', 'detailRecordId', 'originalAmount']
      .every((key) => String(body[`ctx_${key}`] || '').trim() !== '');
  const flow = safeFlowOf(req.query).id === 'sales' && hasExchangeContext
    ? getFlow('afterSalesExchange')
    : safeFlowOf(req.query);
  if (flow.id === 'sales' || action !== actions.submitOrder) return false;
  // 原生表单兜底：保留 flow 后回到同一页（页面上有差价弹窗），绝不落回普通销售建单。
  res.redirect(303, req.originalUrl || '/');
  return true;
};

module.exports = { renderFlowOf, handlePendingExchangeSubmit };
