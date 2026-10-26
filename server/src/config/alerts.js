'use strict';

/**
 * 观测告警（埋点第 3 刀）—— **配置先行 + 默认关**：
 *   · `OBSERVABILITY_ALERTS_ENABLED` 显式布尔，默认 `false` ⇒ 不挂监听器、不发任何消息；
 *   · 打开后由 `services/alertMonitor.js` 在内存窗口里判 3 条规则，命中即发飞书群；
 *   · 去重：同一条规则（同 key）`silentMinutes` 内只发一次，且每窗口最多 `maxPerWindow` 条。
 * 默认收件群 = `PURCHASE_CHAT_ID`（既有采购群）；可用 `OBSERVABILITY_ALERTS_CHAT_ID` 覆盖。
 */
const { readFlag, readInt, readList, readString } = require('./envValue');

const DEFAULT_CRITICAL_EVENTS = [
  'bitable.record.create_failed',
  'bitable.record.batch_create_failed',
  'bitable.record.batch_update_failed',
  'bitable.record.batch_delete_failed',
  'bitable.record.batch_write_mismatch',
  'scan.sale.background_failed',
  'scan.sale.async.failed',
  'scan.sale.async.enqueue_failed',
  'scan.sale.async.start_failed',
  'scan.sale.order_no.allocate_failed',
  'scan.purchase.background_failed',
  'scan.purchase.background_mark_failed',
  'bitable.record.update_failed',
  'inventory.change.failed',
  'scan.write.failed',
  'label_print.job.failed',
];

const OBSERVABILITY_ALERTS = Object.freeze({
  enabled: readFlag(process.env, 'OBSERVABILITY_ALERTS_ENABLED', false),
  windowMinutes: readInt(process.env, 'OBSERVABILITY_ALERTS_WINDOW_MINUTES', 15, { min: 1, max: 1440 }),
  silentMinutes: readInt(process.env, 'OBSERVABILITY_ALERTS_SILENT_MINUTES', 60, { min: 1, max: 1440 }),
  maxPerWindow: readInt(process.env, 'OBSERVABILITY_ALERTS_MAX_PER_WINDOW', 3, { min: 1, max: 50 }),
  slowMs: readInt(process.env, 'OBSERVABILITY_ALERTS_SLOW_MS', 10000, { min: 1, max: 600000 }),
  // 慢事件只对**业务链路**（perf.request.completed）报警：`http.request.completed` 是全局请求日志，
  // 与它同一请求会重复报（实测 2026-10-18 03:29 同一次 18259ms 报了两条 ✗），且含长连接/静态资源。
  slowEvents: readList(process.env, 'OBSERVABILITY_ALERTS_SLOW_EVENTS') ?? ['perf.request.completed',
    'bitable.record.batch_created', 'bitable.record.batch_updated', 'bitable.record.batch_deleted',
    'scan.sale.timing', 'scan.purchase.background.timing'],
  errorRate: Object.freeze({
    thresholdPct: readInt(process.env, 'OBSERVABILITY_ALERTS_ERROR_RATE_PCT', 5, { min: 1, max: 100 }),
    minErrors: readInt(process.env, 'OBSERVABILITY_ALERTS_MIN_ERRORS', 3, { min: 1, max: 1000 }),
    minTotal: readInt(process.env, 'OBSERVABILITY_ALERTS_MIN_TOTAL', 20, { min: 1, max: 100000 }),
  }),
  warningCriticalEvents: readList(process.env, 'OBSERVABILITY_ALERT_CRITICAL_WARN_EVENTS') ?? [
    'bitable.record.batch_write_mismatch', 'scan.sale.background_failed',
    'scan.sale.async.failed', 'scan.sale.async.enqueue_failed',
    'scan.sale.async.start_failed', 'scan.sale.order_no.allocate_failed',
    'scan.purchase.background_failed', 'scan.purchase.background_mark_failed',
  ],
  criticalEvents: readList(process.env, 'OBSERVABILITY_ALERT_CRITICAL_EVENTS') ?? DEFAULT_CRITICAL_EVENTS,
  // ⭐ 私发：优先发给这个 open_id（业务负责人 2026-10-17 指定「私发给我的邯美皮鞋账号」）。
  //   ⚠️ 这是**只发不收**的出站消息，**不恢复私聊录入入口**（那条链路仍按 2026-10-07 口径删除）。
  openId: readString(process.env, 'OBSERVABILITY_ALERTS_OPEN_ID', ''),
  chatId: readString(process.env, 'OBSERVABILITY_ALERTS_CHAT_ID', ''),
  prefix: readString(process.env, 'OBSERVABILITY_ALERTS_PREFIX', '【观测告警】'),
  // 用户可见文案的唯一真源（service 里不许写中文；占位符 `{name}` 由 alertMonitor 填）
  texts: Object.freeze({
    errorRate: 'error 占比 {rate}%（{errors}/{total}，窗口 {minutes} 分钟，阈值 {threshold}%）',
    critical: '关键链路失败：{event}',
    slow: '慢事件：{event}{chain} {duration}ms（阈值 {threshold}ms）',
  }),
});

module.exports = { OBSERVABILITY_ALERTS, DEFAULT_CRITICAL_EVENTS };
