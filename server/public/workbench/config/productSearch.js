/**
 * 统一货品搜索配置。
 *
 * 搜索阶段统一按「货号 itemNo」模糊匹配；选中具体货品后，页面按完整「编号 number」精确过滤。
 * 数据来源 / 结果渲染 / 采购页前端过滤仍由各页面自己决定，不强行合并。
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
  productLookup: Object.freeze({
    source: 'server', matchField: 'itemNo', matchType: 'contains',
    includeDelisted: false, filterField: 'number', debounceMs: 250, limit: 50,
  }),
  productCompletion: Object.freeze({
    source: 'server', matchField: 'itemNo', matchType: 'contains',
    includeDelisted: false, filterField: 'number', debounceMs: 250, limit: 50,
  }),
  productDelisted: Object.freeze({
    source: 'server', matchField: 'itemNo', matchType: 'contains',
    includeDelisted: true, filterField: 'number', debounceMs: 250, limit: 2000,
  }),
  salesDetail: Object.freeze({
    source: 'server', matchField: 'itemNo', matchType: 'contains',
    includeDelisted: true, filterField: 'number', debounceMs: 250, limit: 50,
  }),
  inventoryLedger: Object.freeze({
    source: 'server', matchField: 'itemNo', matchType: 'contains',
    includeDelisted: true, filterField: 'number', debounceMs: 250, limit: 50,
  }),
  procurement: Object.freeze({
    source: 'client', matchField: 'itemNo', matchType: 'contains',
    includeDelisted: false, filterField: 'number', withinSupplier: true, debounceMs: 0,
  }),
  salesDelivery: Object.freeze({
    source: 'client', matchField: 'number', matchType: 'exact',
    includeDelisted: false, filterField: 'number', control: 'select',
  }),
});

export const productSearchMode = (mode) => PRODUCT_SEARCH_MODES[mode] || PRODUCT_SEARCH_MODES.productLookup;
