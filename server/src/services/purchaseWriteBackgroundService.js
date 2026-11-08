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
 *   · 本件**不 require** 任何具体 config（开关 / 超时 / 事件名**全部注入** ⇒ 谁调谁传 ✓）
 *   · `markFailed` 也**注入**（失败时"落成可查可重试的状态"由调用方给 ✓ 本件不认识那个值域 ✓）
 *
 * ⭐⭐ 2026-11-08（#948）：**统一异步任务层**（重试 / 失败发运营群）也走**注入** ——
 *   `jobRunner` 由调用方用 `services/asyncJobPurchaseRunner.js` 装配好传进来；
 *   不注入 ⇒ 逐字保持既有"单次"行为（既有用例 / 未接统一层的链路一个字节都不变 ✓）。
 *
 * 口径（她 2026-10-16 逐字 + Lead 三条硬要求）：
 *   ① **先回成功页、后台写**（`fire-and-forget`：不 `await` ⇒ 不把她拖住 ✗）
 *   ② 🔴 **失败如实**：记 warn ＋ 调 `markFailed(...)` ⇒ 状态可查、可重试（**绝不假装成功** ✗）
 *   ③ 🔴 **幂等不拆**：重试/并发走**同一把 `submitKey`**（本件与统一层**只透传**，一个字不拼 ✗）
 *   ④ ⚠️ **校验仍当场同步拦**（金额非法/尺码不存在/超库存 ⇒ 当场 400 + 人话 + 零写入）
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
 * @param {object} [deps.jobRunner] **注入**：统一任务适配器（`createAsyncJobPurchaseRunner` ✓）
 */
