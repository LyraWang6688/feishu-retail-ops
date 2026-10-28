'use strict';

/**
 * 采购页（供应 → 录单 → 采购）的**全部可配参数** —— 配置先行，服务/路由里不写死数字与文案。
 *
 * 业务口径（2026-10-28 业务负责人逐条确认，见 `docs/procurement-page-real-2026-10-28.md`）：
 *   · 补货：**只查「销售明细」一张表**（库存数量 = 0，销售日 = 今天 00:00 往前 3 个自然日）；
 *   · 上新：`货品信息` 上架日期 = 今天；按记录 ID 分组；普通码默认 1、特殊码默认 0 并折叠；
 *     顶部统计**只有「新增货品」**；不展示/不筛选货品状态；
 *   · 扫一扫：**本轮不做**（tab 仅占位/禁用，无接口、无数据表行）；
 *   · 提交：复用既有 `multiItemOrderService` → `purchaseWebhookService.publishPurchaseRequest`，
 *     不新建草稿表/写库路径；异步回「已提交成功，数据会更新」。
 *
 * 🔴 上限（20 货品 / 50 行）**从 `config/multiItemOrder.js` 直接复用**，不抄第二份（两处写死必漂）。
 * 🔴 尺码段（normal / special）**从 `config/scanPage.js` 的 SIZE_SEGMENTS 直接复用**，不抄第二份。
 * 🔴 交易类型编码的**判据**在 `config/salesMovements.js`；本文件只声明「现货 / 预订」两个角色对应的编码，
 *    服务层会用 `isSalesTradeType()` 再校验一遍（认不出就不计入，不猜）。
 * 🔴 布尔一律 `readFlag`（显式布尔，不用 `||` 兜底：清空变量 = 关掉）。
 */

const { readFlag, readInt, readString } = require('./envValue');
const { MULTI_ITEM_ORDER } = require('./multiItemOrder');
const { SIZE_SEGMENTS, expandRange } = require('./scanPage');

/** 上海时区固定 +08:00（无夏令时）—— 窗口/展示时间的唯一口径。 */
const SHANGHAI_OFFSET_MINUTES = 480;

/** 尺码配置：从 SIZE_SEGMENTS 只取本页要用的三段（类别 / 普通码 / 特殊码）。 */
const resolveSizes = () => {
  const ranges = SIZE_SEGMENTS.ranges;
  const result = {};
  Object.keys(ranges).forEach((category) => {
    const range = ranges[category];
    result[category] = Object.freeze({
      label: range.label,
      // ⚠️ normal 在 SIZE_SEGMENTS 里是**闭区间**（如 A = [38, 44]）⇒ 页面要逐码，用同一份 expandRange 展开
      normal: Object.freeze(expandRange(range.normal)),
      special: Object.freeze([...range.special]),
    });
  });
  return Object.freeze(result);
};

/**
 * @param {object} [env] 默认 `process.env`（用例可传一份假的验「改配置即改行为」）
 */
