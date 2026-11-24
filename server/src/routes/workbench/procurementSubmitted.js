'use strict';

/** 采购预览「已报货」摘要 / 明细路由。 */
const registerProcurementSubmittedRoutes = ({
  router, endpoints, resolveSubmitted, texts, logError,
}) => {
  router.get(endpoints.submitted, async (req, res) => {
    try {
      const result = await resolveSubmitted().listSubmitted({
        openId: req.workbenchUser?.open_id,
        offset: req.query.offset,
        limit: req.query.limit,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.procurement.submitted.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: texts.loadFailed });
    }
  });

  router.get(`${endpoints.submitted}/:batchNo`, async (req, res) => {
    try {
      const batch = await resolveSubmitted().getBatchDetail({
        openId: req.workbenchUser?.open_id,
        batchNo: req.params.batchNo,
      });
      if (!batch) return res.status(404).json({ success: false, error: texts.loadFailed });
      return res.json({ success: true, batch });
    } catch (error) {
      logError('workbench.procurement.submitted.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: texts.loadFailed });
    }
  });
};

module.exports = { registerProcurementSubmittedRoutes };
