const express = require('express');
const { PurchaseWebhookService } = require('../services/purchaseWebhookService');
const { logWarn } = require('../utils/logger');

const getRecordId = (req) => String(req.body?.record_id || req.body?.recordId || '').trim();

const createPurchaseWebhookRouter = (options = {}) => {
  const router = express.Router();
  const service = options.service || new PurchaseWebhookService();

  const register = (kind) => async (req, res) => {
    const recordId = getRecordId(req);
    if (!recordId) return res.status(400).json({ success: false, error: '缺少 record_id' });
    try {
      const result = await service.accept(kind, recordId);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      logWarn('purchase.webhook.rejected', { kind, record_id: recordId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  };

  router.post('/supplier-report/webhook', register('supplier-report'));
  router.post('/arrival/webhook', register('arrival'));
  router.get('/webhook/health', (_req, res) => res.json({ success: true, mode: 'async', schema: 'v1' }));
  return router;
};

module.exports = { createPurchaseWebhookRouter };
