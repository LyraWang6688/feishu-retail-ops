'use strict';

/**
 * 「样例图 → 云盘」**存量补齐**（业务负责人 2026-11-10：数据配置里的按钮卡 = 存量写入）。
 *
 * 与"新增触发"那条链路的关系：
 *   · 新增触发走事件（`routes/larkEvents.js` → `sampleImageDriveService.handleTableChanges`，只认 record_added）；
 *   · **本件只补历史**：扫「货品信息」全表，挑出**有样例图、但「已同步云盘」没勾**的记录，
 *     逐条交给同一个 `sampleImageDriveService.syncRecord`（同一条上传/勾选逻辑，不抄第二份）。
 *
 * ⭐⭐ 2026-11-10（第二轮，业务负责人要"异步 + 轻量 toast"）：
 *   接入**统一异步任务**（`config/asyncJobs.js` + `services/asyncJobService.js`，issue #948）——
 *   · 每一轮 = 一个 job（`type = sample_image_backfill`，id 由 `jobIdFor(type, key)` 派生）；
 *   · 临时错误按统一策略重试（退避复用同一幂等键）；最终失败 / 部分失败 ⇒ **发运营群**（统一层负责）；
 *   · 页面只轮询**计数**（本文件内存状态 + job 的终态），**不显示失败提示**（失败只在运营群）。
 *   ⚠️ 统一异步层被关掉（`ASYNC_JOB_ENABLED=false`）时退回"进程内跑"：行为照旧，只是没有 job 可查。
 *
 * 为什么放后台：存量 ~184 条 ×（下载 + 上传）≈ 几分钟；HTTP 请求不能挂那么久 ⇒ `start()` 立刻返回，
 * 页面轮询 `statusWithJob()` 看进度。
 *
 * 幂等：已勾的跳过；失败不勾 ⇒ 再点一次只补剩下的（同名覆盖仍生效，不堆重复文件）。
 * 串行：drive 上传官方限制 5 QPS / 10000 次每天、不支持并发 ⇒ 一条一条来（不 Promise.all）。
 */

const { logInfo, logWarn, logError } = require('../utils/logger');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SAMPLE_IMAGE_DRIVE } = require('../config/sampleImageDrive');
const { ASYNC_JOB_TYPES } = require('../config/asyncJobs');
const { jobIdFor } = require('./asyncJobStore');
const { isImageAttachment } = require('./sampleImageDriveService');

const nowIso = (now) => now().toISOString();

/**
 * @param {object} options
 * @param {object} options.gateway    V1BitableGateway（读整表 + 交给 syncRecord）
 * @param {object} options.driveService `createSampleImageDriveService(...)`（真上传 + 勾选）
 * @param {object} [options.jobs]    统一异步任务服务（`getAsyncJobService()`；null = 关掉）
 * @param {object} [options.config]  覆盖 `SAMPLE_IMAGE_DRIVE`（测试注入）
 * @param {Function} [options.now]   测试注入时钟
 */
