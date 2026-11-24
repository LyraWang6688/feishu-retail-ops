'use strict';

const express = require('express');
const { getProcurementDraftService } = require('../../services/procurementDraftRuntime');
const { logWarn } = require('../../utils/logger');

const createWorkbenchProcurementDraftRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  const service = () => options.procurementDraft || getProcurementDraftService();
  const openIdOf = (req) => String(req.workbenchUser?.open_id || '').trim();

  router.get('/procurement/draft', async (req, res) => {
    try {
      const draft = await service().get({ openId: openIdOf(req) });
      return res.json({ success: true, draft: draft ? { savedAt: draft.saved_at, snapshot: draft.snapshot } : null });
    } catch (error) {
      logWarn('workbench.procurement_draft.get_failed', { request_id: req.requestId, error: String(error?.message || error).slice(0, 200) });
      return res.status(502).json({ success: false, error: 'draft_get_failed' });
    }
  });

  router.post('/procurement/draft', async (req, res) => {
    const snapshot = req.body?.snapshot && typeof req.body.snapshot === 'object' ? req.body.snapshot : {};
    try {
      const result = await service().save({ openId: openIdOf(req), snapshot });
      if (!result.ok) return res.status(400).json({ success: false, error: result.code || 'draft_save_failed' });
      return res.json({ success: true, draft: { savedAt: result.draft.saved_at } });
    } catch (error) {
      logWarn('workbench.procurement_draft.save_failed', { request_id: req.requestId, error: String(error?.message || error).slice(0, 200) });
      return res.status(502).json({ success: false, error: 'draft_save_failed' });
    }
  });

  router.delete('/procurement/draft', async (req, res) => {
    try {
      await service().remove({ openId: openIdOf(req) });
      return res.json({ success: true });
    } catch (error) {
      logWarn('workbench.procurement_draft.remove_failed', { request_id: req.requestId, error: String(error?.message || error).slice(0, 200) });
      return res.status(502).json({ success: false, error: 'draft_remove_failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchProcurementDraftRoutes };
