'use strict';

/** 「销售 → 交割单」页：只读数据 + 交付/付款异步入队 + job 状态。 */
const express = require('express');
const { createSalesDeliveryReadService } = require('../services/salesDeliveryReadService');
const { createPaymentMethodsService } = require('../services/paymentMethodsService');
const { createSalesDeliveryPaymentService } = require('../services/salesDeliveryPaymentService');
const { createSalesDeliveryAsyncService } = require('../services/salesDeliveryAsyncService');
const { getAsyncJobService } = require('../services/asyncJobRuntime');
const { SUBMIT_TOAST } = require('../config/submitToast');
const { ASYNC_JOBS } = require('../config/asyncJobs');
const { SampleReplacementService } = require('../services/sampleReplacementService');
const { logError, logWarn } = require('../utils/logger');

const createWorkbenchSalesDeliveryRoutes = ({ options = {}, followup, ordersCache } = {}) => {
  const router = express.Router();
  const gateway = options.gateway || followup.gateway;
  const paymentMethods = options.paymentMethodsService || createPaymentMethodsService(gateway);
  const read = createSalesDeliveryReadService({ gateway, paymentMethods });
  let pay = null;
  let async = null;

  const getPay = () => {
    if (!pay) {
      pay = createSalesDeliveryPaymentService({ gateway, payments: followup.payments, store: followup.store });
    }
    return pay;
  };
  const getAsync = () => {
    if (!async) {
      const jobs = options.asyncJobs || getAsyncJobService();
      if (!jobs) throw new Error('async jobs disabled');
      async = createSalesDeliveryAsyncService({
        jobs,
        legacyDir: options.salesDeliveryLegacyJobsDir,
        deliver: async (payload, correlation) => {
          const result = await followup.delivery.deliver({
            salesEntryRecordId: payload.salesEntryRecordId,
            detailRecordIds: payload.detailRecordIds,
          }, { correlation });
          if (result.sampleReplacements?.length) {
            const notifier = options.sampleNotifier || new SampleReplacementService({
              gateway: followup.gateway, inventory: followup.delivery.inventory,
            });
            await notifier.notifySampleReplacements(result, payload.operatorOpenId).catch((error) =>
              logWarn('workbench.sales.sample_notice.failed', { error: error.message }));
          }
          return result;
        },
        pay: (payload) => getPay().pay(payload),
        onSettled: () => ordersCache?.invalidate?.(),
      });
      async.start().catch((error) =>
        logWarn('workbench.sales.delivery.failed', { reason: 'job_start_failed', error: error.message }));
    }
    return async;
  };

  router.get('/sales/delivery', async (req, res) => {
    try { return res.json({ success: true, ...await read.listDeliveryData() }); }
    catch (error) {
      logError('workbench.sales.orders.failed', { request_id: req.requestId, chain: 'delivery', error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  router.post('/sales/delivery/deliveries', async (req, res) => {
    try {
      const { job } = await getAsync().enqueue({
        type: 'delivery', requestId: req.body?.requestId,
        payload: {
          salesEntryRecordId: req.body?.salesEntryRecordId,
          detailRecordIds: Array.isArray(req.body?.detailRecordIds) ? req.body.detailRecordIds : [],
          operatorOpenId: req.workbenchUser?.open_id || '',
          operatorName: req.workbenchUser?.name || '',
        },
      });
      return res.status(202).json({ success: true, jobId: job.job_id, status: job.status });
    } catch (error) {
      logError('workbench.sales.delivery.failed', { request_id: req.requestId, chain: 'delivery_enqueue', error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/sales/delivery/payments', async (req, res) => {
    try {
      const { job } = await getAsync().enqueue({
        type: 'payment', requestId: req.body?.requestId,
        payload: {
          salesEntryRecordId: req.body?.salesEntryRecordId,
          amount: req.body?.amount, method: req.body?.method,
          requestId: req.body?.requestId,
          operatorOpenId: req.workbenchUser?.open_id || '',
          operatorName: req.workbenchUser?.name || '',
        },
      });
      return res.status(202).json({ success: true, jobId: job.job_id, status: job.status });
    } catch (error) {
      logError('workbench.sales.payment.failed', { request_id: req.requestId, chain: 'delivery_enqueue', error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createWorkbenchSalesDeliveryRoutes };
