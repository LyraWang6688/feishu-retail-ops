'use strict';
const express = require('express');
const { getSalesDraftService } = require('../../services/salesDraftRuntime');
const { hasContent } = require('../../services/salesDraftSnapshotService');
const { logWarn } = require('../../utils/logger');

const createWorkbenchSalesDraftRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  const service = () => options.salesDraft || getSalesDraftService();
  const openIdOf = (req) => String(req.workbenchUser?.open_id || '').trim();

  router.get('/sales/drafts', async (req, res) => {
    try {
      return res.json({ success: true, drafts: await service().list({ openId: openIdOf(req) }) });
    } catch (error) {
      logWarn('workbench.sales_drafts.list_failed', { request_id: req.requestId, error: String(error?.message || error).slice(0, 200) });
      return res.status(502).json({ success: false, error: 'draft_list_failed' });
    }
  });

  router.post('/sales/drafts', async (req, res) => {
    const snapshot = req.body?.snapshot && typeof req.body.snapshot === 'object' ? req.body.snapshot : {};
    const lines = Array.isArray(snapshot.lines) ? snapshot.lines : [];
    if (!hasContent({ lines, currentForm: snapshot.currentForm })) return res.status(400).json({ success: false, error: 'draft_empty' });
    try {
      const result = await service().save({
        openId: openIdOf(req),
        draftId: String(req.body?.draftId || '').trim(),
        step: String(req.body?.step || 'goods').trim(),
        snapshot,
      });
      if (!result.ok) return res.status(400).json({ success: false, error: result.code || 'draft_save_failed' });
      return res.json({ success: true, draft: { draftId: result.draft.draft_id, step: result.draft.step, updatedAt: result.draft.updated_at } });
    } catch (error) {
      logWarn('workbench.sales_drafts.save_failed', { request_id: req.requestId, error: String(error?.message || error).slice(0, 200) });
      return res.status(502).json({ success: false, error: 'draft_save_failed' });
    }
  });

  router.get('/sales/drafts/:draftId', async (req, res) => {
    const record = await service().get({ openId: openIdOf(req), draftId: String(req.params?.draftId || '') });
    if (!record) return res.status(404).json({ success: false, error: 'draft_not_found' });
    return res.json({ success: true, draft: record });
  });

  router.delete('/sales/drafts/:draftId', async (req, res) => {
    const removed = await service().remove({ openId: openIdOf(req), draftId: String(req.params?.draftId || '') });
    // 删除是幂等的：重复点 / 另一个标签已经删掉，都按“已删除”返回；
    // 否则前端第二次请求会收到 404，把一次成功删除显示成“删除失败”。
    return res.json({ success: true, removed: Boolean(removed) });
  });

  return router;
};

module.exports = { createWorkbenchSalesDraftRoutes };
