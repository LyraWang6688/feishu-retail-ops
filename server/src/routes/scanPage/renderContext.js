'use strict';

/**
 * 扫码页「渲染与上下文」（拆分第 2 刀，从 `routes/scanPage/index.js` 搬出，**只搬不改**）：
 *   · `logRendered`  —— 页面渲染日志（`scan.page.rendered`）
 *   · `logFunnelPage` —— 前端漏斗（`ui.page.view` / `ui.step.enter`）
 *   · `successReturnFields` —— 成功页/资金页共用的回跳字段
 *
 * `config` 与 `postActionFor` 由调用方注入（路由里仍是同一份 config，行为/字节都不变）。
 */
const { FUNNEL } = require('../../config/funnel');
const { resolveRealm, DEFAULT_REALM } = require('../../views/scanPageRealm');
const { logInfo } = require('../../utils/logger');

const createRenderContext = ({ config, postActionFor }) => {
  /** 前端漏斗（服务端侧）：页面渲染成功即记；step 只取页面语义映射。 */
  const logFunnelPage = (req, { page, step, realm = '', number = '' } = {}) => {
    if (!FUNNEL.enabled) return;
    const fields = {
      request_id: req?.requestId,
      page: String(page || 'scan'),
      ...(step ? { step: String(step) } : {}),
      ...(realm ? { realm: String(realm) } : {}),
      ...(number ? { number: String(number).slice(0, 40) } : {}),
    };
    logInfo(FUNNEL.events.pageView, fields);
    if (step) logInfo(FUNNEL.events.stepEnter, fields);
  };

  const logRendered = (req, { page, trigger, number = '' } = {}) => {
    logInfo(config.events?.rendered || 'scan.page.rendered', {
      request_id: req?.requestId,
      page: String(page || ''),
      trigger: String(trigger || ''),
      query_keys: Object.keys(req?.query || {}).sort(),
      number: String(number || ''),
    });
    const stepOfPage = { goods: 'entry', pay: 'payment', success: 'success', skeleton: 'entry', bad_number: 'error', not_found: 'error' };
    logFunnelPage(req, {
      page: String(page || 'scan'),
      step: stepOfPage[String(page || '')] || '',
      realm: resolveRealm(req?.query?.from),
      number,
    });
  };

  const successReturnFields = (req, target, noticeNo = '') => {
    const cfg = config.successReturn || {};
    if (cfg.enabled === false) return {};
    const homeRealm = cfg.homeRealm || DEFAULT_REALM;
    const landing = cfg.homePath && homeRealm === DEFAULT_REALM
      ? `${req.baseUrl}${cfg.homePath}`.replace(/\/+$/, '') + '/'
      : '';
    const base = landing || postActionFor(target, homeRealm);
    const noticeKey = cfg.noticeKey || 'done';
    const homePath = String(noticeNo || '').trim()
      ? `${base}${base.includes('?') ? '&' : '?'}${encodeURIComponent(noticeKey)}=${encodeURIComponent(String(noticeNo).trim())}`
      : base;
    return {
      returnPath: homePath,
      returnLabel: cfg.label || '',
      returnDelaySeconds: Number(cfg.delaySeconds) || 0,
      autoReturnUrl: homePath,
    };
  };

  return { logFunnelPage, logRendered, successReturnFields };
};

module.exports = { createRenderContext };