const buildProcurementPageConfig = (env = process.env) => {
  const minSubmitKey = readInt(env, 'PROCUREMENT_SUBMIT_KEY_MIN', 6, { min: 1, max: 64 });
  const maxSubmitKey = readInt(env, 'PROCUREMENT_SUBMIT_KEY_MAX', 120, { min: 8, max: 400 });
  return Object.freeze({
    // 端点（相对 `/api/workbench`；挂在既有 `routes/workbench/purchase.js` 上，父 router 不改）
    endpoints: Object.freeze({
      replenish: '/procurement/replenish',
      newProducts: '/procurement/new-products',
      submit: '/procurement/submit',
    }),
    // 时间窗口（业务负责人 2026-10-29 口径）：
    //   补货 = [今天 00:00 - days 天, **现在**]（含今天已发生的销售；例：10-29 00:57 ⇒ [10-26 00:00, 10-29 00:57]）
    //   跨月/跨年由 epoch 日期运算自动进位（不手写月份边界）。
    window: Object.freeze({
      replenishDays: readInt(env, 'PROCUREMENT_REPLENISH_DAYS', 3, { min: 1, max: 31 }),
      includeToday: readFlag(env, 'PROCUREMENT_REPLENISH_INCLUDE_TODAY', true),
      offsetMinutes: readInt(env, 'PROCUREMENT_TZ_OFFSET_MINUTES', SHANGHAI_OFFSET_MINUTES, { min: -720, max: 840 }),
    }),
    // 默认值（可手改；改这里不用改渲染层）
    defaults: Object.freeze({
      normalQuantity: readInt(env, 'PROCUREMENT_NORMAL_QTY', 1, { min: 1, max: 99 }),
      specialQuantity: readInt(env, 'PROCUREMENT_SPECIAL_QTY', 0, { min: 0, max: 99 }),
      prepaidSelected: readFlag(env, 'PROCUREMENT_PREPAID_SELECTED', true),
      spotSelected: readFlag(env, 'PROCUREMENT_SPOT_SELECTED', false),
      quantityFromSales: readFlag(env, 'PROCUREMENT_QTY_FROM_SALES', true),
    }),
    // 上限：前两项复用 multiItemOrder（唯一真源）；其余是本页自己的输入护栏
    limits: Object.freeze({
      maxProducts: MULTI_ITEM_ORDER.maxProducts,
      maxLines: MULTI_ITEM_ORDER.maxLines,
      minSubmitKeyLength: minSubmitKey,
      maxSubmitKeyLength: maxSubmitKey,
      // 一次请求最多带多少个货品（比业务上限宽 1 ⇒ 超了由引擎给人话，不静默截断）
      maxRequestItems: MULTI_ITEM_ORDER.maxProducts + 1,
    }),
    // 草稿种子：写进**既有** scan_sessions store（与引擎同一容器）；orderKey 带本页前缀，避开扫码页的草稿键
    draft: Object.freeze({
      orderKeyPrefix: readString(env, 'PROCUREMENT_ORDER_KEY_PREFIX', 'procurement_page'),
      ordersField: MULTI_ITEM_ORDER.session.ordersField,
      chain: readString(env, 'PROCUREMENT_CHAIN', 'replenish'),
      // 本地采购任务记录的 kind（与单货品 `submitReplenish` 那条路**逐字一致**；只用于排查/兼容）
      taskKind: readString(env, 'PROCUREMENT_TASK_KIND', 'scan_replenish'),
    }),
    // 交易类型角色（编码本身以 salesMovements 为准；服务层会 isSalesTradeType 再校验）
    behavior: Object.freeze({ spot: 'SALE_CASH', prepaid: 'SALE_PREPAID' }),
    // 尺码规则（复用 SIZE_SEGMENTS；类别缺失 ⇒ 不猜，见 texts.categoryMissing）
    sizes: resolveSizes(),
    // 筛选公式（列名由调用方按 schema 解析后填进来；这里只留公式骨架）
    filters: Object.freeze({
      replenish: 'AND(CurrentValue.[{stockField}]=0,CurrentValue.[{dateField}]>=TODAY()-{days})',
      newProducts: 'CurrentValue.[{dateField}]>=TODAY()',
    }),
    // 排序（单一真源：服务层按它排；改口径改这里）
    sort: Object.freeze({
      replenishGroup: Object.freeze({ prepaidDesc: true, spotDesc: true, numberAsc: true }),
      sizeAsc: true,
      newProductCreatedAtAsc: true,
    }),
    // 只读缓存（行为表很小；默认 60 秒，0 = 每次重读）
    caches: Object.freeze({
      behaviorMs: readInt(env, 'PROCUREMENT_BEHAVIOR_CACHE_MS', 60000, { min: 0, max: 3600000 }),
    }),
    // 日志事件名（只报事实：数量 / 耗时 / 结果，不报 PII）
    events: Object.freeze({
      replenishLoaded: readString(env, 'PROCUREMENT_EVENT_REPLENISH', 'procurement.page.replenish_loaded'),
      newProductsLoaded: readString(env, 'PROCUREMENT_EVENT_NEW_PRODUCTS', 'procurement.page.new_products_loaded'),
      tradeTypeUnknown: readString(env, 'PROCUREMENT_EVENT_TRADE_TYPE_UNKNOWN', 'procurement.page.trade_type_unknown'),
      submitAccepted: readString(env, 'PROCUREMENT_EVENT_SUBMIT_ACCEPTED', 'procurement.page.submit_accepted'),
      submitRejected: readString(env, 'PROCUREMENT_EVENT_SUBMIT_REJECTED', 'procurement.page.submit_rejected'),
      writeTaskReady: readString(env, 'PROCUREMENT_EVENT_WRITE_TASK_READY', 'procurement.page.write_task_ready'),
    }),
    // 用户可见文案（服务端只出「人话错误 / 成功那一句」；页面标题类文案在前端 config）
    texts: Object.freeze({
      submitAccepted: readString(env, 'PROCUREMENT_TEXT_SUBMITTED', '已提交成功，数据会更新'),
      submitFailed: readString(env, 'PROCUREMENT_TEXT_SUBMIT_FAILED', '提交没成功，请稍后重试。'),
      submitKeyInvalid: readString(env, 'PROCUREMENT_TEXT_SUBMIT_KEY', '这张采购单的提交标识不对，请刷新页面后重试。'),
      itemInvalid: readString(env, 'PROCUREMENT_TEXT_ITEM_INVALID', '有一件货品读不到，请刷新页面后重试。'),
      productMissing: readString(env, 'PROCUREMENT_TEXT_PRODUCT_MISSING', '有一件货品在货品信息里查不到了，请刷新页面后重试。'),
      categoryMissing: readString(env, 'PROCUREMENT_TEXT_CATEGORY_MISSING', '这个货品的类别还没填（A 男鞋 / B 女鞋），先补类别再采购。'),
      replenishEmpty: readString(env, 'PROCUREMENT_TEXT_REPLENISH_EMPTY', '近 3 天没有需要补货的货品。'),
      newProductsEmpty: readString(env, 'PROCUREMENT_TEXT_NEW_PRODUCTS_EMPTY', '今天还没有新增货品。'),
      loadFailed: readString(env, 'PROCUREMENT_TEXT_LOAD_FAILED', '数据没读到，请稍后重试。'),
    }),
  });
};

/** 进程级默认那一份（跟 `process.env` 走；用例请用 `buildProcurementPageConfig(fakeEnv)`）。 */
const PROCUREMENT_PAGE = buildProcurementPageConfig();

module.exports = {
  PROCUREMENT_PAGE,
  buildProcurementPageConfig,
  SHANGHAI_OFFSET_MINUTES,
};
