'use strict';

/** 工作台「其他配品」只读接口：资金页赠品候选（仅 配品=true）。 */
const express = require('express');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { createGiftAccessoryService } = require('../../services/giftAccessoryService');
const { logError } = require('../../utils/logger');

const createWorkbenchAccessoryRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  let gateway = options.gateway || null;
  const getGateway = () => {
    if (!gateway) gateway = new V1BitableGateway();
    return gateway;
  };
  let giftService = options.giftAccessoryService || null;
  const gifts = () => {
    if (!giftService) giftService = createGiftAccessoryService({ gateway: getGateway() });
    return giftService;
  };

  router.get('/accessories/gifts', async (req, res) => {
    try {
      return res.json({ success: true, items: await gifts().list() });
    } catch (error) {
      logError('workbench.accessories.gifts_failed', {
        request_id: req.requestId, error: String(error?.message || error),
      });
      return res.status(502).json({ success: false, error: 'gift_options_failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchAccessoryRoutes };
