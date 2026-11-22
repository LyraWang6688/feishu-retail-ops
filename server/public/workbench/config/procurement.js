/**
 * 采购页（供应 → 录单 → 采购）的前端配置 —— 文案 / 端点 / 默认值 / 尺码规则 / 刷新参数**只在这里**。
 *
 * 业务口径（2026-10-28 业务负责人确认，见 `docs/procurement-page-real-2026-10-28.md`；
 *   2026-11-17 更新：**预订不再自动填数量**，与现货 / 上新一致，默认全 0）：
 *   · 补货：近 3 天销售（销售明细，库存数量=0）；现货/预订都默认 0，按需手选；
 *   · 上新：最近 7 天新增货品（今天 + 往前 6 天）；卡片「货号 · 颜色」+「M月D日 HH:mm 新增 · 供应商」；普通码 / 特殊码默认都 0（需手动选）；
 *     顶部统计**只有「新增货品」**；不展示/不筛选货品状态；
 *   · 第三 tab：**待提交列表**（只读核对；采购页不接扫码）；
 *   · 提交：复用既有采购链路；成功后端返回**统一异步 toast 文案**（`config/submitToast.js` 唯一真源）。
 *
 * ⚠️ 渲染层不写死中文 / 数字 / 端点；颜色一律走 `styles/tokens.css` 的 token（本页 CSS 不写 hex/rgb）。
 */
export const PROCUREMENT_UI = Object.freeze({
  appId: 'procurement-app',
  endpoints: Object.freeze({
    replenish: '/api/workbench/procurement/replenish',
    newProducts: '/api/workbench/procurement/new-products',
    submit: '/api/workbench/procurement/submit',
  }),
  title: '采购',
  tabs: Object.freeze([
    Object.freeze({ id: 'replenish', label: '补货', hint: '近 3 天销售' }),
    Object.freeze({ id: 'new', label: '上新', hint: '近期新增货品' }),
    Object.freeze({ id: 'pending', label: '待提交列表', hint: '核对已选' }),
  ]),
  texts: Object.freeze({
    loading: '正在读取…',
    loadFailed: '数据没读到，请稍后重试。',
    retry: '重新加载',
    replenishEmpty: '近 3 天没有需要补货的货品。',
    newProductsEmpty: '近期还没有新增货品。',
    categoryMissing: '这个货品的类别还没填（男鞋 / 女鞋），先补类别再采购。',
    submitting: '提交中…',
    submit: '提交',
    submitFailed: '提交没成功，请稍后重试。',
    refresh: '刷新',
    refreshing: '刷新中…',
    refreshed: '已更新到最新数据',
    noSelection: '还没有选要采购的货品。',
    rangeLabel: '统计范围',
    authFailed: '工作台启动失败：',
    supplierLabel: '供应商',
    supplierUnassigned: '未标注',
    addCustomSize: '＋ 添加尺码',
    customSizePlaceholder: '尺码',
    customSizeInvalid: '尺码要填正整数',
    customSizeDuplicate: '这个尺码已经存在',
    customSizeRemove: '删除这个尺码',
    customSizeModalTitle: '添加自定义尺码',
    customSizeSizeLabel: '尺码',
    customSizeQtyLabel: '数量',
    customSizeAddRow: '＋ 再添加一行',
    customSizeCancel: '取消',
    customSizeSave: '保存',
    customSizeRequired: '请填写尺码和数量',
    pendingEmpty: '还没有选要采购的货品。',
    pendingSupplier: '供应商',
    pendingTotal: '合计 {total} 双',
    pendingSizeLine: '{size} 码 × {quantity}',
    searchPlaceholder: '搜索货号',
  }),
  // 顶部统计（补货 3 项；上新**只有**「新增货品」一项）
  stats: Object.freeze({
    replenish: Object.freeze([
      Object.freeze({ key: 'spotSold', label: '现货已售', unit: '双' }),
      Object.freeze({ key: 'prepaidPending', label: '预订待补', unit: '双' }),
      Object.freeze({ key: 'notArrived', label: '未到货', unit: '双' }),
      Object.freeze({ key: 'productCount', label: '涉及货品', unit: '' }),
    ]),
    newProducts: Object.freeze([
      Object.freeze({ key: 'productCount', label: '新增货品', unit: '' }),
    ]),
  }),
  range: Object.freeze({
    // 业务负责人 2026-10-29 口径：补货窗口 = 今天 00:00 - 3 天 ~ **现在**（含今天已发生）
    replenish: '{from} 00:00 – 现在',
    newProducts: '近 {days} 天（含今天）',
    dayTemplate: '{month}月{day}日',
  }),
  // 数据刷新（业务负责人 2026-10-29）：「实时」= **打开页面时更新一次**；不要自动轮询。
  // 页面停留期间不自动刷（需要最新数据就点统计卡右侧「刷新」按钮）。
  refresh: Object.freeze({
    autoMs: 0,                 // 0 = 关掉自动刷新（默认关）
    visibilityRefreshMs: 0,    // 0 = 切回页面也不自动刷（默认关）
    manual: true,              // 保留手动「刷新」按钮
  }),
  card: Object.freeze({
    // 卡片标题只显示「货号 · 颜色」（记录 ID 只内部用，页面不展示）
    titleTemplate: '{itemNo} · {color}',
    titleFallback: '{number} · {color}',
    newSubtitle: '{date} {time} 新增 · {supplier}',
    newSubtitleNoSupplier: '{date} {time} 新增', // 供应商为空时不显示孤立的「·」（业务负责人 2026-10-29）
    replenishTotal: '需补{total}双',
    newNormalTotal: '普通码 {total} 双',
    specialSummary: '特殊码 · {count} 个（默认 0 双，点开选择）',
    tags: Object.freeze({ spot: '现货', prepaid: '预订', notArrived: '未到货' }),
  }),
  // 兜底文案；正常由服务端 `product_action_labels` 下发（与扫码页共用同一份配置）。
  productActions: Object.freeze({
    adjustLabel: '库存调整',
    infoLabel: '信息完善',
  }),
  units: Object.freeze({
    pair: '双',
    pickedLabel: '已选采购',
    pickedBreakdown: '补货 {replenish} · 上新 {newProducts}',
  }),
  a11y: Object.freeze({ qtyLabel: '{size}码采购数量' }),
  defaults: Object.freeze({ normalQuantity: 0, specialQuantity: 0, maxQuantity: 99 }),
  timezoneOffsetMinutes: 480,
  // 草稿：localStorage，key 必须带当前用户 open_id（同一浏览器换账号不串）
  // ⭐ 2026-11-17：上新默认从 1 改 0 ⇒ 旧草稿里全是自动填的 1，升 version 让旧草稿作废，
  // 刷新后按新默认 0 重新种子（不覆盖用户新选择的语义仍保留）。
  // ⭐ 2026-11-17 晚：预订也不自动填数量（全 0）⇒ 再升 version：v2 草稿里可能还带着
  // 自动填的预订数，作废后按新口径（全 0）重新种子。
  storage: Object.freeze({ prefix: 'procurement:draft:v1', version: 3 }),
  submitKey: Object.freeze({ prefix: 'procurement' }),
  panels: Object.freeze({ replenish: 'replenish', new: 'new' }),
});