const createSampleImageBackfillService = ({
  gateway, driveService, jobs = null, config = SAMPLE_IMAGE_DRIVE, now = () => new Date(),
} = {}) => {
  if (!gateway) throw new Error('存量补齐缺少 gateway');
  if (!driveService || typeof driveService.syncRecord !== 'function') {
    throw new Error('存量补齐缺少 driveService（需 sampleImageDriveService）');
  }

  const table = V1_BITABLE_SCHEMA.tables.product;
  const sampleImageField = table.fields[config.fields.sampleImage];
  const syncedField = table.fields[config.fields.synced];
  if (!sampleImageField || !syncedField) {
    throw new Error('「货品信息」schema 缺少样例图 / 已同步云盘 字段映射');
  }

  let state = emptyState();
  let current = null; // { jobId, promise }
  let runAuth = { userAccessToken: '' }; // 本轮点击人的 user token（内存；不落日志/磁盘）

  function emptyState() {
    return {
      running: false,
      started_at: null,
      finished_at: null,
      total: 0,
      done: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
      error: '',
      job_id: '',
      job_status: '',
    };
  }

  /** 有图（附件数组里有图片）且没勾。 */
  const isPending = (record) => {
    const fields = record?.fields || {};
    if (fields?.[syncedField] === true) return false;
    const images = Array.isArray(fields?.[sampleImageField]) ? fields[sampleImageField] : [];
    return images.some((item) => item && item.file_token && isImageAttachment(item));
  };

  const status = () => ({ ...state });

  /**
   * 跑一轮（可被统一异步层重试多次）：
   *   · `attempt === 1` 重置计数；重试时**累加**（前一轮已勾的记录会被跳过，计数只增不减）。
   *   · 返回这一轮**新增**的失败条数（统一层据此判 `partial`）。
   */
  const runOnce = async ({ attempt = 1 } = {}) => {
    if (attempt === 1) {
      state.total = 0;
      state.done = 0;
      state.synced = 0;
      state.skipped = 0;
      state.failed = 0;
    }
    const records = await gateway.listAll('product');
    const pending = (records || []).filter(isPending);
    const maxRecords = Number(config.backfill?.maxRecords) > 0 ? Number(config.backfill.maxRecords) : 0;
    const targets = maxRecords ? pending.slice(0, maxRecords) : pending;
    state.total = Math.max(state.total, targets.length);
    if (attempt === 1) {
      logInfo('product.sample_image.drive.backfill.started', {
        pending: pending.length, targets: targets.length, max_records: maxRecords,
      });
    } else {
      logInfo('product.sample_image.drive.backfill.retry', { attempt, pending: pending.length });
    }

    let attemptFailed = 0;
    for (const record of targets) {
      const recordId = record?.record_id;
      if (!recordId) continue;
      // eslint-disable-next-line no-await-in-loop —— 官方限制：上传不支持并发（5 QPS）
      const result = await driveService.syncRecord(recordId, { reason: 'backfill', driveAuth: runAuth });
      state.done += 1;
      if (result?.status === 'synced') state.synced += 1;
      else if (result?.status === 'failed') { state.failed += 1; attemptFailed += 1; }
      else state.skipped += 1;
    }
    return {
      ok: true,
      total: state.total,
      done: state.done,
      synced: state.synced,
      skipped: state.skipped,
      failed: state.failed,
      attempt_failed: attemptFailed,
    };
  };

  const finishLocal = (job = null) => {
    state.running = false;
    state.finished_at = nowIso(now);
    if (job?.status) state.job_status = job.status;
    if (job?.last_error) state.error = String(job.last_error);
    logInfo('product.sample_image.drive.backfill.done', {
      total: state.total, synced: state.synced, skipped: state.skipped, failed: state.failed,
      job_id: state.job_id, job_status: state.job_status || '',
    });
  };

  const runInProcess = () => {
    const promise = (async () => {
      try {
        const summary = await runOnce({ attempt: 1 });
        finishLocal({ status: summary.attempt_failed > 0 ? 'partial_failed' : 'succeeded' });
        return summary;
      } catch (error) {
        state.running = false;
        state.finished_at = nowIso(now);
        state.error = String(error?.message || error);
        logError('product.sample_image.drive.backfill.failed', { error: state.error });
        throw error;
      }
    })();
    return promise;
  };

  /**
   * 启动一轮（统一异步任务）。同一时间只跑一轮：再点 ⇒ `started:false`（返回同一个 job_id）。
   * @returns {Promise<{started:boolean, running:boolean, job_id:string, status:object}>}
   */
  const start = async ({ ownerOpenId = '', operatorName = '', driveAuth = {} } = {}) => {
    if (current) {
      return { started: false, running: true, job_id: state.job_id, status: status() };
    }
    runAuth = { userAccessToken: String(driveAuth?.userAccessToken || '').trim() };
    state = { ...emptyState(), running: true, started_at: nowIso(now) };

    // 统一异步层关掉 ⇒ 退回进程内跑（页面行为不变，只是没有 job 可查）
    if (!jobs) {
      const promise = runInProcess();
      current = { jobId: '', promise };
      promise.catch(() => {}).finally(() => { current = null; });
      return { started: true, running: true, job_id: '', status: status() };
    }

    const key = `sample_image_backfill_${now().toISOString()}`;
    const jobId = jobIdFor(ASYNC_JOB_TYPES.SAMPLE_IMAGE_BACKFILL, key);
    state.job_id = jobId;
    state.job_status = 'queued';
    const enqueued = await jobs.enqueue({
      jobId,
      type: ASYNC_JOB_TYPES.SAMPLE_IMAGE_BACKFILL,
      ownerOpenId,
      operatorName,
      // 只放"这一轮是什么"，不放任何图片/记录内容（状态接口也不回 payload）
      payload: { folder_token: config.folder?.token || '', source: 'data-config', uploader: runAuth.userAccessToken ? 'user' : 'tenant' },
      meta: { source: 'workbench.data-config' },
    });
    if (!enqueued?.job) {
      // 入队失败（例如存储异常）：如实退回进程内跑，不假装有 job
      const promise = runInProcess();
      current = { jobId: '', promise };
      promise.catch(() => {}).finally(() => { current = null; });
      return { started: true, running: true, job_id: '', status: status() };
    }
    state.job_status = enqueued.job.status || 'queued';

    const promise = jobs.run({
      jobId,
      // 重试仍复用同一个 job / 幂等键（统一层要求）
      run: ({ attempt }) => runOnce({ attempt: attempt || 1 }),
      // 有记录失败 ⇒ 终态 partial_failed（**不重试整轮**，让统一层发运营群 + 页面只给计数）
      classifyResult: (result) => (Number(result?.attempt_failed) > 0
        ? { ok: false, partial: true, message: `failed ${result.attempt_failed}` }
        : { ok: true }),
    });
    current = { jobId, promise };
    promise
      .then((job) => finishLocal(job))
      .catch((error) => {
        state.running = false;
        state.finished_at = nowIso(now);
        state.error = String(error?.message || error);
        logError('product.sample_image.drive.backfill.failed', { job_id: jobId, error: state.error });
      })
      .finally(() => { current = null; });
    return { started: true, running: true, job_id: jobId, status: status() };
  };

  /** 页面轮询用：内存计数 + job 终态（读一次统一 job；拿不到就用内存状态）。 */
  const statusWithJob = async () => {
    const snapshot = status();
    if (!snapshot.job_id || !jobs) return snapshot;
    try {
      const job = await jobs.get(snapshot.job_id);
      if (job) {
        snapshot.job_status = job.status || snapshot.job_status;
        snapshot.last_error = job.last_error || '';
      }
    } catch (error) {
      logWarn('product.sample_image.drive.backfill.status_job_failed', {
        job_id: snapshot.job_id, error: String(error?.message || error),
      });
    }
    return snapshot;
  };

  /** 用例专用：等到后台这一轮跑完（没有在跑 ⇒ 立即返回）。 */
  const waitForIdle = async () => {
    if (current?.promise) await current.promise.catch(() => {});
    return status();
  };

  return { start, status, statusWithJob, waitForIdle, isPending };
};

module.exports = { createSampleImageBackfillService };
