'use strict';

/**
 * 货品下架（软删除）异步入口。
 *
 * 复用项目统一异步层（#948）与统一提交 toast：
 *   · HTTP 只负责 enqueue，返回 job_id + SUBMIT_TOAST.text；
 *   · worker 复用 productDelistService 的归档 + 「下架=true」写入；
 *   · 前端用 shared/asyncJob.js 等待终态，再刷新列表。
 */
const crypto = require('node:crypto');
const { ASYNC_JOB_TYPES } = require('../config/asyncJobs');
const { SUBMIT_TOAST } = require('../config/submitToast');
const { createProductDelistService } = require('./productDelistService');

const createProductDelistAsyncService = ({ gateway, asyncJobs } = {}) => {
  if (!gateway) throw new Error('ProductDelistAsyncService requires gateway');
  if (!asyncJobs) throw new Error('ProductDelistAsyncService requires asyncJobs');
  const executor = createProductDelistService({ gateway });

  const submit = async ({
    recordId, allowNoSample = false, operatorOpenId = '', operatorName = '',
    correlation = {}, submitKey = '',
  } = {}) => {
    const id = String(recordId || '').trim();
    if (!id) throw Object.assign(new Error('missing_record_id'), { statusCode: 400 });
    const key = String(submitKey || '').trim() || crypto.randomUUID();
    const jobId = asyncJobs.jobIdFor(ASYNC_JOB_TYPES.PRODUCT_DELIST, key);
    const payload = {
      recordId: id,
      allowNoSample: allowNoSample === true,
      operatorOpenId: String(operatorOpenId || ''),
      correlation,
    };
    const { job, created } = await asyncJobs.enqueue({
      jobId,
      type: ASYNC_JOB_TYPES.PRODUCT_DELIST,
      payload,
      ownerOpenId: operatorOpenId,
      operatorName,
    });
    if (!job) throw new Error('异步任务创建失败');
    if (created) {
      setImmediate(() => {
        void asyncJobs.run({
          jobId,
          run: async () => {
            const result = await executor.deleteDelistedProduct(payload);
            if (!result.ok) {
              const error = Object.assign(new Error(result.reason || 'product_delist_failed'), {
                statusCode: result.reason === 'archive_failed' ? 502 : 400,
                code: result.reason || '',
                nonRetryable: true,
              });
              throw error;
            }
            return result;
          },
          // 业务拒绝（没样例图 / 记录不存在 / 归档失败）不自动重试；由用户重新提交。
          classifyError: (error) => ({
            retryable: false,
            message: String(error?.message || 'product_delist_failed'),
          }),
        }).catch(() => undefined);
      });
    }
    return {
      jobId,
      reused: !created,
      status: job.status,
      toast: SUBMIT_TOAST.text,
    };
  };

  return { submit };
};

module.exports = { createProductDelistAsyncService };
