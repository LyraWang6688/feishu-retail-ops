// 售后**扫一扫落地页**的读侧配置（配置先行：时间窗 / 取哪些列 / 人话都在这里）。
//
// 为什么单独成文件（而不是塞进 config/afterSales.js）：
//   · `config/afterSales.js` 是**执行器**的契约（动作语义 / 幂等 / 落库）；
//   · 这一份是**页面读出来看**的契约（近几天 / 读什么列 / 空态怎么说）。
//   两者服务对象不同，混在一起以后改页面会碰到记账口径（模块化）。
//
// 页面口径（业务负责人 2026-10-29）：
//   扫码 → 用二维码里的**货品记录 id** 找「近 7 天」的销售记录 →
//   每条候选摆出「**销售日** / **尺码** / **销售主表总金额**」→ 她点一条再选售后动作。
//   ⇒ 所以这里要读销售明细的「销售日、尺码」，和销售主表的「总金额」。
//
// ⭐ 「近 7 天」到底怎么算（业务负责人 2026-10-29 问过，这里写死口径）：
//   按**上海自然日**：今天 + 往前 (7-1)=6 天，**含今天共 7 个自然日**
//   （例：今天 2026-10-29 ⇒ 从 2026-10-23 00:00 起算；共用的窗口计算在
//    `utils/salesDateWindows.lookupWindowStart`，与项目其它"最近几天"同一口径）。
//   🔴 **不是**"此刻往前滚 7×24 小时"（那会让同一个上午查两次的窗口不一样）。
// ⭐ 「销售日」**只认销售明细的「销售日」**：**没有兜底**（业务负责人 2026-10-29 逐字：
//   「不用你做兜底，它就是来自于销售明细里面的销售日」）⇒ 没有销售日的行不进候选。

/** 默认 / 最长的查找窗口（**上海自然日**，含今天）。与既有候选接口（`afterSalesPage.days = 7`）同一口径。 */
const SCAN_WINDOW_DAYS_DEFAULT = 7;
const SCAN_WINDOW_DAYS_MAX = 30;

/**
 * 只读这两张表时**按需取列**（语义键 → 飞书列名由 schema 解析）。
 *
 * ⚠️ 一个都没映射到 ⇒ 调用方**不传** `fieldNames`（退回整表读：宁可慢，不许少列）。
 * ⚠️ 只列**页面真的会用到 + 判据真的会用到**的列，多一列都不加。
 *   · `salesDetail.product`   —— 判"这一条是不是扫到的那款货品"（唯一归属判据）；
 *   · `salesDetail.salesEntry`/`size`/`soldAt`/`fulfillmentStatus`/`actualAmount` —— 页面展示 + 排除已售后；
 *   · `salesEntry.orderNo`/`writeStatus`/`totalAmount`
 *       —— 单号（内部排查用）、判"已入账"（失败/未完成的单不做售后）、
 *          **总金额**（她点名要展示的那个）。
 *   ⚠️ **不读「录单日」**：她的口径是销售日只来自销售明细，不做兜底 ⇒ 这一列没有消费点。
 */
const SCAN_FIELD_KEYS = Object.freeze({
  salesDetail: Object.freeze([
    'product', 'salesEntry', 'size', 'soldAt', 'fulfillmentStatus', 'actualAmount',
  ]),
  salesEntry: Object.freeze(['orderNo', 'writeStatus', 'totalAmount']),
});

/** 读侧的人话（错误 / 空态之外的都放前端配置；这里只放**后端会直接回给页面**的那几句）。 */
const SCAN_TEXTS = Object.freeze({
  missingProduct: '缺少货品记录，请重新扫码。',
  productNotFound: '扫到的货品不存在（可能已被删除），请重新扫码。',
});

/** 查询参数里的天数：认不出 / 越界就回默认（不因为一个参数把页面打挂）。 */
const resolveScanWindowDays = (raw) => {
  const fallback = SCAN_WINDOW_DAYS_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(SCAN_WINDOW_DAYS_MAX, Math.max(1, Math.floor(value)));
};

module.exports = {
  SCAN_WINDOW_DAYS_DEFAULT,
  SCAN_WINDOW_DAYS_MAX,
  SCAN_FIELD_KEYS,
  SCAN_TEXTS,
  resolveScanWindowDays,
};
