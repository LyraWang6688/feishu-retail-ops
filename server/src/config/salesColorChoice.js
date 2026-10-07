// 销售确认卡片上「颜色候选」那一组的**显示配置**（配置先行）。
//
// 背景（业务负责人 2026-10-07 拍板，逐字）：
//   「我觉得 A 一定要有选颜色的机制……如果有多个颜色，一定要让用户去选择」
//   「B 应该是拿着 A 环节用户选的那个颜色，然后再去找库存」
//   ⭐ 最新一步（同一天，逐字）：「这里要给到**全色**，让用户去选」——
//     ⇒ 候选**不再按「在售 / 下架」过滤**（那一套 `colorOptionsScope` /
//       `SALES_COLOR_SCOPE_EMPTY_TEXT` 已整体退场，见 `docs/sales-type-by-stock-2026-10-07.md`）。
//     理由：预定 = 没货，若候选只推在售，她永远选不到没货的颜色 ⇒ 预定走不通。
//
// ⚠️ 本文件**只管显示** + 两个后缀文案：候选从哪来（A 的「货品信息」）、
//    什么时候跑 B、**类型怎么定**（查完库存再定）—— 都在别处
//    （`config/salesTradeTypePolicy` / `services/larkMvpService`）。改这里的文案不碰逻辑。
// ⚠️ 取值规则走 `config/envValue`（**没设** → 默认值；**设了**（含空串）→ 就是显式取值）。
// ⚠️ **调用时才解析**（`resolveSalesColorChoiceConfig(process.env)`），
//    不在模块加载时求值 —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。
//
// ⭐「有货 / 无货」怎么算（**零新增远端请求**）：
//    只用**录单时已经读进来的**那张「实时库存」索引（`LiveInventoryIndex`），
//    对每个候选颜色看**那个尺码**有没有实物。判断在 `services/larkMvpService`
//    （`colorOptionsWithStockStatus`），这里只提供两个后缀文案。
//
// ⭐ 标注的**语义**（2026-10-07 新口径）：它不只是"能不能买"，而是
//    **这双会记成现货还是预定的预告** ——「有货」→ 现货（交付 + 扣库存），
//    「无货」→ 预定（不交付，等货到再交付）。所以两种类型、每一个候选**都要标**。

const { readRaw, readString } = require('./envValue');

const AVAILABLE_KEY = 'SALES_COLOR_STOCK_LABEL_AVAILABLE';
const UNAVAILABLE_KEY = 'SALES_COLOR_STOCK_LABEL_UNAVAILABLE';
const STOCK_LOOKUP_FAILED_TEXT_KEY = 'SALES_COLOR_STOCK_LOOKUP_FAILED_TEXT';

// 候选颜色上的库存状态（`color_options[].stock_status`）。
// ⚠️ 用常量而不是散落的字符串字面量：渲染与判定共用同一份取值。
//    ⭐ 它同时是**类型判据**的输入：`available` → 现货，`unavailable` → 预定
//    （映射在 `config/salesTradeTypePolicy.salesTradeTypeForStock`）。
const SALES_COLOR_STOCK_STATUS = Object.freeze({
  available: 'available',
  unavailable: 'unavailable',
});

const DEFAULTS = Object.freeze({
  // 跟在颜色名后面的后缀（含括号；这样"要不要括号"也是可配的）。
  availableLabel: '（有货）',
  unavailableLabel: '（无货）',
  // 她点选颜色之后、读「实时库存」失败时回她的那句（候选保留，让她再点一次）。
  // ⚠️ 与上面两个后缀不同：这里是**设成空串就用默认值**（与 `salesProductRegistration`
  //    的拦截文案同一条理由）——它是失败时唯一可见的解释，留空 = 她只看到"点了没反应"。
  stockLookupFailedText: '暂时读不到库存，请再点一次颜色～',
});

/**
 * 读一份显示配置。任何一项：
 *   · 环境变量**没设** → 默认值；
 *   · **设了**（含空串）→ 用设的值（空串 = 那个后缀不显示，与 `envValue` 的规矩一致）。
 */
const resolveSalesColorChoiceConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    return raw === null ? fallback : readString(env, key, fallback);
  };
  const stockLookupFailedText = read(STOCK_LOOKUP_FAILED_TEXT_KEY, DEFAULTS.stockLookupFailedText);
  return {
    availableLabel: read(AVAILABLE_KEY, DEFAULTS.availableLabel),
    unavailableLabel: read(UNAVAILABLE_KEY, DEFAULTS.unavailableLabel),
    // ⚠️ 空串 = 用默认文案（见 DEFAULTS 的注释）：它是失败时唯一可见的解释。
    stockLookupFailedText: stockLookupFailedText.trim() ? stockLookupFailedText : DEFAULTS.stockLookupFailedText,
  };
};

/**
 * 候选按钮上的文字：`黑色（有货）` / `白色（无货）`。
 * `stock_status` 没给（例如配品、或本地索引读不到那一条）时**不加后缀** ——
 * 不猜（见《AGENTS.md》第 17 条：没有证据就不下负向结论）。
 * 颜色为空时保留既有兜底「未命名颜色」。
 */
const colorOptionButtonText = (option = {}, config = resolveSalesColorChoiceConfig()) => {
  const color = String(option.color || '').trim() || '未命名颜色';
  if (option.stock_status === SALES_COLOR_STOCK_STATUS.available) return `${color}${config.availableLabel}`;
  if (option.stock_status === SALES_COLOR_STOCK_STATUS.unavailable) return `${color}${config.unavailableLabel}`;
  return color;
};

module.exports = {
  AVAILABLE_KEY,
  UNAVAILABLE_KEY,
  STOCK_LOOKUP_FAILED_TEXT_KEY,
  SALES_COLOR_STOCK_STATUS,
  SALES_COLOR_CHOICE_DEFAULTS: DEFAULTS,
  resolveSalesColorChoiceConfig,
  colorOptionButtonText,
};
