'use strict';

/**
 * 统一异步任务 · `running` 残留收敛（2026-11-14，#50）。
 *
 * 真实缺口：进程崩溃/重启后，最后一次 `begin()` 写下的 `running` 永远停在那里——
 * 原来只 warn 一条 `async_job.recover.running_orphaned`，**不迁移状态、不通知**，
 * 于是任务板上"还在跑"，实际早就没人跑了。
 *
 * 口径：**超龄的 `running` ⇒ `failed` + 失败通知**（通知里写明"需人工核对"，
 * 不猜它到底写没写成；是否真写成由各链路自己的幂等/断点记录判定）。
 * 阈值 `ASYNC_JOB_RUNNING_STALE_MINUTES`（默认 30 分钟）；周期巡检共用同一条判据。
 */

const { logInfo, logWarn } = require('../utils/logger');

const MINUTE = 60 * 1000;

const createAsyncJobRecovery = ({
  store,
  notifyIfNeeded,
  config = {},
  logger = { logInfo, logWarn },
  now = () => Date.now(),
} = {}) => async ({ olderThanMs } = {}) => {
  const configured = Number(config.recover?.staleRunningMinutes || 30);
  const thresholdMs = Number(olderThanMs) > 0 ? Number(olderThanMs) : configured * MINUTE;
  const jobs = await store.list();
  const running = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job && String(job.status || '') === 'running');
  const stale = running.filter((job) => {
    const started = Date.parse(String(job.started_at || job.created_at || ''));
    // 拿不到开始时间 ⇒ 当作超龄（不能让它永远悬着）
    return !Number.isFinite(started) || (now() - started) >= thresholdMs;
  });
  if (!stale.length) return { reaped: 0, ids: [] };

  // 人话必须在 config（`texts.recover.runningError`）；service 侧永远会传 config。
  // 这里只留英文兜底，避免把中文散写进 service（noHardcodedChinese 闸门）。
  const humanError = String(config.texts?.recover?.runningError || '') || 'running_orphaned_after_restart';
  const finishedAt = new Date(now()).toISOString();
  for (const job of stale) {
    // 走统一的 failed 状态 + 通知（notifyIfNeeded 已经按 notified_at 去重）
    await store.update(job.job_id, {
      status: 'failed',
      last_error: humanError,
      finished_at: finishedAt,
      recovered_from_running: true,
    });
    logger.logWarn('async_job.recover.running_reaped', {
      job_id: job.job_id,
      type: job.type || '',
      started_at: job.started_at || job.created_at || '',
      stale_minutes: Math.round(thresholdMs / MINUTE),
    });
    if (typeof notifyIfNeeded === 'function') await notifyIfNeeded(job.job_id);
  }
  logger.logInfo('async_job.recover.reaped', {
    count: stale.length, job_ids: stale.slice(0, 10).map((job) => job.job_id),
  });
  return { reaped: stale.length, ids: stale.map((job) => job.job_id) };
};

module.exports = { createAsyncJobRecovery };
