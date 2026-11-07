'use strict';

/**
 * 扫码页「渲染与上下文」（拆分第 2 刀，从 `routes/scanPage/index.js` 搬出，**只搬不改**）：
 *   · `logRendered`  —— 页面渲染日志（`scan.page.rendered`）
 *   · `logFunnelPage` —— 前端漏斗（`ui.page.view` / `ui.step.enter`）
 *   ⚠️ 2026-10-29：`successReturnFields`（成功页回跳字段）**随成功页一起退场** ——
 *     提交通一改成「303 回工作台 + toast」（`utils/submitToast.js`），它已无调用方 ✓
 *
 * `config` 由调用方注入（路由里仍是同一份 config，行为/字节都不变）。
 * ⚠️ `postActionFor` 已不需要（它原来只服务成功页回跳）⇒ 本文件不再吃这个依赖 ✓
 */
const { FUNNEL } = require('../../config/funnel');
const { resolveRealm } = require('../../views/scanPageRealm');
const { logInfo } = require('../../utils/logger');

const createRenderContext = ({ config }) => {
  /** 前端漏斗（服务端侧）：页面渲染成功即记；step 只取页面语义映射。 */
  const logFunnelPage = (req, { page, step, realm = '', number = '' } = {}) => {
    if (!FUNNEL.enabled) return;
    const fields = {
      request_id: req?.requestId,
      view_source: 'server_render',
      qr_format: 'record_id',
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
      qr_format: 'record_id',
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

  return { logFunnelPage, logRendered };
};

module.exports = { createRenderContext };
