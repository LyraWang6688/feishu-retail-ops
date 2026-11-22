/**
 * 销售查询（工作台自研页）的页面配置。
 * 字段 / 文案 / 接口只在这里；domains.js 只引用 id / label。
 */
export const SALES_QUERY_PAGE = Object.freeze({
  id: 'sales-query',
  label: '销售分析',
  api: '/api/workbench/sales/query',
  texts: Object.freeze({
    startLabel: '开始日期',
    endLabel: '结束日期',
    quickRangeLabel: '快捷范围',
    quickRanges: Object.freeze([
      { value: 'today', days: 1, offset: 0, label: '今天' },
      { value: 'yesterday', days: 1, offset: 1, label: '昨天' },
      { value: 'dayBeforeYesterday', days: 1, offset: 2, label: '前天' },
      { value: 'last3', days: 3, offset: 0, label: '近3天' },
      { value: 'last7', days: 7, offset: 0, label: '近7天' },
      { value: 'last30', days: 30, offset: 0, label: '近30天' },
    ]),
    query: '查询',
    tabsLabel: '销售查询视图',
    tabs: Object.freeze([
      { id: 'overview', label: '经营概览' },
      { id: 'details', label: '销售明细' },
      { id: 'trend', label: '趋势分析' },
    ]),
    trendBuilding: '趋势分析正在建设中。',
    today: '今天',
    loading: '正在读取销售查询…',
    empty: '这个时间范围内没有销售数据。',
    failed: '销售查询读取失败，请稍后刷新。',
    invalidRange: '开始日期不能晚于结束日期。',
    amountTitle: '销售金额',
    revenue: '营业总额',
    accessoryIncluded: '其中包括配品销售：',
    methods: '交易方式',
    volumeTitle: '销售数量',
    delivered: '已交付',
    undelivered: '未交付',
    byCategory: '按类别',
    byType: '按品类',
    orders: '销售明细',
    pendingTag: '待平台结算',
    pendingExcluded: '待结算，未计入',
  }),
});
