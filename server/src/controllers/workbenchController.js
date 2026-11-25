const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createWorkbenchService } = require('../services/v1WorkbenchService');
const { createInventoryAnalysisService } = require('../services/inventoryAnalysisService');
const { logError } = require('../utils/logger');

// 两个只读服务共用同一个网关（字段缓存/重试节奏保持一份）。
const gateway = new V1BitableGateway();
const service = createWorkbenchService(gateway);
const analysisService = createInventoryAnalysisService({ gateway });

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

const queryInventory = async (req, res) => {
  try {
    return res.json({ success: true, ...await service.getLiveInventory({
      keyword: req.query.keyword,
      size: req.query.size,
      // ⭐ 2026-11-17：单双调整按产品只读这一款，不再把整仓库存传到前端。
      productRecordId: req.query.productRecordId,
      groupBy: req.query.groupBy,
      requestId: req.requestId,
    }) });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.inventory.query_failed', fallback: '实时库存查询失败',
    });
  }
};

// 换季调整（按品类批量）：品类清单来自「实时库存」的「品类」公式列。
const queryInventoryLedger = async (req, res) => {
  try {
    // 旧 product=<number> 已禁用：number 不唯一，继续接受会返回未过滤结果。
    if (req.query.product != null) {
      throw Object.assign(new Error('product_filter_removed'), { statusCode: 400 });
    }
    return res.json({ success: true, ...await service.getInventoryLedger({
      requestId: req.requestId, from: req.query.from, to: req.query.to,
      productRecordId: req.query.productRecordId || req.query.product_record_id,
    }) });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.inventory.ledger_failed', fallback: '库存流水查询失败',
    });
  }
};

// 库存总览（只读）：A 段实时快照 + B 段流水区间聚合；日期只作用于 B 段。
const queryInventoryOverview = async (req, res) => {
  try {
    return res.json({
      success: true,
      ...await analysisService.getOverview({ from: req.query.from, to: req.query.to }),
    });
  } catch (error) {
    return respondQueryFailure(res, error, {
      requestId: req.requestId, event: 'workbench.inventory.overview_failed', fallback: '库存总览查询失败',
    });
  }
};

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
  queryInventoryOverview,
  queryInventoryLedger,
  queryInventoryCategories,
  // 查询类接口的**失败口径**只有这一份实现（400 原样回显她填错的 / 503 飞书数据未准备好 /
  // 其余 500 不回显内部细节）。鞋盒标签打印那条只读查询挂在 `routes/workbench.js` 里，
  // 它复用这一个函数而不另写一套 —— 两套口径迟早在"什么算她填错"上分家。
  respondQueryFailure,
};
