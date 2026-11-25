/**
 * 库存 → 库存分析（总览 + 流水，只读）的页面配置。
 *
 * 字段顺序 / 文案 / 接口都只在这里；config/domains.js 只引用 label，
 * 不在两处各写一份「库存分析」。
 *
 * 2026-11-25（业务负责人确认）：
 *   · 库存总览 = B 段「库存变动」（吃页面上已有的日期栏，默认今天）
 *              ＋ A 段「库存现状」（实时快照，不受日期影响）；
 *   · 日期控件沿用库存流水上方那一个，不新增第二个。
 */
export const INVENTORY_LEDGER_PAGE = Object.freeze({
  id: 'inventory-ledger',
  label: '库存分析',
  api: '/api/workbench/inventory/ledger',
  overviewApi: '/api/workbench/inventory/overview',
  tabs: Object.freeze([
    { id: 'overview', label: '库存总览' },
    { id: 'ledger', label: '库存流水' },
  ]),
  columns: Object.freeze([
    { key: 'time', label: '创建时间', cls: 'time' },
    { key: 'behavior', label: '库存行为' },
    { key: 'number', label: '编号' },
    { key: 'size', label: '尺码' },
    { key: 'quantity_change', label: '数量', cls: 'qty' },
  ]),
  texts: Object.freeze({
    tabsLabel: '库存分析视图',

    // ── 库存总览：B 段（库存变动，吃日期栏）──
    overviewLoading: '正在读取库存总览…',
    overviewFailed: '库存总览读取失败，请稍后刷新。',
    changeTitle: '库存变动',
    changeHint: '统计区间 {from} 至 {to} · 按库存流水创建时间',
    changeHintSingle: '统计区间 {from} · 按库存流水创建时间',
    changeEmpty: '这个时间范围内没有库存变动。',
    inbound: '入库',
    outbound: '出库',
    net: '期间净增',
    netHint: '入库 − 出库',
    pairsWord: '双',
    stylesWord: '款',
    pairsUnit: '{n} 双',
    recordsUnit: '{n} 笔',
    pairsRecords: '{pairs} 双 · {records} 笔',
    stateNoQuantity: '不影响库存总量',
    stateAnomaly: '状态调整里有 {n} 笔数量不为 0，已按状态调整计数，未并进进出。',
    truncated: '流水超过 {n} 条上限，仅统计前 {n} 条。',

    // ── 库存总览：A 段（库存现状，实时快照）──
    snapshotTitle: '库存现状',
    snapshotHint: '实时快照，不受上方日期影响',
    stylesUnit: '{n} 款',
    stateTitle: '门盒 / 样品',
    categoryTitle: '品类',
    classTitle: '类别',
    supplierTitle: '供应商',
    missingNote: '未分类：{parts}',
    missingCategory: '品类 {n} 双',
    missingClass: '类别 {n} 双',
    missingSupplier: '供应商 {n} 双',

    // ── 库存流水 ──
    ledgerTitle: '库存流水',
    startLabel: '开始日期',
    endLabel: '结束日期',
    query: '查询',
    today: '今天',
    loading: '正在读取库存流水…',
    empty: '这个时间范围内没有库存流水。',
    failed: '库存流水读取失败，请稍后刷新。',
    delisted: '已下架',
    total: '共 {total} 条',
    recent: '显示最近 {shown} 条',
    invalidRange: '开始日期不能晚于结束日期。',
  }),
});
