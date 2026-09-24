const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createWorkbenchService } = require('../services/v1WorkbenchService');
const { logError } = require('../utils/logger');

const service = createWorkbenchService(new V1BitableGateway());

const queryTodaySales = async (req, res) => {
  try {
    return res.json({ success: true, ...await service.getTodaySales({ date: req.query.date }) });
  } catch (error) {
    logError('workbench.sales.query_failed', { request_id: req.requestId, error: error.message });
    return res.status(500).json({ success: false, error: '今日销售明细查询失败' });
  }
};

const queryInventory = async (req, res) => {
  try {
    return res.json({ success: true, ...await service.getLiveInventory({ keyword: req.query.keyword, size: req.query.size }) });
  } catch (error) {
    logError('workbench.inventory.query_failed', { request_id: req.requestId, error: error.message });
    return res.status(500).json({ success: false, error: '实时库存查询失败' });
  }
};

module.exports = { queryTodaySales, queryInventory };
