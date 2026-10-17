'use strict';

/**
 * ⭐⭐ 2026-10-16（task-52 · 她点名的"核心"）：**补货 / 退货 / 验收 三条链路的「后台那一半」** ——
 *   三条**共用一个"同形"件**（形状照既有 `services/saleWriteBackgroundService.js` ✓ 不另发明 ✗）。
 *
 * 为什么是"同形"而不是"照抄三份"：三条链路的差别只在**参数**（哪张表 / 哪些列 / 幂等键），
 *   不在**调度语义**（先回成功页 ⇒ 后台写 ⇒ 失败如实可查可重试）⇒ 一处实现、三处注入 ✓
 *
 * 🔴 本件**不新开写库路径** ✓：
 *   · 真正"写"的那一步是**注入进来**的 `runRest`（调用方把它接到**既有**的写服务/路由上 ✓）
 *   · 本件**不 require** 任何具体 config（开关 / 超时 / 事件名**全部注入** ⇒ 谁调谁传 ✓
 *     ⇒ 它能先落地，**不依赖** `config/scanWrite.js` 那一刀（`retry-ui` 在动那两处 ✗））
 *   · `markFailed` 也**注入**（失败时"落成可查可重试的状态"由调用方给 ✓ 本件不认识那个值域 ✓）
 *
 * 口径（她 2026-10-16 逐字 + Lead 三条硬要求）：
 *   ① **先回成功页、后台写**（`fire-and-forget`：不 `await` ⇒ 不把她拖住 ✗）
 *   ② 🔴 **失败如实**：记 warn ＋ 调 `markFailed(...)` ⇒ 状态可查、可重试（**绝不假装成功** ✗）
 *   ③ 🔴 **幂等不拆**：重试/并发走**同一把 `submitKey`**（本件**只透传**，一个字不拼 ✗）
 *   ④ ⚠️ **校验仍当场同步拦**（金额非法/尺码不存在/超库存 ⇒ 当场 400 + 人话 + 零写入）
 *      ⇒ 本件**只管"校验通过之后的写库那一步"** ✓（它不该、也不会被用在校验前 ✗）
 *   ⑤ `phase` / 事件名 **全部走注入的 config**（不散写字符串 ✗）
 */
const { logInfo, logWarn } = require('../utils/logger');

/**
 * ⭐ "等后台那一跑跑完"的登记簿（与销售那件**同一个形状** ✓）——
 *   用例打真实路由时拿不到 `background` 句柄 ⇒ 先等它跑完再读表（判据一个字没改 ✓ 只是先等 ✓）。
 * ⚠️ **不轮询**（轮询靠真实计时器，本机降速会 flake ✗）⇒ 等的是**真 Promise** ✓。
 */
const pendingPurchaseBackgrounds = new Set();
const trackPurchaseBackground = (promise) => {
  pendingPurchaseBackgrounds.add(promise);
  const done = () => pendingPurchaseBackgrounds.delete(promise);
  promise.then(done, done);
  return promise;
};

/** 等到当前所有在飞的后台那一跑都跑完（空则立即返回）。用例专用入口 ✓ */
const waitForPendingPurchaseBackgrounds = async () => {
  while (pendingPurchaseBackgrounds.size) {
    await Promise.allSettled([...pendingPurchaseBackgrounds]);
  }
};

/**
 * @param {object} deps
 * @param {Function} deps.runRest    **注入**：真正"把余下几步写下去"的那一步（接既有写服务✓）
 * @param {Function} [deps.markFailed] **注入**：失败时把那一单落成"可查可重试"（不认识值域 ✓）
 * @param {object} [deps.purchaseAsync] **注入**的异步配置（`backgroundTimeoutMs` / `enabled`…）
 * @param {object} [deps.config]   **注入**：事件名 / phase 取值的唯一来源 ✓
 */
const createPurchaseWriteBackgroundService = ({ runRest, markFailed, purchaseAsync = {}, config = {} } = {}) => {
  /**
   * 排一次"后台那一跑"（补货 / 退货 / 验收 都走它 ✓）。
   *
   * @returns {Promise} 后台那一跑的 Promise（**同时**登记进登记簿 ✓）——调用方可 `await`（用例），
   *   也可不 await（路由 ⇒ 她已经拿到成功页了 ✓）
   */
  const schedulePurchaseRest = ({ chain = '', requestId = '', submitKey = '', context = {}, restInput = {} } = {}) => {
    const startedAt = Date.now();
    const timeoutMs = Number(purchaseAsync.backgroundTimeoutMs) || 0;
    const events = config.events || {};
    const phase = config.timing?.phase?.background || 'background';
    const promise = (async () => {
      try {
        const result = await runRest({ chain, requestId, submitKey, context, restInput });
        const durationMs = Date.now() - startedAt;
        // ⚠️ 后台那一跑**也要打 timing**（观测不缩水 ✓：转后台 ≠ 日志断档 ✗）
        if (events.restTiming) {
          logInfo(events.restTiming, {
            request_id: requestId, chain, phase, ok: result?.ok === true, duration_ms: durationMs,
            reused: result?.reused === true, timeout_ms: timeoutMs,
          });
        }
        if (result?.ok !== true) {
          // 🔴 **失败如实**：不抛给她（她早拿到成功页了）⇒ 但必须留痕 + 落"可重试"✓
          logWarn(events.restFailed || 'purchase.write.background.failed', {
            request_id: requestId, chain, duration_ms: durationMs,
            error: result?.message || 'unknown', hint: '后台写入没成功 ⇒ 状态可查、可点重试',
          });
          if (typeof markFailed === 'function') await markFailed({ chain, submitKey, context, result });
        }
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        logWarn(events.restFailed || 'purchase.write.background.failed', {
          request_id: requestId, chain, duration_ms: durationMs, error: error?.message,
          hint: '后台写入抛错 ⇒ 状态可查、可点重试（绝不假装成功）',
        });
        if (typeof markFailed === 'function') {
          try { await markFailed({ chain, submitKey, context, error }); } catch (markError) {
            logWarn(events.markFailedError || 'purchase.write.background.mark_failed_error', {
              request_id: requestId, chain, error: markError?.message,
            });
          }
        }
        return { ok: false, message: error?.message || 'background failed' };
      }
    })();
    return trackPurchaseBackground(promise);
  };

  /**
   * ⭐ 2026-10-18：**通用后台那一跑**（一单多货：整批 `engine.submitDraft`）——
   *   与 `schedulePurchaseRest` **同一套**登记簿 / 日志 / 失败落痕（只是 `run` 由调用方给 ✓）。
   *   失败 ⇒ 不报错给她（她已拿到成功页 ✓）⇒ 必须 warn ＋ 落"可重试"（会话 `last_error` ✓）。
   */
  const scheduleCustomRest = ({ chain = '', requestId = '', submitKey = '', context = {}, run, markFailed: markFailedFn } = {}) => {
    const startedAt = Date.now();
    const timeoutMs = Number(purchaseAsync.backgroundTimeoutMs) || 0;
    const events = config.events || {};
    const phase = config.timing?.phase?.background || 'background';
    const promise = (async () => {
      try {
        const result = await (typeof run === 'function' ? run() : { ok: false, message: 'no run' });
        const durationMs = Date.now() - startedAt;
        if (events.restTiming) {
          logInfo(events.restTiming, {
            request_id: requestId, chain, phase, ok: result?.ok === true, duration_ms: durationMs,
            reused: result?.reused === true, timeout_ms: timeoutMs,
          });
        }
        if (result?.ok !== true) {
          logWarn(events.restFailed || 'purchase.write.background.failed', {
            request_id: requestId, chain, duration_ms: durationMs,
            error: result?.message || 'unknown', hint: '后台写入没成功 ⇒ 状态可查、可点重试',
          });
          if (typeof markFailedFn === 'function') await markFailedFn({ chain, submitKey, context, result });
        }
        return result;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        logWarn(events.restFailed || 'purchase.write.background.failed', {
          request_id: requestId, chain, duration_ms: durationMs, error: error?.message,
          hint: '后台写入抛错 ⇒ 状态可查、可点重试（绝不假装成功）',
        });
        if (typeof markFailedFn === 'function') {
          try { await markFailedFn({ chain, submitKey, context, error }); } catch (markError) {
            logWarn(events.markFailedError || 'purchase.write.background.mark_failed_error', {
              request_id: requestId, chain, error: markError?.message,
            });
          }
        }
        return { ok: false, message: error?.message || 'background failed' };
      }
    })();
    return trackPurchaseBackground(promise);
  };

  return { schedulePurchaseRest, scheduleCustomRest };
};

module.exports = {
  createPurchaseWriteBackgroundService,
  trackPurchaseBackground,
  waitForPendingPurchaseBackgrounds,
};
