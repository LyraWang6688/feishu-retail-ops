'use strict';

/**
 * 工作台「销售 · 确认单」只读列表 + 整单更正（2026-11-28）。
 * 鉴权 / no-store 由父 router（routes/workbench.js）统一加。
 */
const express = require('express');
const { SalesCorrectionService } = require('../../services/salesCorrectionService');
const { InventoryService } = require('../../services/inventoryService');
const { createScanPageService } = require('../../services/scanPageService');
const { saleSizeGroups } = require('../../views/scanPageRealm');
const { logError } = require('../../utils/logger');

const createWorkbenchSalesCorrectionRoutes = ({ options = {}, followup } = {}) => {
  const router = express.Router();
  let service = options.salesCorrection || null;
  let scanPageService = options.scanPageService || null;
  const resolveScanPage = () => {
    if (!scanPageService) scanPageService = createScanPageService(options.gateway);
    return scanPageService;
  };
  const resolveService = () => {
    if (!service) {
      service = new SalesCorrectionService({
        gateway: options.gateway,
        followup,
        inventory: options.inventory || new InventoryService({ gateway: options.gateway }),
        scanPageService: resolveScanPage(),
        references: options.references,
        store: options.salesCorrectionStore,
        auditDir: options.salesCorrectionAuditDir,
      });
    }
    return service;
  };
  const actorOf = (req) => options.actor || req.workbenchActor || {};

  router.get('/sales/corrections', async (req, res) => {
    try {
      const days = Number(req.query?.days || 5);
      return res.json({ success: true, ...(await resolveService().list({ actor: actorOf(req), days })) });
    } catch (error) {
      logError('workbench.sales.corrections.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'sales_corrections_failed' });
    }
  });

  router.post('/sales/corrections', async (req, res) => {
    try {
      const result = await resolveService().correct({
        submitKey: req.body?.submitKey,
        salesEntryRecordId: req.body?.salesEntryRecordId,
        details: req.body?.details,
        payments: req.body?.payments,
        gift: req.body?.gift,
        accessory: req.body?.accessory,
        accessoryTotal: req.body?.accessoryTotal,
      }, { actor: actorOf(req), requestId: req.requestId });
      return res.json({ success: true, ...result });
    } catch (error) {
      const status = /只能|不能|超过|不属于|缺少|没有|已经|请|要填|不一致|待核对/.test(String(error.message || '')) ? 400 : 502;
      logError('workbench.sales.correction.failed', { request_id: req.requestId, error: error.message });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  router.get('/sales/size-groups', async (req, res) => {
    const productRecordId = String(req.query?.productRecordId || req.query?.product_record_id || '').trim();
    if (!productRecordId) return res.status(400).json({ success: false, error: 'missing_product_record_id' });
    try {
      const view = await resolveScanPage().lookup({ recordId: productRecordId, requestId: req.requestId });
      const groups = saleSizeGroups(view);
      const toItems = (items) => (items || []).map((item) => ({
        size: Number(item.size_text), count: Number(item.count) || 0,
        states: Array.isArray(item.states) ? item.states : [],
      }));
      return res.json({
        success: true,
        groups: {
          inStock: toItems(groups.inStock),
          reserve: toItems(groups.prepaid),
          special: toItems(groups.folded),
        },
      });
    } catch (error) {
      logError('workbench.sales.size_groups.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'sales_size_groups_failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchSalesCorrectionRoutes };
