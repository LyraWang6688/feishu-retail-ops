'use strict';

const express = require('express');
const { queryRecentWriteAudit } = require('../../services/writeAuditService');
const { WRITE_AUDIT } = require('../../config/writeAudit');

/** 只读「过去 24 小时写入」；鉴权由父 router 统一加。 */
const createWorkbenchWriteAuditRoutes = () => {
  const router = express.Router();
  router.get('/write-audit', async (req, res) => {
    try {
      const limit = Math.min(WRITE_AUDIT.queryMaxLimit, Math.max(1, Number(req.query?.limit) || WRITE_AUDIT.queryDefaultLimit));
      const domain = String(req.query?.domain || '').trim();
      const rows = await queryRecentWriteAudit({ domain, limit });
      return res.json({ success: true, total: rows.length, rows, mode: 'recent' });
    } catch {
      return res.status(502).json({ success: false, error: 'write_audit_query_failed' });
    }
  });
  return router;
};

module.exports = { createWorkbenchWriteAuditRoutes };