const createPurchaseWriteBackgroundService = ({
  runRest, markFailed, purchaseAsync = {}, config = {}, jobRunner = null,
} = {}) => {
  const events = config.events || {};
  // 失败提示语也**注入**（本件不 require config、更不写中文 ✗）
  const failedHint = config.texts?.backgroundFailedNotified || '';
  const phase = config.timing?.phase?.background || 'background';
  const timeoutMs = Number(purchaseAsync.backgroundTimeoutMs) || 0;

  /**
   * 一个"后台那一跑"的**公共收口**：跑（可带统一重试）⇒ 打 timing ⇒ 失败如实留痕 + `markFailed`。
   *
   * @param {object} input
   * @param {Function} input.runOnce   `({attempt}) => Promise<result>`（真正跑一次）
   * @param {Function} [input.onFailed] `({result,error}) => Promise`（默认用本件外的 `markFailed`）
   * @returns {Promise<object>} 最后一次的写库结果（**绝不把失败吞成成功**）
   */
  const runBackground = async ({
    chain, requestId, submitKey, context, jobMeta = {}, runOnce, onFailed,
  }) => {
    const startedAt = Date.now();
    const logTiming = (result, attempt) => {
      if (!events.restTiming) return;
      logInfo(events.restTiming, {
        request_id: requestId, submit_key: submitKey, chain, phase,
        ok: result?.ok === true, duration_ms: Date.now() - startedAt,
        reused: result?.reused === true, timeout_ms: timeoutMs,
        // 只有重试的那几次才带 attempt（第一跑日志形状保持原样）
        ...(Number(attempt) > 1 ? { attempt: Number(attempt) } : {}),
      });
    };
    const mark = typeof onFailed === 'function' ? onFailed : markFailed;

    // ⭐ #948：统一层可用 ⇒ 重试 + 最终失败通知都在 `jobRunner` / `asyncJobService` 里；
    //   `runOnce` 仍是**既有写入口**（一行没改）——本件不重写业务写表逻辑。
    if (jobRunner && jobRunner.ready === true) {
      let handled = null;
      try {
        handled = await jobRunner.run({
          chain, requestId, submitKey, jobMeta,
          runFn: async ({ attempt }) => {
            const result = await runOnce({ attempt });
            logTiming(result, attempt);
            return result;
          },
        });
      } catch (error) {
        // 统一层自身抛错（理论上不该发生）⇒ 仍要**如实留痕**，绝不把这一跑吞成成功 ✗
        logWarn(events.restFailed || 'purchase.write.background.failed', {
          request_id: requestId, submit_key: submitKey, chain,
          duration_ms: Date.now() - startedAt, error: error?.message,
          ...(failedHint ? { hint: failedHint } : {}),
        });
        if (typeof mark === 'function') {
          try { await mark({ chain, submitKey, context, error }); } catch (markError) {
            logWarn(events.markFailedError || 'purchase.write.background.mark_failed_error', {
              request_id: requestId, submit_key: submitKey, chain, error: markError?.message,
            });
          }
        }
        return { ok: false, message: error?.message || 'async job failed' };
      }
      // `handled:true` ⇒ 这一次写库**已经跑过了**（统一 job 或单次兜底）⇒ 本件不许再跑一遍 ✗
      if (handled?.handled) {
        const result = handled.result || {
          ok: handled.ok === true,
          message: String(handled.error?.message || handled.job?.last_error || ''),
        };
        if (handled.ok !== true && result?.ok !== true) {
          const errorText = String(result?.message || handled.error?.message || handled.job?.last_error || 'unknown');
          logWarn(events.restFailed || 'purchase.write.background.failed', {
            request_id: requestId, submit_key: submitKey, chain,
            duration_ms: Date.now() - startedAt, error: errorText,
            ...(handled.jobId ? { job_id: handled.jobId } : {}),
            attempts: Number(handled.job?.attempts || 0),
            ...(failedHint ? { hint: failedHint } : {}),
          });
          if (typeof mark === 'function') {
            try {
              await mark({ chain, submitKey, context, result, error: handled.error || undefined });
            } catch (markError) {
              logWarn(events.markFailedError || 'purchase.write.background.mark_failed_error', {
                request_id: requestId, submit_key: submitKey, chain, error: markError?.message,
              });
            }
          }
        }
        return result;
      }
    }

    // 未接统一层（或统一层不可用）⇒ **逐字保持既有单次行为**
    try {
      const result = await runOnce({ attempt: 1 });
      logTiming(result, 1);
      if (result?.ok !== true) {
        logWarn(events.restFailed || 'purchase.write.background.failed', {
          request_id: requestId, submit_key: submitKey, chain, duration_ms: Date.now() - startedAt,
          error: result?.message || 'unknown', hint: '后台写入没成功 ⇒ 状态可查、可点重试',
        });
        if (typeof mark === 'function') await mark({ chain, submitKey, context, result });
      }
      return result;
    } catch (error) {
      logWarn(events.restFailed || 'purchase.write.background.failed', {
        request_id: requestId, submit_key: submitKey, chain, duration_ms: Date.now() - startedAt,
        error: error?.message, hint: '后台写入抛错 ⇒ 状态可查、可点重试（绝不假装成功）',
      });
      if (typeof mark === 'function') {
        try { await mark({ chain, submitKey, context, error }); } catch (markError) {
          logWarn(events.markFailedError || 'purchase.write.background.mark_failed_error', {
            request_id: requestId, submit_key: submitKey, chain, error: markError?.message,
          });
        }
      }
      return { ok: false, message: error?.message || 'background failed' };
    }
  };

  /**
   * 排一次"后台那一跑"（补货 / 退货 / 验收 都走它 ✓）。
   *
   * @returns {Promise} 后台那一跑的 Promise（**同时**登记进登记簿 ✓）——调用方可 `await`（用例），
   *   也可不 await（路由 ⇒ 她已经拿到成功页了 ✓）
   */
  const schedulePurchaseRest = ({
    chain = '', requestId = '', submitKey = '', context = {}, restInput = {}, jobMeta = {},
  } = {}) => trackPurchaseBackground(runBackground({
    chain,
    requestId,
    submitKey,
    // ⚠️ `jobMeta` 只进**统一任务记录**（状态接口 / 群通知要用的单号 / 批次 / 操作人），
    //    **不混进写库入参**（`runRest` 拿到的 `context` 逐字不变）
    context,
    jobMeta,
    runOnce: () => runRest({ chain, requestId, submitKey, context, restInput }),
  }));

  /**
   * ⭐ 2026-10-18：**通用后台那一跑**（一单多货：整批 `engine.submitDraft`）——
   *   与 `schedulePurchaseRest` **同一套**登记簿 / 日志 / 失败落痕（只是 `run` 由调用方给 ✓）。
   *   失败 ⇒ 不报错给她（她已拿到成功页 ✓）⇒ 必须 warn ＋ 落"可重试"（会话 `last_error` ✓）。
   */
  const scheduleCustomRest = ({
    chain = '', requestId = '', submitKey = '', context = {}, run, markFailed: markFailedFn, jobMeta = {},
  } = {}) => trackPurchaseBackground(runBackground({
    chain,
    requestId,
    submitKey,
    context,
    jobMeta,
    runOnce: () => (typeof run === 'function' ? run() : { ok: false, message: 'no run' }),
    onFailed: markFailedFn,
  }));

  return { schedulePurchaseRest, scheduleCustomRest };
};

module.exports = {
  createPurchaseWriteBackgroundService,
  trackPurchaseBackground,
  waitForPendingPurchaseBackgrounds,
};
