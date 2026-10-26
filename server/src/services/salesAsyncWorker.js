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
  gateway, sessions, writeService, jobStore = createSalesJobStore(),
  logger = { logInfo, logWarn, logError },
} = {}) => {
  if (!gateway || !writeService) throw new Error('SalesAsyncWorker requires gateway + writeService');
  const sessionService = sessions || writeService.sessions;
  const running = new Map();

  const ensureMain = async (job) => {
    if (job.main_record_id) return job.main_record_id;
    const orderNo = String(job.payload?.order_no || job.order_no || '').trim();
    if (!orderNo) throw new Error('job payload missing order_no');
    const field = V1_BITABLE_SCHEMA.tables.salesEntry.fields.orderNo;
    const existing = await gateway.listByFilter('salesEntry', `CurrentValue.[${field}]="${orderNo}"`).catch(() => []);
    if (existing && existing.length) {
      const found = existing[0].record_id;
      await jobStore.update(job.job_id, { main_record_id: found });
      return found;
    }
    const created = await gateway.create('salesEntry', {
      orderNo,
      sender: person(job.payload.open_id),
      writeStatus: SALES_STATUS_WRITE_VALUES.writeStatus.pending,
    }, { correlation: { task_id: job.job_id } });
    const id = String(created?.recordId || created?.record_id || '').trim();
    if (!id) throw new Error('销售主表创建后没有 record_id');
    await jobStore.update(job.job_id, { main_record_id: id });
    return id;
  };

  const seedSession = async (job, mainRecordId) => {
    const openId = `job_${job.job_id}`;
    const payload = job.payload;
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

  const process = async (jobId) => {
    if (running.has(jobId)) return running.get(jobId);
    const promise = (async () => {
      const job = await jobStore.get(jobId);
      if (!job) return null;
      if (job.status === STATUS.succeeded || job.status === STATUS.partialFailed || job.status === STATUS.failed) return job;
      const startedAt = Date.now();
      await jobStore.update(jobId, { status: STATUS.running, attempts: Number(job.attempts || 0) + 1 });
      try {
        const mainRecordId = await ensureMain(job);
        const openId = await seedSession(job, mainRecordId);
        const payload = job.payload;
        const result = await writeService.submitSale({
          openId,
          requestId: jobId,
          submitKey: `scan_sale:${openId}:1`,
          payments: payload.payments || [],
          lineAmounts: (payload.lines || []).map((line) => String(line.actual_amount)),
          paymentStatus: paymentStatusOf(payload.derived),
          paidAmount: String(payload.derived?.paid_amount ?? ''),
          orderGift: payload.gift || '',
          oneShot: true,
        });
        const ok = result?.ok === true && !(Number(result?.stock?.failed || 0) > 0);
        const status = ok ? STATUS.succeeded : (result?.ok === true ? STATUS.partialFailed : STATUS.failed);
        await jobStore.update(jobId, {
          status,
          order_no: result?.order_no || payload.order_no,
          last_error: ok ? '' : String(result?.message || result?.error || result?.code || ''),
        });
        logger.logInfo('scan.sale.async.done', {
          job_id: jobId, order_no: result?.order_no || payload.order_no, status,
          duration_ms: Math.max(0, Date.now() - startedAt),
          line_count: (payload.lines || []).length,
          payment_count: (payload.payments || []).length,
        });
        return await jobStore.get(jobId);
      } catch (error) {
        await jobStore.update(jobId, {
          status: STATUS.failed,
          last_error: String(error?.message || error),
        }).catch(() => undefined);
        logger.logError('scan.sale.async.failed', {
          job_id: jobId,
          order_no: job.payload?.order_no || job.order_no || '',
          error: String(error?.message || error),
        });
        return jobStore.get(jobId);
      }
    })();
    running.set(jobId, promise);
    try { return await promise; } finally { running.delete(jobId); }
  };

  const enqueue = async ({ submitKey, payload }) => {
    const built = buildSalePayload({
      openId: payload.open_id, orderNo: payload.order_no, gift: payload.gift,
      lines: payload.lines, payments: payload.payments,
    });
    if (!built.ok) return { ok: false, errors: built.errors };
    const { job, created } = await jobStore.createIfAbsent(submitKey, built.payload);
    if (created) setImmediate(() => { process(job.job_id).catch(() => undefined); });
    return { ok: true, job, created };
  };

  const start = async () => {
    const pending = await jobStore.store.list();
    for (const job of pending) {
      if (job.status === STATUS.queued || job.status === STATUS.running) {
        setImmediate(() => { process(job.job_id).catch(() => undefined); });
      }
    }
  };

  return { enqueue, process, start };
};

module.exports = { createSalesAsyncWorker, paymentStatusOf };
