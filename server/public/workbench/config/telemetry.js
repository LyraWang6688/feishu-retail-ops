// ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤「工作台接同一套上报」）：工作台**客户端**这一侧的上报配置。
//
// 🔴 **唯一真源在服务端** `src/config/uiTap.js`（`UI_TAP.paths.workbenchFull` / `events` /
//    `fields`）—— 这里是客户端那一份，**由用例钉住两边逐字一致**（`test/uiTapTelemetry.test.js`）
//    ⇒ 改路径/字段时**两边一起改**，不许悄悄漂移 ✗。
//
// ⚠️ 客户端**只报事实**（target / tap_id / since_ms / page）；
//    「算不算重复点击（`ui.tap.repeated`）」由**服务端**按配置窗口判 —— 客户端不判 ✓。
export const TAP_TELEMETRY = Object.freeze({
  // 完整地址（工作台路由挂在 `/api/workbench` 下；处理体与扫码页是**同一个** `handleUiTap`）
  path: '/api/workbench/ui-tap',
  // 日志里的 `page`（扫码页那边是 `scan` / `accept`）
  page: 'workbench',
  // 「点一下就要上报」的元素标记（与扫码页同一套 `data-tap-target` 约定 ✓）
  targetAttr: 'data-tap-target',
  // ⭐ ② 的关联键：点击产生的 `tap_id` 随写请求的 body 回去 ⇒ 服务端记 `ui.tap.result`
  formField: 'tap_id',
});
