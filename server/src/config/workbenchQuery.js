/**
 * 工作台查询类接口的可配参数（实时库存）。
 *
 * 单独一个配置模块的理由与 inventoryAdjustment.js 相同：这些是**阈值**，不是逻辑。
 */

// 「实时库存」按品类批量调整时，最多返回多少个品类。
const WORKBENCH_CATEGORY_LIMIT = 100;
// 单双调整按产品过滤读库存时的行数上限（一款的尺码 × 状态远小于这个数）。
const WORKBENCH_PRODUCT_INVENTORY_LIMIT = 200;
// 库存流水一次返回的最近条数（表会持续增长；其余历史暂不一次性拖给前端）。
const WORKBENCH_LEDGER_LIMIT = 200;

module.exports = {
  WORKBENCH_CATEGORY_LIMIT,
  WORKBENCH_PRODUCT_INVENTORY_LIMIT,
  WORKBENCH_LEDGER_LIMIT,
};
