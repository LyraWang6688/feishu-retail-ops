'use strict';

const express = require('express');
const { queryWriteAudit } = require('../../services/writeAuditService');

/** 只读写入审计查询；鉴权由父 router 统一加。 */
const createWorkbenchWriteAuditRoutes = () => {
  const router = express.Router();
  router.get('/write-audit', async (req, res) => {
    const orderNo = String(req.query?.order_no || '').trim();
    const traceId = String(req.query?.trace_id || '').trim();
    if (!orderNo && !traceId) return res.status(400).json({ success: false, error: 'order_no_or_trace_id_required' });
    try {
      const limit = Math.min(2000, Math.max(1, Number(req.query?.limit) || 500));
      const rows = await queryWriteAudit({
        orderNo, traceId, domain: String(req.query?.domain || '').trim(), limit,
      });
      return res.json({ success: true, total: rows.length, rows });
    } catch {
      return res.status(502).json({ success: false, error: 'write_audit_query_failed' });
    }
  });
  return router;
};

module.exports = { createWorkbenchWriteAuditRoutes };
