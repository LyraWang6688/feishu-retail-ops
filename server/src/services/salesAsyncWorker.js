'use strict';

/**
 * 销售异步 worker（2026-10-27）。
 *
 * 浏览器请求只负责：校验 + 冻结 payload + 入队 + 返回单号。
 * worker 负责：建销售主表 → 复用既有 submitSale（明细/收款批量、库存批量、一次收口）。
 * 🔴 业务写表逻辑不在这里重写；这里只做“用冻结 payload 重建一个 job 专用会话”的接线。
 */
const { person } = require('./v1ReferenceResolver');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_STATUS_WRITE_VALUES } = require('../config/salesStatusDimensions');
const { SCAN_WRITE } = require('../config/scanWrite');
const {
  ASYNC_JOBS, ASYNC_JOB_STATUS, ASYNC_JOB_TYPES, classifyResultOutcome,
} = require('../config/asyncJobs');
const { createSalesJobStore, STATUS } = require('./salesJobStore');
const { buildSalePayload } = require('./salesPayload');
const { logInfo, logWarn, logError } = require('../utils/logger');

const paymentStatusOf = (derived = {}) => {
  const mode = SCAN_WRITE.sale.paymentStatus.mode;
  if (Number(derived.owed_amount) <= 0) return mode.full;
  if (Number(derived.paid_amount) > 0) return mode.partial;
  return mode.unpaid;
};

