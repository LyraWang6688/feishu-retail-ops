const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createWorkbenchService } = require('../services/v1WorkbenchService');
const { logError } = require('../utils/logger');

const service = createWorkbenchService(new V1BitableGateway());

// 飞书偶发「数据未准备好」(1254607)：这类要回 503 + Retry-After，让页面提示"稍后刷新"，
// 而不是当成系统错误回 500。剩下的库存类查询接口共用这一条判断。
const isDataNotReady = (error) => /1254607|data not ready|数据未准备好/i.test(String(error?.message || ''));
// 入参错误（缺货号 / 尺码格式错）由 service 打 statusCode=400，
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

// ⚠️ 2026-10-08：`queryTodaySales`（`GET /sales/today`）与 `querySales`（`GET /sales/query`）
// 已随**自建的销售查询**一起删除 —— 业务负责人的口径（逐字）：「现有的**我们自己搭的**
// 销售查询/库存查询页面与接口（`/api/workbench/*`），**顺手删掉**」。
// ⇒ 销售查询改走**飞书多维表格的网页外链**（前端「信息查询」的两张卡），这一维不再自建接口。
// ⚠️ `v1WorkbenchService` 的 `getSalesReport` / `getTodaySales` **保留**（那个文件属
// `server/src/services/**`，本次边界不碰），但**已没有任何生产调用方**。

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
  queryInventory,
  queryInventoryProducts,
  queryInventoryStock,
  queryInventoryCategories,
};
