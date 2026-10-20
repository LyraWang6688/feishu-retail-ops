// 「点击埋点」的**同一份实现**：扫码页（`routes/scanPage.js`）与工作台（`routes/workbench.js`）
// 都 require 这一个文件 —— 事件名 / 字段 / 判据 / 端点契约**都只有这一处**（不抄第二份 ✗）。
//
// 三个事件（②④ 是本轮新增；`ui.tap` 那一条 2026-10-13 已上线）：
//   · `ui.tap`          —— 她点了什么（`target` 是我们的标识；**绝不带表单值** ✗）
//   · `ui.tap.repeated` —— ④ 同一个 target 在 `UI_TAP.repeatedWindowMs` 内又被点（独立事件）
//   · `ui.tap.result`   —— ② 那次点击**后续那笔写请求**的结果（`status` + `code` + `duration_ms`）
//
// ⚠️ 为什么"算不算重复"由**服务端**判：客户端可能是**旧页面**（缓存），窗口值也只有服务端配置
//    有唯一真源 ⇒ 客户端只报事实（`target` / `tap_id` / `since_ms`）✓。
// ⚠️ 为什么结果事件用 `res.on('finish')`：一次请求**恰好**记一条，且拿到的是**真实**发送出去的状态
//    （含 303 跳转 / 400 / 500），不用在每个出口各写一行 ✗。
// ⚠️ `tap_id` **只从 body 读**（不读 query / 头）：埋点 beacon 自己的 `tap_id` 在 **query** 里
//    ⇒ 两者天然不会串（否则上报请求自己也会被记一条"结果" = 噪声 ✗）。
const { UI_TAP } = require('../config/uiTap');
const { FUNNEL, funnelStepOf } = require('../config/funnel');
const { logInfo, logWarn } = require('./logger');

/** 只截断、不拒绝（超长串不许把日志撑爆）；空 ⇒ 空串，由调用方决定 400。 */
const clip = (value, max) => String(value ?? '').trim().slice(0, max);

/**
 * ④ 判据：同一个 target 上一次点击距现在 ≤ 窗口 ⇒ 记**独立事件** `ui.tap.repeated`。
 * ⭐ **纯函数**（用例直接调它就能真红，不依赖日志 sink）。
 * ⚠️ `sinceMs` 缺失 / 负数 / 非数字 ⇒ 一律按普通 `ui.tap`（**不猜** ✗）。
 */
const tapEventName = (sinceMs) => {
  if (sinceMs === null || sinceMs === undefined || sinceMs === '') return UI_TAP.events.tap;
  const gap = Number(sinceMs);
  if (!Number.isFinite(gap) || gap < 0) return UI_TAP.events.tap;
  return gap <= UI_TAP.repeatedWindowMs ? UI_TAP.events.repeated : UI_TAP.events.tap;
};

/**
 * ② 结果事件的**原因码**：有具体业务码就用它（`res.locals.uiTapCode`，例 `amount_mismatch` /
 * `purchase_amount_required`），取不到就按状态**分类**（`ok` / `rejected` / `failed`）。
 * ⭐ 纯函数 ⇒ 用例可**真红**。
 */
const resultCodeOf = ({ status, code } = {}) => {
  const explicit = String(code ?? '').trim();
  if (explicit) return explicit;
  const value = Number(status);
  if (!Number.isFinite(value)) return UI_TAP.resultCodes.failed;
  if (value < 400) return UI_TAP.resultCodes.ok;
  return value < 500 ? UI_TAP.resultCodes.rejected : UI_TAP.resultCodes.failed;
};

/** `ui.tap` / `ui.tap.repeated` 的日志载荷（**唯一一处**拼它 ⇒ 两个入口同形）。 */
const tapFields = ({ req, scope, target, page, tapId, sinceMs, realm }) => ({
  request_id: req?.requestId,
  scope,
  event: tapEventName(sinceMs),
  target,
  page,
  tap_id: tapId,
  since_ms: sinceMs === null || sinceMs === undefined || sinceMs === '' ? null : Number(sinceMs),
  ...(realm ? { realm } : {}),
  path: String(req?.originalUrl || '').split('?')[0],
});

/** ② `ui.tap.result` 的日志载荷（**唯一一处** ⇒ 扫码页与工作台同形；纯函数 ⇒ 可真红）。 */
const tapResultFields = ({ tapId, scope, status, code, durationMs, req }) => ({
  request_id: req?.requestId,
  scope,
  tap_id: clip(tapId, UI_TAP.maxTapIdLength),
  status: Number(status),
  code: resultCodeOf({ status, code }),
  duration_ms: Math.max(0, Number(durationMs) || 0),
  action: clip(req?.body?.action, UI_TAP.maxTargetLength),
  path: String(req?.originalUrl || '').split('?')[0],
});

