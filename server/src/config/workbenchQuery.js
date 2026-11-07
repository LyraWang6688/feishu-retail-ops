/**
 * 工作台查询类接口的可配参数（实时库存）。
 *
 * 单独一个配置模块的理由与 inventoryAdjustment.js 相同：这些是**阈值**，不是逻辑。
 */

// 工作台货品选择器的返回条数上限（按关键字过滤后）。
const WORKBENCH_PRODUCT_SEARCH_LIMIT = 50;

// 「实时库存」按品类批量调整时，最多返回多少个品类。
const WORKBENCH_CATEGORY_LIMIT = 100;

module.exports = {
  WORKBENCH_PRODUCT_SEARCH_LIMIT,
  WORKBENCH_CATEGORY_LIMIT,
};
