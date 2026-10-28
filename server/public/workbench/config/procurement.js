/**
 * 采购页（供应 → 录单 → 采购）的前端配置 —— 文案 / 端点 / 默认值 / 尺码规则 / 刷新参数**只在这里**。
 *
 * 业务口径（2026-10-28 业务负责人确认，见 `docs/procurement-page-real-2026-10-28.md`）：
 *   · 补货：近 3 天销售（销售明细，库存数量=0）；现货/预订；预订默认选中；
 *   · 上新：今天新增货品；卡片「货号 · 颜色」+「今日 HH:mm 新增 · 供应商」；普通码默认 1 / 特殊码默认 0 折叠；
 *     顶部统计**只有「新增货品」**；不展示/不筛选货品状态；
 *   · 扫一扫：**本轮只占位/禁用**（不扫码、不开会话、不提交）；
 *   · 提交：复用既有采购链路；成功统一「已提交成功，数据会更新」。
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
    Object.freeze({ id: 'new', label: '上新', hint: '近 1 天新增货品' }),
    // 扫一扫本轮不做：保留视觉入口（禁用 + 不可点），不挂扫码模块
    Object.freeze({
      id: 'scan', label: '扫一扫', hint: '补货扫码', disabled: true,
      disabledHint: '扫一扫本轮暂未开放，先用补货 / 上新。', tapTarget: 'scan:replenish',
    }),
  ]),
  texts: Object.freeze({
    loading: '正在读取…',
    loadFailed: '数据没读到，请稍后重试。',
    retry: '重新加载',
    replenishEmpty: '近 3 天没有需要补货的货品。',
    newProductsEmpty: '今天还没有新增货品。',
    categoryMissing: '这个货品的类别还没填（A 男鞋 / B 女鞋），先补类别再采购。',
    submitting: '提交中…',
    submit: '提交',
    submitted: '已提交成功，数据会更新',
    submitFailed: '提交没成功，请稍后重试。',
    refresh: '刷新',
    refreshing: '刷新中…',
    refreshed: '已更新到最新数据',
    scanDisabled: '扫一扫本轮暂未开放，先用补货 / 上新。',
    scanTabHint: '补货扫码',
    noSelection: '还没有选要采购的货品。',
    rangeLabel: '统计范围',
    authFailed: '工作台启动失败：',
    logout: '退出登录',
  }),
  // 顶部统计（补货 3 项；上新**只有**「新增货品」一项）
  stats: Object.freeze({
    replenish: Object.freeze([
      Object.freeze({ key: 'spotSold', label: '现货已售', unit: '双' }),
      Object.freeze({ key: 'prepaidPending', label: '预订待补', unit: '双' }),
      Object.freeze({ key: 'productCount', label: '涉及货品', unit: '' }),
    ]),
    newProducts: Object.freeze([
      Object.freeze({ key: 'productCount', label: '新增货品', unit: '' }),
    ]),
  }),
  summary: Object.freeze({
    singleStatInline: true, // 只有 1 个统计项（上新）⇒ 统计 + 统计范围 + 刷新**排在一行**
  }),
  range: Object.freeze({
    // 业务负责人 2026-10-29 口径：补货窗口 = 今天 00:00 - 3 天 ~ **现在**（含今天已发生）
    replenish: '{from} 00:00 – 现在',
    newProducts: '今日 00:00 – 现在',
    dayTemplate: '{month}月{day}日',
  }),
  // 数据刷新（业务负责人 2026-10-29）：「实时」= **打开页面时更新一次**；不要自动轮询。
  // 页面停留期间不自动刷（需要最新数据就点统计卡右侧「刷新」按钮）。
  refresh: Object.freeze({
    autoMs: 0,                 // 0 = 关掉自动刷新（默认关）
    visibilityRefreshMs: 0,    // 0 = 切回页面也不自动刷（默认关）
    manual: true,              // 保留手动「刷新」按钮
  }),
  legends: Object.freeze({
    replenish: Object.freeze([
      Object.freeze({ kind: 'prepaid', text: '预订：必补，默认已选' }),
      Object.freeze({ kind: 'spot', text: '现货：按需自行选择' }),
    ]),
    newProducts: Object.freeze([
      Object.freeze({ kind: 'spot', text: '普通码：默认采购 1 双' }),
      Object.freeze({ kind: 'prepaid', text: '特殊码：默认 0，自动折叠' }),
    ]),
  }),
  card: Object.freeze({
    // 卡片标题只显示「货号 · 颜色」（记录 ID 只内部用，页面不展示）
    titleTemplate: '{itemNo} · {color}',
    titleFallback: '{number} · {color}',
    newSubtitle: '今日 {time} 新增 · {supplier}',
    replenishTotal: '需补{total}双',
    newNormalTotal: '普通码 {total} 双',
    specialSummary: '特殊码 · {count} 个（默认 0 双，点开选择）',
    tags: Object.freeze({ spot: '现货', prepaid: '预订' }),
  }),
  units: Object.freeze({
    pair: '双',
    pickedLabel: '已选采购',
    pickedBreakdown: '补货 {replenish} · 上新 {newProducts}',
  }),
  a11y: Object.freeze({ qtyLabel: '{size}码采购数量' }),
  defaults: Object.freeze({ normalQuantity: 1, specialQuantity: 0, maxQuantity: 99 }),
  timezoneOffsetMinutes: 480,
  // 草稿：localStorage，key 必须带当前用户 open_id（同一浏览器换账号不串）
  storage: Object.freeze({ prefix: 'procurement:draft:v1', version: 1 }),
  submitKey: Object.freeze({ prefix: 'procurement' }),
  panels: Object.freeze({ replenish: 'replenish', new: 'new' }),
});
