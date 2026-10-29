'use strict';

/**
 * 扫码页「流程」解释器（纯函数，无 IO、无业务字面量）。
 *
 * 页面/提交器问它：这条流程有哪些步骤、能不能加一双、哪一步该显示、提交给谁、要带哪些上下文。
 * 所有判断都是**查表 + 通用条件求值** —— 新增一种扫码流程只加 `config/scanFlows.js` 一条配置。
 */
const { SCAN_FLOWS, DEFAULT_SCAN_FLOW, STEP_TYPES } = require('../config/scanFlows');

const badFlow = (id) => Object.assign(new Error(`未声明的扫码流程：${String(id || '').trim() || '(空)'}`), { statusCode: 400 });

/** 按 id 取流程；认不出 ⇒ 400（不静默回落，避免"配错了却照跑"）。 */
const getFlow = (id) => {
  const key = String(id || '').trim();
  if (!key) return SCAN_FLOWS[DEFAULT_SCAN_FLOW];
  const flow = SCAN_FLOWS[key];
  if (!flow) throw badFlow(key);
  return flow;
};

/** 从请求参数里取 flow（缺省 = sales）。 */
const resolveFlowFromQuery = (query = {}) => {
  const raw = String(query.flow || query.scanFlow || '').trim();
  return getFlow(raw);
};

const stepsOf = (flow) => (Array.isArray(flow?.steps) ? flow.steps : []);
const stepOf = (flow, type) => stepsOf(flow).find((step) => step.type === type) || null;
const hasStep = (flow, type) => Boolean(stepOf(flow, type));

/** 能不能"再加一个货品"（flow 级缺省，可被 goods 步骤覆盖）。 */
const allowsAddLine = (flow) => {
  const goods = stepOf(flow, STEP_TYPES.GOODS);
  return Boolean(goods?.allowAddLine ?? flow?.allowAddLine);
};

/** 某条步骤在当前事实下该不该显示（when 条件统一在这里求值）。 */
const shouldShowStep = (flow, type, facts = {}) => {
  const step = stepOf(flow, type);
  if (!step) return false;
  const when = step.when;
  if (!when) return true;
  const actual = facts[when.field];
  switch (String(when.op || '').trim()) {
    case '!=': return actual !== when.value;
    case '==': return actual === when.value;
    case '>': return Number(actual) > Number(when.value);
    case '<': return Number(actual) < Number(when.value);
    default: return true;
  }
};

const submitStep = (flow) => stepOf(flow, STEP_TYPES.SUBMIT);
const submitHandlerOf = (flow) => String(submitStep(flow)?.handler || '').trim();
const submitEndpointOf = (flow) => String(submitStep(flow)?.endpoint || '').trim();
const submitPayloadOf = (flow) => (Array.isArray(submitStep(flow)?.payload) ? submitStep(flow).payload : []);
const contextFieldsOf = (flow) => (Array.isArray(flow?.context) ? flow.context : []);

/** 从来源对象里挑出这条 flow 需要的上下文（缺的键就是 undefined，由调用方校验）。 */
const pickContext = (flow, source = {}) => {
  const picked = {};
  for (const key of contextFieldsOf(flow)) picked[key] = source?.[key];
  return picked;
};

module.exports = {
  getFlow,
  resolveFlowFromQuery,
  stepsOf,
  stepOf,
  hasStep,
  allowsAddLine,
  shouldShowStep,
  submitHandlerOf,
  submitEndpointOf,
  submitPayloadOf,
  contextFieldsOf,
  pickContext,
};
