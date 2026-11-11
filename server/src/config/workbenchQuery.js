/**
 * 工作台查询类接口的可配参数（实时库存）。
 *
 * 单独一个配置模块的理由与 inventoryAdjustment.js 相同：这些是**阈值**，不是逻辑。
 */

// 「实时库存」按品类批量调整时，最多返回多少个品类。
const WORKBENCH_CATEGORY_LIMIT = 100;

module.exports = {
  WORKBENCH_CATEGORY_LIMIT,
};
