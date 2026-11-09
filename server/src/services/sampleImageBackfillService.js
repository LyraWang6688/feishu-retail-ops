'use strict';

/**
 * 「样例图 → 云盘」**存量补齐**（业务负责人 2026-11-10：数据配置里加一张按钮卡，点它就是存量写入）。
 *
 * 与"新增触发"那条链路的关系：
 *   · 新增触发走事件（`routes/larkEvents.js` → `sampleImageDriveService.handleTableChanges`，只认 record_added）；
 *   · **本件只补历史**：扫「货品信息」全表，挑出**有样例图、但「已同步云盘」没勾**的记录，
 *     逐条交给同一个 `sampleImageDriveService.syncRecord`（同一条上传/勾选逻辑，不抄第二份）。
 *
 * 为什么放后台（不阻塞请求）：
 *   存量 ~184 条 × （下载 + 上传）≈ 几分钟；HTTP 请求不能挂那么久 ⇒ `start()` 立刻返回，
 *   页面轮询 `status()` 看进度。
 *
 * 幂等：已勾的跳过；中途失败/中断的记录保持未勾 ⇒ 再点一次只会补剩下的（不会重复堆文件，
 *   同名覆盖那条规则仍生效）。
 *
 * 串行：drive 上传官方限制 5 QPS / 10000 次每天、不支持并发 ⇒ 一条一条来（不 Promise.all）。
 */

const { logInfo, logWarn, logError } = require('../utils/logger');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SAMPLE_IMAGE_DRIVE } = require('../config/sampleImageDrive');
const { isImageAttachment } = require('./sampleImageDriveService');

const nowIso = () => new Date().toISOString();

/**
 * @param {object} options
 * @param {object} options.gateway    V1BitableGateway（读整表 + 交给 syncRecord）
 * @param {object} options.driveService `createSampleImageDriveService(...)`（真上传 + 勾选）
 * @param {object} [options.config]  覆盖 `SAMPLE_IMAGE_DRIVE`（测试注入）
 */
const createSampleImageBackfillService = ({ gateway, driveService, config = SAMPLE_IMAGE_DRIVE } = {}) => {
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
  let runningPromise = null;

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

  const run = async () => {
    try {
      const records = await gateway.listAll('product');
      const pending = (records || []).filter(isPending);
      const maxRecords = Number(config.backfill?.maxRecords) > 0 ? Number(config.backfill.maxRecords) : 0;
      const targets = maxRecords ? pending.slice(0, maxRecords) : pending;
      state.total = targets.length;
      logInfo('product.sample_image.drive.backfill.started', {
        pending: pending.length, targets: targets.length, max_records: maxRecords,
      });

      for (const record of targets) {
        const recordId = record?.record_id;
        if (!recordId) continue;
        // eslint-disable-next-line no-await-in-loop —— 官方限制：上传不支持并发（5 QPS）
        const result = await driveService.syncRecord(recordId, { reason: 'backfill' });
        state.done += 1;
        if (result?.status === 'synced') state.synced += 1;
        else if (result?.status === 'failed') state.failed += 1;
        else state.skipped += 1;
      }

      state.finished_at = nowIso();
      state.running = false;
      logInfo('product.sample_image.drive.backfill.done', {
        total: state.total, synced: state.synced, skipped: state.skipped, failed: state.failed,
      });
    } catch (error) {
      state.running = false;
      state.finished_at = nowIso();
      state.error = String(error?.message || error);
      logError('product.sample_image.drive.backfill.failed', { error: state.error });
    }
    return status();
  };

  /**
   * 启动一次存量补齐（已经有一轮在跑 ⇒ 不并发，直接返回 `started:false`）。
   * `done` 是后台那一轮的 promise（业务页面不 await；**用例**可以 await 它来断言结果）。
   */
  const start = () => {
    if (state.running) return { started: false, running: true, status: status() };
    state = { ...emptyState(), running: true, started_at: nowIso() };
    runningPromise = run();
    return { started: true, running: true, status: status(), done: runningPromise };
  };

  /** 用例专用：等到后台这一轮跑完（没有在跑 ⇒ 立即返回）。 */
  const waitForIdle = async () => {
    if (runningPromise) await runningPromise;
    return status();
  };

  return { start, status, waitForIdle, isPending };
};

module.exports = { createSampleImageBackfillService };