const createSalesAsyncWorker = ({
  gateway, sessions, writeService, jobStore = createSalesJobStore(), asyncJobs = null,
  logger = { logInfo, logWarn, logError },
} = {}) => {
  if (!gateway || !writeService) throw new Error('SalesAsyncWorker requires gateway + writeService');
  const sessionService = sessions || writeService.sessions;
  const running = new Map();
  // ⭐ 2026-10-27：全局 FIFO 队列。异步提交会连续入队，不能多个 job 同时打飞书。
  const pendingQueue = [];
  const queuedJobs = new Set();
  let pumping = false;

  /** 同一 job 的日志关联键：job_id 一定在，原始点击 tap_id 有就带上。 */
  const correlationOf = (job) => ({
    task_id: job.job_id,
    ...(job.tap_id ? { tap_id: job.tap_id } : {}),
  });

  const ensureMain = async (job) => {
    if (job.main_record_id) return job.main_record_id;
    const orderNo = String(job.payload?.order_no || job.order_no || '').trim();
    if (!orderNo) throw new Error('job payload missing order_no');
    const field = V1_BITABLE_SCHEMA.tables.salesEntry.fields.orderNo;
    // #891：查询失败 ≠ 没有主表。失败直接抛出，让统一 job 层按临时/永久错误处理；
    // 只有“查询成功且为空”才允许创建（否则恢复窗口里会重复建销售主表）。
    const existing = await gateway.listByFilter('salesEntry', `CurrentValue.[${field}]="${orderNo}"`);
    if (!Array.isArray(existing)) throw new Error('salesEntry lookup returned non-array');
    if (existing.length) {
      const found = existing[0].record_id;
      await jobStore.update(job.job_id, { main_record_id: found });
      return found;
    }
    const created = await gateway.create('salesEntry', {
      orderNo,
      sender: person(job.payload.open_id),
      writeStatus: SALES_STATUS_WRITE_VALUES.writeStatus.pending,
    }, { correlation: correlationOf(job) });
    const id = String(created?.recordId || created?.record_id || '').trim();
    if (!id) throw new Error('销售主表创建后没有 record_id');
    await jobStore.update(job.job_id, { main_record_id: id });
    return id;
  };

  const seedSession = async (job, mainRecordId) => {
    const openId = `job_${job.job_id}`;
    const payload = job.payload;
    // ⭐ #948 重试幂等：上一次可能只加了一半的行 ⇒ **先清空再按冻结 payload 重加**
    //   （同一组行，重跑不会叠加；`submitSale` 仍拿同一把 submitKey ⇒ 幂等那一层一字没拆）
    if (typeof sessionService.clearSale === 'function') {
      await sessionService.clearSale(openId).catch(() => undefined);
    }
    for (const line of payload.lines) {
      await sessionService.addLine(openId, {
        kind: line.kind || 'shoe',
        number: line.number,
        item_no: line.item_no,
        color: line.color,
        product_record_id: line.product_record_id,
        size: line.size,
        trade_type_code: line.trade_type,
        amount: line.actual_amount,
        gift: payload.gift,
        added_at: new Date().toISOString(),
      });
    }
    await sessionService.saveSaleProgress(openId, {
      master_record_id: mainRecordId,
      order_no: payload.order_no,
    });
    return openId;
  };

  /** 一次"真正写库"的尝试（主表 / 会话 / 明细收款库存）；异常**原样抛给重试层**分类。 */
  const attemptSale = async (job) => {
    const mainRecordId = await ensureMain(job);
    const openId = await seedSession(job, mainRecordId);
    const payload = job.payload || {};
    const result = await writeService.submitSale({
      openId,
      requestId: job.job_id,
      submitKey: `scan_sale:${openId}:1`,
      payments: payload.payments || [],
      lineAmounts: (payload.lines || []).map((line) => String(line.actual_amount)),
      paymentStatus: paymentStatusOf(payload.derived),
      paidAmount: String(payload.derived?.paid_amount ?? ''),
      orderGift: payload.gift || '',
      oneShot: true,
    }, { correlation: correlationOf(job) });
    const ok = result?.ok === true && !(Number(result?.stock?.failed || 0) > 0);
    return {
      ok,
      status: ok ? STATUS.succeeded : (result?.ok === true ? STATUS.partialFailed : STATUS.failed),
      message: ok ? '' : String(result?.message || result?.error || result?.code || ''),
      orderNo: result?.order_no || payload.order_no || '',
      result,
    };
  };

  /** 把最终结果落回**链路自己的** store（工作台列表靠它判断"未完成可重试"）并打既有日志。 */
  const settleSalesJob = async (jobId, job, outcome, startedAt) => {
    const payload = job.payload || {};
    const orderNo = outcome.orderNo || job.order_no || payload.order_no || '';
    await jobStore.update(jobId, {
      status: outcome.status,
      order_no: orderNo,
      last_error: outcome.message || '',
    }).catch(() => undefined);
    if (outcome.ok) {
      logger.logInfo('scan.sale.async.done', {
        job_id: jobId, tap_id: job.tap_id || undefined,
        order_no: orderNo, status: outcome.status,
        duration_ms: Math.max(0, Date.now() - startedAt),
        line_count: (payload.lines || []).length,
        payment_count: (payload.payments || []).length,
      });
      return;
    }
    // 关键：submitSale 返回 ok:false（部分失败/失败）时也必须打 error 事件，
    // 否则只打 info done ⇒ 预警规则看不到（2026-10-27 实测 0097 就是这样静默）。
    logger.logError('scan.sale.async.failed', {
      job_id: jobId,
      tap_id: job.tap_id || undefined,
      order_no: orderNo,
      status: outcome.status,
      error: outcome.message || '',
      line_count: (payload.lines || []).length,
      payment_count: (payload.payments || []).length,
    });
  };

  const process = async (jobId) => {
    if (running.has(jobId)) return running.get(jobId);
    const promise = (async () => {
      const job = await jobStore.get(jobId);
      if (!job) return null;
      if (job.status === STATUS.succeeded || job.status === STATUS.partialFailed || job.status === STATUS.failed) return job;
      const startedAt = Date.now();
      // ⭐⭐ #948：注入了统一层 ⇒ **统一重试**（临时错误才重试，重试复用同一把 submitKey /
      //    同一个 id 的 job）+ 最终失败发运营群；没注入 ⇒ 保持既有"只跑一次"。
      if (asyncJobs) {
        let lastOutcome = null;
        let attempted = false;
        const unified = await asyncJobs.run({
          jobId,
          run: async ({ attempt }) => {
            attempted = true;
            await jobStore.update(jobId, { status: STATUS.running, attempts: attempt });
            lastOutcome = await attemptSale(job);
            return lastOutcome;
          },
          classifyResult: (outcome) => {
            if (!outcome || outcome.ok) return { ok: true };
            const classified = classifyResultOutcome(outcome, ASYNC_JOBS.retry);
            return { ...classified, partial: outcome.status === STATUS.partialFailed };
          },
        });
        const finalJob = await jobStore.get(jobId);
        let outcome = lastOutcome;
        // 统一层**一次都没跑**（连 job 都读不到 = 存储异常）⇒ 如实回落单次，绝不把写库吞掉 ✗
        if (!outcome && !attempted) {
          try {
            outcome = await attemptSale(job);
          } catch (error) {
            outcome = {
              ok: false, status: STATUS.failed, message: String(error?.message || error),
              orderNo: job.order_no || '', result: null,
            };
          }
        }
        // 跑过但抛了（永久错误）⇒ 用统一层落下的 last_error 如实收口（**不再重跑** ✗）
        if (!outcome) {
          outcome = {
            ok: false, status: STATUS.failed,
            message: String(finalJob?.last_error || ''),
            orderNo: finalJob?.order_no || job.order_no || '',
            result: null,
          };
        }
        // 以统一层的终态为准（它才知道"最后这次是 partial 还是 failed"）
        const status = unified?.status === ASYNC_JOB_STATUS.SUCCEEDED
          ? STATUS.succeeded
          : (unified?.status === ASYNC_JOB_STATUS.PARTIAL_FAILED ? STATUS.partialFailed : outcome.status);
        const settled = { ...outcome, status, ok: status === STATUS.succeeded };
        if (!settled.ok && !settled.message) settled.message = String(finalJob?.last_error || '');
        await settleSalesJob(jobId, job, settled, startedAt);
        return jobStore.get(jobId);
      }
      await jobStore.update(jobId, { status: STATUS.running, attempts: Number(job.attempts || 0) + 1 });
      try {
        const outcome = await attemptSale(job);
        await settleSalesJob(jobId, job, outcome, startedAt);
        return await jobStore.get(jobId);
      } catch (error) {
        await jobStore.update(jobId, {
          status: STATUS.failed,
          last_error: String(error?.message || error),
        }).catch(() => undefined);
        logger.logError('scan.sale.async.failed', {
          job_id: jobId,
          tap_id: job.tap_id || undefined,
          order_no: job.payload?.order_no || job.order_no || '',
          error: String(error?.message || error),
        });
        return jobStore.get(jobId);
      }
    })();
    running.set(jobId, promise);
    try { return await promise; } finally { running.delete(jobId); }
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (pendingQueue.length) {
        const jobId = pendingQueue.shift();
        queuedJobs.delete(jobId);
        await process(jobId).catch((error) => {
          logger.logError('scan.sale.async.queue_failed', {
            job_id: jobId, error: String(error?.message || error),
          });
        });
      }
    } finally {
      pumping = false;
      if (pendingQueue.length) setImmediate(() => { pump().catch(() => undefined); });
    }
  };

  const schedule = (jobId) => {
    const id = String(jobId || '').trim();
    if (!id || queuedJobs.has(id) || running.has(id)) return;
    queuedJobs.add(id);
    pendingQueue.push(id);
    logger.logInfo('scan.sale.async.queued', { job_id: id, queue_size: pendingQueue.length });
    setImmediate(() => { pump().catch(() => undefined); });
  };

  const enqueue = async ({ submitKey, payload, tapId = '', operatorName = '' }) => {
    const built = buildSalePayload({
      openId: payload.open_id, orderNo: payload.order_no, gift: payload.gift,
      lines: payload.lines, payments: payload.payments,
    });
    if (!built.ok) return { ok: false, errors: built.errors };
    const { job, created } = await jobStore.createIfAbsent(submitKey, built.payload, { tapId });
    // #948：统一任务（幂等：同一个 job_id；升级前入队的旧 job 也能在这里补上统一记录）
    if (asyncJobs) {
      await asyncJobs.enqueue({
        jobId: job.job_id,
        type: ASYNC_JOB_TYPES.SALES,
        payload: {
          order_no: built.payload.order_no,
          line_count: (built.payload.lines || []).length,
          payment_count: (built.payload.payments || []).length,
        },
        ownerOpenId: String(payload?.open_id || ''),
        operatorName,
        meta: { order_no: built.payload.order_no, step: ASYNC_JOBS.texts.stepLabels.sales },
      }).catch((error) => logger.logWarn('scan.sale.async.enqueue_failed', {
        job_id: job.job_id, error: String(error?.message || error),
      }));
    }
    if (created) schedule(job.job_id);
    return { ok: true, job, created };
  };

  const start = async () => {
    const pending = await jobStore.store.list();
    for (const job of pending) {
      if (job.status === STATUS.queued || job.status === STATUS.running) {
        schedule(job.job_id);
      }
    }
  };

  return { enqueue, process, start };
};

module.exports = { createSalesAsyncWorker, paymentStatusOf };