/**
 * 服务端兜底生成一个 tap_id（**只有**旧页面 / 手改请求没带时才用）——
 * 有了它，那条 `ui.tap` 仍然可 grep；没有再来的写请求 ⇒ 自然没有结果事件（如实，不编 ✗）。
 */
const serverTapId = () => `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * `POST <tap path>`（扫码页 `/s/ui-tap`、`/r/ui-tap`；工作台 `/api/workbench/ui-tap`）——
 * **同一个处理**：
 *   · 关掉埋点（`UI_TAP_ENABLED`）⇒ **204 且一条日志都不打**（不是 400：她那边不该看到异常）；
 *   · 没有 `target` ⇒ **400**（不静默吞 ✓ —— 与改前逐字一致）；
 *   · 正常 ⇒ 记 `ui.tap` 或 `ui.tap.repeated`（服务端按窗口判）+ **204**，
 *     并在响应头 `x-ui-tap-event` 里**回**这次算成了哪个事件（204 没有 body ⇒ 只能用头；
 *     这也是"④ 能真红"的判据：用例断言头，不去拦日志 sink）。
 */
const handleUiTap = ({ req, res, scope = 'scan', realm = '' }) => {
  const fields = UI_TAP.fields;
  // 前端漏斗：同一个 beacon 端点，`kind=page_view`（不要求 target；与 tap 分支互不影响）
  if (String(req?.query?.kind || '') === 'page_view') {
    if (!FUNNEL.enabled) return res.status(204).end();
    const page = clip(req?.query?.page, FUNNEL.maxPageLength) || 'unknown';
    const step = funnelStepOf(req?.query?.step);
    const funnelFields = {
      request_id: req?.requestId,
      scope,
      view_source: 'client_beacon',
      page,
      ...(step ? { step } : {}),
      ...(realm ? { realm } : {}),
      path: String(req?.originalUrl || '').split('?')[0],
    };
    logInfo(FUNNEL.events.pageView, funnelFields);
    if (step) logInfo(FUNNEL.events.stepEnter, funnelFields);
    return res.status(204).end();
  }
  if (!UI_TAP.enabled) return res.status(204).end();
  const target = clip(req?.query?.[fields.target], UI_TAP.maxTargetLength);
  if (!target) return res.status(400).type('text').send('missing target');
  const page = clip(req?.query?.[fields.page], UI_TAP.maxPageLength);
  const tapId = clip(req?.query?.[fields.tapId], UI_TAP.maxTapIdLength) || serverTapId();
  const sinceMs = req?.query?.[fields.sinceMs];
  // ⚠️ `realm` 只有扫码页有（`?from=`）；工作台不传 ⇒ 日志里就不出现这个键（不编 ✗）。
  const payload = tapFields({ req, scope, target, page, tapId, sinceMs, realm });
  logInfo(payload.event, payload);
  res.set(fields.eventHeader, payload.event);
  return res.status(204).end();
};

/**
 * ② 结果事件：挂在**会写数据的请求**上。
 *   · 扫码页 ⇒ 只挂在**写 POST** 那一条路由上（`router.post(ROUTE_PATTERNS, …)`）；
 *   · 工作台 ⇒ 挂在**整条 `/api/workbench` router** 上（一个 `router.use` 覆盖所有写接口 ✓
 *     且排在既有鉴权闸门**之后** —— 未登录的请求不记埋点 ✓）。
 * ⚠️ 没带 `tap_id`（GET、旧页面、别的调用方）⇒ **不进这条链**（不记、也没有额外开销）。
 * ⚠️ 原因码：命中 `res.locals.uiTapCode` 就用它（各出口自己标），否则按状态分类。
 */
const uiTapResultMiddleware = (scope = 'scan') => (req, res, next) => {
  if (!UI_TAP.enabled) return next();
  const tapId = clip(req?.body?.[UI_TAP.fields.tapId], UI_TAP.maxTapIdLength);
  if (!tapId) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    logInfo(UI_TAP.events.result, tapResultFields({
      req, scope, tapId, status: res.statusCode,
      code: res.locals?.uiTapCode, durationMs: Date.now() - startedAt,
    }));
  });
  return next();
};

/** 各出口标一次"这次为什么是这个结果"（原因码）—— ② 的"为什么"就是它。 */
const markTapCode = (res, code) => {
  if (res?.locals && code) res.locals.uiTapCode = String(code).slice(0, 64);
  return res;
};

module.exports = {
  tapEventName,
  resultCodeOf,
  tapFields,
  tapResultFields,
  handleUiTap,
  uiTapResultMiddleware,
  markTapCode,
  serverTapId,
  clip,
};
