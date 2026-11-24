'use strict';

const express = require('express');
const { V1_BITABLE_SCHEMA } = require('../../config/v1BitableSchema');
const { listAccessories } = require('../../services/accessoryConfigService');
const { createAccessorySaleOrderService } = require('../../services/accessorySaleOrderService');
const { V1BitableGateway, textValue } = require('../../services/v1BitableGateway');
const { logError } = require('../../utils/logger');

const createWorkbenchAccessorySaleRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  let gatewayInstance = options.gateway || null;
  const gateway = () => {
    if (!gatewayInstance) gatewayInstance = new V1BitableGateway();
    return gatewayInstance;
  };
  let orders = null;
  const resolveOrders = () => {
    if (!orders) orders = createAccessorySaleOrderService({ gateway: gateway() });
    return orders;
  };

  router.get('/accessory-sales/options', async (req, res) => {
    try {
      const rows = await listAccessories(gateway());
      const methodTable = V1_BITABLE_SCHEMA.tables.paymentMethod;
      const methods = (await gateway().listAll('paymentMethod')).map((record) => ({
        recordId: String(record?.record_id || ''),
        name: textValue(record?.fields?.[methodTable.fields.name]).trim(),
        enabled: record?.fields?.[methodTable.fields.enabled] !== false,
      })).filter((item) => item.recordId && item.name && item.enabled);
      return res.json({ success: true, accessories: rows, paymentMethods: methods });
    } catch (error) {
      logError('workbench.accessory_sales.options_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'options_failed' });
    }
  });

  router.post('/accessory-sales', async (req, res) => {
    try {
      const result = await resolveOrders().create({
        items: req.body?.items,
        amount: req.body?.amount,
        methodRecordId: req.body?.methodRecordId,
        saleDate: req.body?.saleDate,
        operatorOpenId: req.workbenchUser?.open_id,
        correlation: { request_id: req.requestId },
      });
      if (!result.ok) return res.status(400).json({ success: false, code: result.code, error: result.code });
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      logError('workbench.accessory_sales.create_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'create_failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchAccessorySaleRoutes };
