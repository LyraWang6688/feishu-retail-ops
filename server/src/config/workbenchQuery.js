/**
 * 工作台查询类接口的可配参数（销售查询 / 实时库存）。
 *
 * 单独一个配置模块的理由与 inventoryAdjustment.js 相同：这些是**阈值**，
 * 不是逻辑。她说要"按某日和按区间查询"时，一次能查多长应该是个可改的数字，
 * 而不是埋在 service 里的字面量。
 */

// 「销售查询」一次最多查多少天（含首尾）。
// 上限的作用：一条查询最多扫多少条销售明细，避免她手滑选了两年
// 把一个慢查询打到飞书上，页面看着像卡死。
const SALES_QUERY_MAX_RANGE_DAYS = 92;

// 工作台货品选择器的返回条数上限（按关键字过滤后）。
const WORKBENCH_PRODUCT_SEARCH_LIMIT = 50;

// 「实时库存」按品类批量调整时，最多返回多少个品类。
const WORKBENCH_CATEGORY_LIMIT = 100;

module.exports = {
  SALES_QUERY_MAX_RANGE_DAYS,
  WORKBENCH_PRODUCT_SEARCH_LIMIT,
  WORKBENCH_CATEGORY_LIMIT,
};
