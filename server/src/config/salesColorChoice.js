// 销售确认卡片上「颜色候选」那一组的**显示配置**（配置先行）。
//
// 背景（业务负责人 2026-10-07 拍板，逐字）：
//   「我觉得 A 一定要有选颜色的机制……如果有多个颜色，一定要让用户去选择」
//   「B 应该是拿着 A 环节用户选的那个颜色，然后再去找库存」
//   ⭐ 最新一步（同一天，逐字）：「**甲 去掉**（推荐，贴合你的口径）：候选只显示颜色
//     （黑色 / 绿色），**选完 → 再查库存 → 告诉她"这双有货→现货"或"没货→预定"**」
//     ⇒ 候选按钮上**不再**打「有货 / 无货」预览标注：
//       `SALES_COLOR_STOCK_LABEL_AVAILABLE` / `…_UNAVAILABLE` 两个环境变量与
//       `SALES_COLOR_STOCK_STATUS` 常量**一并删除**（不留死配置）。
//       类型仍在她选完颜色之后、由**那一次**实时库存查询定（见 `services/larkMvpService`
//       的 `choose_sale_color` 分支）。
//   ⭐ 更早一步（同一天，逐字）：「这里要给到**全色**，让用户去选」——
//     ⇒ 候选**不再按「在售 / 下架」过滤**（那一套 `colorOptionsScope` /
//       `SALES_COLOR_SCOPE_EMPTY_TEXT` 已整体退场，见 `docs/sales-type-by-stock-2026-10-07.md`）。
//     理由：预定 = 没货，若候选只推在售，她永远选不到没货的颜色 ⇒ 预定走不通。
//
// ⚠️ 本文件**只管显示**：候选从哪来（A 的「货品信息」）、什么时候跑 B、
//    **类型怎么定**（她选完颜色、查完库存才定）—— 都在别处
//    （`config/salesTradeTypePolicy` / `services/larkMvpService`）。改这里的文案不碰逻辑。
// ⚠️ 取值规则走 `config/envValue`（**没设** → 默认值；**设了**（含空串）→ 就是显式取值）。
// ⚠️ **调用时才解析**（`resolveSalesColorChoiceConfig(process.env)`），
//    不在模块加载时求值 —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。

const { readRaw, readString } = require('./envValue');

const STOCK_LOOKUP_FAILED_TEXT_KEY = 'SALES_COLOR_STOCK_LOOKUP_FAILED_TEXT';

const DEFAULTS = Object.freeze({
  // 她点选颜色之后、读「实时库存」失败时回她的那句（候选保留，让她再点一次）。
  // ⚠️ **设成空串就用默认值**（与 `salesProductRegistration` 的拦截文案同一条理由）——
  //    它是失败时唯一可见的解释，留空 = 她只看到"点了没反应"。
  // ⚠️ 它**不是**"候选上的库存状态"那套东西：预览标注已随本轮口径删除，
  //    这条只管"她选完之后读不到库存"这一种失败。
  stockLookupFailedText: '暂时读不到库存，请再点一次颜色～',
});

/**
 * 读一份显示配置。任何一项：
 *   · 环境变量**没设** → 默认值；
 *   · **设了**（含空串）→ 用设的值。
 */
const resolveSalesColorChoiceConfig = (env = process.env) => {
  const raw = readRaw(env, STOCK_LOOKUP_FAILED_TEXT_KEY);
  const stockLookupFailedText = raw === null
    ? DEFAULTS.stockLookupFailedText
    : readString(env, STOCK_LOOKUP_FAILED_TEXT_KEY, DEFAULTS.stockLookupFailedText);
  return {
    // ⚠️ 空串 = 用默认文案（见 DEFAULTS 的注释）：它是失败时唯一可见的解释。
    stockLookupFailedText: stockLookupFailedText.trim() ? stockLookupFailedText : DEFAULTS.stockLookupFailedText,
  };
};

/**
 * 候选按钮上的文字：**只有颜色名**（`黑色`）。
 *
 * ⭐ 2026-10-07：这里以前会按 `option.stock_status` 拼「（有货）/（无货）」后缀；
 *   那个预览标注已被业务负责人去掉（「候选只显示颜色（黑色 / 绿色），选完 → 再查库存」）
 *   ⇒ 后缀分支与它的配置键一并删除；本函数**不再读 `stock_status`**
 *   （候选上也不再有这个字段）。
 * 颜色为空时保留既有兜底「未命名颜色」。
 */
const colorOptionButtonText = (option = {}) => String(option.color || '').trim() || '未命名颜色';

module.exports = {
  STOCK_LOOKUP_FAILED_TEXT_KEY,
  SALES_COLOR_CHOICE_DEFAULTS: DEFAULTS,
  resolveSalesColorChoiceConfig,
  colorOptionButtonText,
};
