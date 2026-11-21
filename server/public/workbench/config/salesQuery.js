/**
 * 销售查询（工作台自研页）的页面配置。
 * 字段 / 文案 / 接口只在这里；domains.js 只引用 id / label。
 */
export const SALES_QUERY_PAGE = Object.freeze({
  id: 'sales-query',
  label: '销售查询',
  api: '/api/workbench/sales/query',
  texts: Object.freeze({
    startLabel: '开始日期',
    endLabel: '结束日期',
    quickRangeLabel: '快捷范围',
    quickRanges: Object.freeze([
      { days: 1, label: '今天' },
      { days: 3, label: '近3天' },
      { days: 7, label: '近7天' },
      { days: 30, label: '近30天' },
    ]),
    query: '查询',
    today: '今天',
    loading: '正在读取销售查询…',
    empty: '这个时间范围内没有销售数据。',
    failed: '销售查询读取失败，请稍后刷新。',
    invalidRange: '开始日期不能晚于结束日期。',
    amountTitle: '销售金额',
    revenue: '营业总额',
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
