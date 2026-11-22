'use strict';

const { PROCUREMENT_PAGE } = require('../../config/procurementPage');
const { ASYNC_JOBS, ASYNC_JOB_TYPES } = require('../../config/asyncJobs');
const { SUBMIT_TOAST } = require('../../config/submitToast');
const { submitToastUrl } = require('../../utils/submitToast');
const { createPurchaseWriteBackgroundService } = require('../../services/purchaseWriteBackgroundService');
const { createAsyncJobPurchaseRunner } = require('../../services/asyncJobPurchaseRunner');

/** 采购修改路由：POST 只受理，写库/出图/发群在后台那一跑。 */
const registerProcurementModifyRoute = ({
  router, options = {}, asyncJobs, resolveModify, texts, logError,
} = {}) => {
  const background = options.modifyBackground || createPurchaseWriteBackgroundService({
    jobRunner: options.modifyJobRunner !== undefined
      ? options.modifyJobRunner
      : createAsyncJobPurchaseRunner({ asyncJob: asyncJobs }),
    config: {
      texts: { backgroundFailedNotified: ASYNC_JOBS.texts.hints.backgroundFailedNotified },
    },
  });
  router.post(PROCUREMENT_PAGE.endpoints.modify, async (req, res) => {
    try {
      const submitKey = String(req.body?.submitKey || req.requestId || '').trim();
      const jobId = asyncJobs && typeof asyncJobs.jobIdFor === 'function'
        ? asyncJobs.jobIdFor(ASYNC_JOB_TYPES.PROCUREMENT_MODIFY, submitKey) : '';
      void background.scheduleCustomRest({
        chain: 'procurement_modify',
        requestId: req.requestId,
        submitKey,
        jobMeta: {
          ownerOpenId: req.workbenchUser?.open_id || '',
          batchNo: String(req.body?.batchNo || ''),
          step: ASYNC_JOBS.texts.stepLabels.procurementModify,
          requestId: req.requestId,
          submitKey,
        },
        run: async () => resolveModify().modify({
          openId: req.workbenchUser?.open_id,
          batchNo: req.body?.batchNo,
          submitKey: req.body?.submitKey,
          items: req.body?.items,
          requestId: req.requestId,
        }),
      });
      return res.status(202).json({
        success: true,
        accepted: true,
        job_id: jobId,
        toast: SUBMIT_TOAST.text,
        redirect_url: submitToastUrl({}),
      });
    } catch (error) {
      logError('workbench.procurement.modify.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: texts.loadFailed });
    }
  });
};

module.exports = { registerProcurementModifyRoute };
