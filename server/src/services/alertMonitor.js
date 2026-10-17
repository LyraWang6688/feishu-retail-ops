'use strict';

/**
 * 观测告警的**判定器**（纯内存、可注入时间与发送器 ⇒ 可单测；不直接依赖飞书/网络）。
 *
 * 三条规则（业务口径见 `config/alerts.js`）：
 *   ① `error_rate`    —— 窗口内 error 占比 ≥ 阈值（且 error 数 ≥ 下限、总条数 ≥ 下限）
 *   ② `critical`      —— 命中了「关键链路」事件（`config.alerts.criticalEvents`）
 *   ③ `slow`          —— 单条 `duration_ms` ≥ `slowMs`
 *
 * 去重：同 key 在 `silentMinutes` 内只发一次；每窗口最多 `maxPerWindow` 条（防刷屏）。
 * 关闭时 `record()` 直接返回（不建窗口、不发消息）。
 */
const { OBSERVABILITY_ALERTS } = require('../config/alerts');

const formatText = (template, vars = {}) => String(template || '')
  .replace(/\{(\w+)\}/g, (_, key) => (vars[key] === undefined ? '' : String(vars[key])));

const createAlertMonitor = ({
  config = OBSERVABILITY_ALERTS,
  now = () => Date.now(),
  notify = async () => {},
} = {}) => {
  const windowMs = config.windowMinutes * 60 * 1000;
  const silentMs = config.silentMinutes * 60 * 1000;
  const critical = new Set(config.criticalEvents || []);
  // 注入的测试配置可能没带 texts ⇒ 用默认那一份（同一真源）
  const texts = config.texts || OBSERVABILITY_ALERTS.texts;
  const events = [];
  const lastSentAt = new Map();
  let windowStartedAt = 0;
  let windowSent = 0;

  const prune = (at) => {
    while (events.length && at - events[0].at > windowMs) events.shift();
  };

  const emit = (rule, key, text) => {
    const at = now();
    const last = lastSentAt.get(key);
    if (last !== undefined && at - last < silentMs) return null;
    if (at - windowStartedAt > windowMs) { windowStartedAt = at; windowSent = 0; }
    if (windowSent >= config.maxPerWindow) return null;
    lastSentAt.set(key, at);
    windowSent += 1;
    const alert = { rule, key, text, at };
    // 发送异步化，但**不吞掉**后续告警（早期版本用 sending 标记会丢掉同窗口的后几条 ✗）。
    // 递归风险：notifier 只会打 `observability.alert.sent/failed`（info/warn、无 duration）
    // ⇒ 不会再次命中三条规则；即使将来命中，窗口上限也会兜住。
    Promise.resolve().then(() => notify(alert)).catch(() => {});
    return alert;
  };

  /** 记录一条日志；返回本次触发的告警（测试用；生产忽略返回值）。 */
  const record = (payload = {}) => {
    if (!config.enabled) return [];
    const at = now();
    const event = String(payload.event || '');
    const level = String(payload.level || 'info');
    const duration = Number(payload.duration_ms);
    events.push({ at, level, event, duration_ms: Number.isFinite(duration) ? duration : null });
    prune(at);
    const alerts = [];
    const errors = events.filter((item) => item.level === 'error').length;
    const total = events.length;
    if (total >= config.errorRate.minTotal && errors >= config.errorRate.minErrors
      && (errors * 100) / total >= config.errorRate.thresholdPct) {
      const alert = emit('error_rate', 'error_rate', `${config.prefix} ${formatText(texts.errorRate, {
        rate: ((errors * 100) / total).toFixed(1),
        errors,
        total,
        minutes: config.windowMinutes,
        threshold: config.errorRate.thresholdPct,
      })}`);
      if (alert) alerts.push(alert);
    }
    if (level === 'error' && critical.has(event)) {
      const alert = emit('critical', `critical:${event}`, `${config.prefix} ${formatText(texts.critical, { event })}`);
      if (alert) alerts.push(alert);
    }
    if (Number.isFinite(duration) && duration >= config.slowMs) {
      const alert = emit('slow', `slow:${event}`, `${config.prefix} ${formatText(texts.slow, { event, duration, threshold: config.slowMs })}`);
      if (alert) alerts.push(alert);
    }
    return alerts;
  };

  return { record, _events: events };
};

module.exports = { createAlertMonitor };
