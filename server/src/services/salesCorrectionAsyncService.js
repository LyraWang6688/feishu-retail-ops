'use strict';

/**
 * 确认单整单更正 —— 异步入口。
 *
 * 复用项目已有的统一异步层 + 统一提交 toast：
 *   · HTTP 只入队，返回 202 + job_id + redirect_url；
 *   · 后台 worker 执行 SalesCorrectionService.correct；
 *   · 业务失败不自动重试（本地任务已有 submitKey 幂等，重试到同一 key 会变成“待核对”）。
 */
const crypto = require('node:crypto');
const { ASYNC_JOBS, ASYNC_JOB_TYPES } = require('../config/asyncJobs');
const { SUBMIT_TOAST } = require('../config/submitToast');
const { submitToastUrl } = require('../utils/submitToast');

const createSalesCorrectionAsyncService = ({ correctionService, asyncJobs } = {}) => {
  if (!correctionService) throw new Error('SalesCorrectionAsyncService requires correctionService');
  if (!asyncJobs) throw new Error('SalesCorrectionAsyncService requires asyncJobs');

  const submit = async ({
    payload = {}, actor = {}, operatorOpenId = '', operatorName = '', correlation = {},
  } = {}) => {
    const submitKey = String(payload.submitKey || '').trim();
    if (!submitKey) throw Object.assign(new Error('submitKey required'), { statusCode: 400 });
    if (!Array.isArray(payload.details) || !payload.details.length) {
      throw Object.assign(new Error('details required'), { statusCode: 400 });
    }
    const jobId = asyncJobs.jobIdFor(ASYNC_JOB_TYPES.SALES_CORRECTION, submitKey);
    const { job, created } = await asyncJobs.enqueue({
      jobId,
      type: ASYNC_JOB_TYPES.SALES_CORRECTION,
      payload: { ...payload, actor },
      ownerOpenId: operatorOpenId,
      operatorName,
      meta: { correlation, step: ASYNC_JOBS.texts.stepLabels.salesCorrection },
    });
    if (!job) throw new Error('异步任务创建失败');
    if (created) {
      setImmediate(() => {
        void asyncJobs.run({
          jobId,
          run: async () => ({ ok: true, ...(await correctionService.correct(payload, { actor, requestId: submitKey })) }),
          // 确认单写库不是可安全重放的重试：失败后本地任务已是“待核对”，由她重新发起。
          classifyError: (error) => ({
            retryable: false,
            message: String(error?.message || 'sales_correction_failed'),
          }),
        }).catch(() => undefined);
      });
    }
    return {
      jobId,
      reused: !created,
      status: job.status,
      toast: SUBMIT_TOAST.text,
      redirect_url: submitToastUrl(),
    };
  };

  return { submit };
};

module.exports = { createSalesCorrectionAsyncService };
