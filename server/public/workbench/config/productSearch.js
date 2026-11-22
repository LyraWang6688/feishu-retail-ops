/**
 * 统一货品搜索配置。
 *
 * 当前真正生效的只有两种模式：salesDetail / inventoryLedger。
 * 共同规则：搜索阶段按「货号 itemNo」模糊匹配；选中具体货品后，
 * 页面按完整「编号 number」精确过滤。
 *
 * 预留字段（当前组件不读取，等现有搜索页迁移时再按需加回）：
 *   source / matchField / matchType / filterField / limit
 * 不在现在写死这些未消费字段，避免再次出现“配置存在但不生效”的死配置。
 */
export const PRODUCT_SEARCH_TEXT = Object.freeze({
  label: '货品',
  placeholder: '搜索货号',
  loading: '正在查找货品…',
  empty: '没有匹配的货品。',
  failed: '货品搜索失败，请重试。',
  selected: '已选货品',
  clear: '清除',
});

export const PRODUCT_SEARCH_MODES = Object.freeze({
  salesDetail: Object.freeze({
    includeDelisted: true,
    debounceMs: 250,
  }),
  inventoryLedger: Object.freeze({
    includeDelisted: true,
    debounceMs: 250,
  }),
});

export const productSearchMode = (mode) => PRODUCT_SEARCH_MODES[mode] || PRODUCT_SEARCH_MODES.salesDetail;
