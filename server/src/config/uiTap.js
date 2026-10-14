// 「点击埋点」的**唯一一套**配置（业务负责人 2026-10-13「**我想查我点了几次**」→
// 2026-10-14 批准的埋点 P0 五条）。
//
// 为什么单独一个文件：**扫码页与工作台接的是同一套上报**（她 2026-10-14 晚批准的第 ⑤ 条：
//   「工作台接同一套上报」；Lead 的硬要求是**同一份实现、不抄第二份** ✗）——
//   事件名 / 字段名 / 判据窗口 / 两个入口的路径**只能有一处定义**，两边引用同一份。
//
// ⭐ 三条 P0（①③ 已上线，见 #548/#549）：
//   · ② **结果事件**：一次点击**后续**那笔请求的结果（HTTP 状态 + 原因码 + 耗时）
//        —— 单看 `ui.tap` 只知道"她点了"，不知道"点成了没有"；
//   · ④ **重复点击**：同一个 target 在短窗口内被点了第二次 ⇒ **独立事件** `ui.tap.repeated`
//        —— 她那句「领域/批次**要点 4、5 次**才切换」要的就是这个数；
//   · ⑤ 工作台接同一套（同一份实现 + 同一个端点契约）。
//
// 🔴 纪律（照旧）：
//   · **只记"我们的标识"**（`realm:replenish` / `submit:submit_order` / `workbench:orders:deliver`…）
//     —— **绝不采集表单值 / 个人信息 / 金额** ✗；
//   · 客户端**只报事实**（target / tap_id / since_ms）——「算不算重复」由**服务端**按本文件的窗口判 ✓
//     （客户端的判据不可信，也可能是旧页面）。
//   · 开关**显式布尔**（`readFlag`）：**不用** `process.env.X || fallback`（那样清空变量关不掉 ✗）。
const { readFlag, readInt, readString } = require('./envValue');

/**
 * 事件名（**唯一真源**）。
 * ⚠️ 客户端**不许自己拼事件名**（那等于让页面决定日志的语义 ✗）；它只报 `target/tap_id/since_ms`，
 *    `tap` 还是 `repeated` **由服务端**按 `repeatedWindowMs` 判（见 `utils/uiTapReport.js`）。
 */
const EVENTS = Object.freeze({
  // 一次点击（她点了什么）
  tap: readString(process.env, 'UI_TAP_EVENT_TAP', 'ui.tap'),
  // ④ 同一 target 在窗口内又被点了一次（独立事件 ⇒ 一 grep 就数得出来）
  repeated: readString(process.env, 'UI_TAP_EVENT_REPEATED', 'ui.tap.repeated'),
  // ② 那次点击**后续写请求**的结果（状态 + 原因码 + 耗时）
  result: readString(process.env, 'UI_TAP_EVENT_RESULT', 'ui.tap.result'),
});

/**
 * 结果事件的**原因码**（② 的"为什么"）。
 * ⭐ 取不到具体业务码时按状态分类（**稳定、可 grep、可聚合**）；
 *    拿得到具体码时（`res.locals.uiTapCode`）优先用它 ——
 *    与 ③ 那条「失败日志带人话原因码」同一个口径（`scan.write.settlement_blocked` 那类）。
 */
const RESULT_CODES = Object.freeze({
  ok: readString(process.env, 'UI_TAP_CODE_OK', 'ok'),
  rejected: readString(process.env, 'UI_TAP_CODE_REJECTED', 'rejected'),
  failed: readString(process.env, 'UI_TAP_CODE_FAILED', 'failed'),
});

/** 字段名（query / 提交体 / 响应头）——改名只改这里，客户端与服务端两边都不许写死。 */
const FIELDS = Object.freeze({
  target: 'target',
  // ⭐ ② 的关联键：**同一次点击**的 beacon 与它后面那笔写请求带的是**同一个** tap_id。
  tapId: 'tap_id',
  // 这次点击距"同一个 target 上一次点击"多少毫秒（客户端只报事实；**没有**上一次 ⇒ 不带）
  sinceMs: 'since_ms',
  page: 'page',
  // 表单里那个隐藏字段的名字（扫码页的表单要跟着 tap_id 一起提交 ⇒ 与 query 同名最简单）
  formField: 'tap_id',
  // 响应头：告诉客户端（与用例）这次被记成了哪个事件 —— 204 没有 body，只能用头 ✓
  eventHeader: 'x-ui-tap-event',
});

/**
 * 两个入口的路径：
 *   · 扫码页 ⇒ `/s/ui-tap` · `/r/ui-tap`：**相对路径的唯一真源是 `SCAN_PAGE.tapFeedback.reportPath`**
 *     （渲染层写 URL、路由挂端点，两边读的是同一个值 ⇒ 不会漂移 ✓）—— 这里不另立一份 ✗。
 *   · 工作台 ⇒ `/api/workbench/ui-tap`（`routes/workbench.js`，走**既有**工作台闸门 ✓）。
 */
const PATHS = Object.freeze({
  workbench: readString(process.env, 'UI_TAP_WORKBENCH_PATH', '/ui-tap'),
  // ⚠️ 客户端要知道**完整**路径（工作台那半在 `public/workbench/config/telemetry.js`，
  //    由用例钉住两边一致 ⇒ 不许悄悄漂移 ✗）
  workbenchFull: readString(process.env, 'UI_TAP_WORKBENCH_FULL_PATH', '/api/workbench/ui-tap'),
});

const UI_TAP = Object.freeze({
  enabled: readFlag(process.env, 'UI_TAP_ENABLED', true),
  events: EVENTS,
  resultCodes: RESULT_CODES,
  fields: FIELDS,
  paths: PATHS,
  // ④「重复点击」的判据窗口：同一个 target 在这个窗口内又被点 ⇒ 记 `ui.tap.repeated`。
  //    1.5 秒 = 人连续点两下的量级；再慢就是"两次正常的操作"，不该算重复 ✓（她可配）。
  repeatedWindowMs: readInt(process.env, 'UI_TAP_REPEATED_WINDOW_MS', 1500, { min: 100, max: 60000 }),
  // 单条埋点的长度上限（防脚本刷 / 防超长串把日志撑爆）；**只截断，不拒绝** ✓。
  maxTargetLength: readInt(process.env, 'UI_TAP_MAX_TARGET_LENGTH', 120, { min: 8, max: 500 }),
  maxPageLength: readInt(process.env, 'UI_TAP_MAX_PAGE_LENGTH', 32, { min: 4, max: 64 }),
  maxTapIdLength: readInt(process.env, 'UI_TAP_MAX_TAP_ID_LENGTH', 64, { min: 8, max: 200 }),
});

module.exports = { UI_TAP, EVENTS, RESULT_CODES, FIELDS, PATHS };
