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

/**
 * ⭐⭐ 2026-10-15（task-48 a/c/d）：**流畅性**那几条事实上报时的**阈值与命名空间**（配置先行 ✓）。
 *
 * 🔴 **不新造事件名**：新事实仍然走**上面那套**（同一个端点 `/api/workbench/ui-tap`、同一个 `tap_id`），
 *    只把 `target` 放到 `fluency:` 命名空间里 ⇒ **服务端一行都不用改** ✓
 *    （要独立事件名得动 `src/config/uiTap.js` + 路由 —— 不在本任务写作用域，见体检表"未实施/为什么"✓）。
 *
 * 三条事实（都只是"她点了什么、页面给了什么"，**不含任何表单值/个人信息** ✗）：
 *   · `skeleton`  —— 进骨架 → 骨架被真内容换掉，**停留了多少毫秒**（"无声停留"的量化 ✗）
 *   · `card_swap` —— 这一屏卡片被**整块替换**了几次（"先出现一个配品再换表单"那类的量化 ✗）
 *   · `realm` / `form` / `error` —— 进了哪个 realm / 展开了哪个表单 / 前端 404 或 JS 报错（**统一入口** ✓）
 */
export const FLUENCY_TELEMETRY = Object.freeze({
  prefix: 'fluency:',
  // 超过这个毫秒数 ⇒ 打 `level:slow` 标（**只打标、不改事实** ⇒ 她照 `level:slow` 过滤就能挑出慢的 ✓）
  slowMs: 1000,
  // 骨架元素与卡片元素的约定标记（与既有 `data-tap-target` 同一套写法 ✓）
  skeletonAttr: 'data-skeleton',
  cardAttr: 'data-card',
  // `error` 事实只留这些键（与 `shared/ui-fluency.js` 的白名单**同一口径**；两边由用例钉住 ✓）
  errorKeys: ['level', 'status', 'path'],
});
