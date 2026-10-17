'use strict';

/**
 * 前端漏斗（埋点第 5 刀）：`ui.page.view` / `ui.step.enter`。
 *
 * 两个来源（**同一套事件名/字段**，不各写一份）：
 *   · 扫码页：**服务端渲染时**记（`routes/scanPage` 的 `logFunnelPage`）——页面渲染成功即"她看到了这一页"，
 *     不依赖客户端 JS（扫码页有"只能一段脚本"的硬约束，且页面字节有逐字节尺子）。
 *   · 工作台：客户端 beacon（`shared/ui-tap.js` 的 `view()` → 既有 `/ui-tap` 端点，
 *     服务端 `handleUiTap` 里 `kind=page_view` 分支记日志）。
 *
 * 🔴 只记**页面/步骤标识**（`scan` / `payment` / `success` / `workbench` / `home` …）——
 *    绝不采集表单值 / 订单号 / 个人信息（`number` 只复用既有 rendered 日志口径）。
 */
const { readFlag } = require('./envValue');

const STEPS = Object.freeze(['entry', 'payment', 'success', 'error', 'home', 'inventory_adjust', 'orders']);

const FUNNEL = Object.freeze({
  enabled: readFlag(process.env, 'FUNNEL_ENABLED', true),
  events: Object.freeze({
    pageView: 'ui.page.view',
    stepEnter: 'ui.step.enter',
  }),
  steps: STEPS,
  maxPageLength: 40,
  maxStepLength: 40,
});

/** `kind=page_view` 的 step 只认白名单；认不出 ⇒ 空串（只发 page.view，不发 step.enter，不猜）。 */
const funnelStepOf = (step) => {
  const value = String(step || '').trim();
  return STEPS.includes(value) ? value : '';
};

module.exports = { FUNNEL, STEPS, funnelStepOf };
