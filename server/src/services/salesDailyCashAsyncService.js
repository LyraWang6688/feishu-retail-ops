'use strict';

/**
 * 「每日现金」异步入口。
 *
 * 复用统一异步层 + 统一提交 toast：
 *   · HTTP 只 enqueue，返回 202 + job_id + SUBMIT_TOAST.text；
 *   · worker 复用 salesDailyCashService.save（同一天创建/更新同一条）；
 *   · 前端用 shared/asyncJob.js 等待终态，再刷新顶部信息。
 */
const crypto = require('node:crypto');
const { ASYNC_JOB_TYPES } = require('../config/asyncJobs');
const { SUBMIT_TOAST } = require('../config/submitToast');
const { submitToastUrl } = require('../utils/submitToast');
const { createSalesDailyCashService } = require('./salesDailyCashService');

const createSalesDailyCashAsyncService = ({ gateway, asyncJobs } = {}) => {
  if (!gateway) throw new Error('SalesDailyCashAsyncService requires gateway');
  if (!asyncJobs) throw new Error('SalesDailyCashAsyncService requires asyncJobs');
  const executor = createSalesDailyCashService({ gateway });

  const submit = async ({
    openingAmount, withdrawalAmount, operatorOpenId = '', operatorName = '',
    correlation = {}, submitKey = '',
  } = {}) => {
    if (openingAmount === undefined && withdrawalAmount === undefined) {
      throw Object.assign(new Error('amount_required'), { statusCode: 400 });
    }
    const key = String(submitKey || '').trim() || crypto.randomUUID();
    const jobId = asyncJobs.jobIdFor(ASYNC_JOB_TYPES.SALES_DAILY_CASH, key);
    const payload = { openingAmount, withdrawalAmount };
    const { job, created } = await asyncJobs.enqueue({
      jobId,
      type: ASYNC_JOB_TYPES.SALES_DAILY_CASH,
      payload,
      ownerOpenId: operatorOpenId,
      operatorName,
      meta: { correlation },
    });
    if (!job) throw new Error('异步任务创建失败');
    if (created) {
      setImmediate(() => {
        void asyncJobs.run({
          jobId,
          // 通用异步层用 `ok:true` 判定成功；save() 返回的是业务结果，必须补上。
          run: async () => ({ ok: true, ...(await executor.save(payload)) }),
          // 金额非法 / 没有期初记录属于业务拒绝，重试也不会变；由用户重新提交。
          classifyError: (error) => ({
            retryable: false,
            message: String(error?.message || 'sales_daily_cash_failed'),
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

module.exports = { createSalesDailyCashAsyncService };
