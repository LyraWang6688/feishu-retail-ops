const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createWorkbenchService } = require('../services/v1WorkbenchService');
const { logError } = require('../utils/logger');

const service = createWorkbenchService(new V1BitableGateway());

// 飞书偶发「数据未准备好」(1254607)：这类要回 503 + Retry-After，让页面提示"稍后刷新"，
// 而不是当成系统错误回 500。三个查询接口共用这一条判断。
const isDataNotReady = (error) => /1254607|data not ready|数据未准备好/i.test(String(error?.message || ''));
// 入参错误（日期格式 / 区间太大 / 缺货号）由 service 打 statusCode=400，
// 原样回显她填错的地方；其余一律不回显内部细节。
const userInputError = (error) => (error?.statusCode === 400 ? error.message : '');

const respondQueryFailure = (res, error, { requestId, event, fallback }) => {
  logError(event, { request_id: requestId, error: error.message });
  const inputMessage = userInputError(error);
  if (inputMessage) return res.status(400).json({ success: false, error: inputMessage });
  if (isDataNotReady(error)) {
    res.set('Retry-After', '5');
    return res.status(503).json({ success: false, error: '飞书数据正在准备中，请稍后刷新' });
  }
  return res.status(500).json({ success: false, error: fallback });
};

const queryTodaySales = async (req, res) => {
  try {
    return res.json({ success: true, ...await service.getTodaySales({ date: req.query.date, requestId: req.requestId }) });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.sales.query_failed', fallback: '今日销售明细查询失败',
    });
  }
};

// 「销售查询」：按某日（date）或按区间（from / to）。**与 /sales/today 同一套口径**，
// 只是多了 from/to —— 老的 /sales/today 调用方不受影响。
const querySales = async (req, res) => {
  try {
    return res.json({
      success: true,
      ...await service.getSalesReport({
        date: req.query.date, from: req.query.from, to: req.query.to, requestId: req.requestId,
      }),
    });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.sales.range_query_failed', fallback: '销售查询失败',
    });
  }
};

const queryInventory = async (req, res) => {
  try {
    return res.json({ success: true, ...await service.getLiveInventory({ keyword: req.query.keyword, size: req.query.size, requestId: req.requestId }) });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.inventory.query_failed', fallback: '实时库存查询失败',
    });
  }
};

// 货品选择器：人工库存调整要先按货号找到货品 record_id。
const queryInventoryProducts = async (req, res) => {
  try {
    return res.json({
      success: true,
      ...await service.findProducts({ keyword: req.query.keyword, requestId: req.requestId }),
    });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.inventory.products_failed', fallback: '货品查询失败',
    });
  }
};

// 盘点调整：先看这个货号 + 尺码在三种状态下各有几双。
const queryInventoryStock = async (req, res) => {
  try {
    return res.json({
      success: true,
      ...await service.getInventoryStockLevels({
        productRecordId: req.query.productRecordId, size: req.query.size, requestId: req.requestId,
      }),
    });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.inventory.stock_failed', fallback: '库存数量查询失败',
    });
  }
};

// 换季调整（按品类批量）：品类清单来自「实时库存」的「品类」公式列。
const queryInventoryCategories = async (req, res) => {
  try {
    return res.json({ success: true, ...await service.listInventoryCategories({ requestId: req.requestId }) });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.inventory.categories_failed', fallback: '品类查询失败',
    });
  }
};

module.exports = {
  queryTodaySales,
  querySales,
  queryInventory,
  queryInventoryProducts,
  queryInventoryStock,
  queryInventoryCategories,
};
