// 销售确认卡片上「颜色候选」那一组的**显示配置**（配置先行）。
//
// 背景（业务负责人 2026-10-07 拍板，逐字）：
//   「我觉得 A 一定要有选颜色的机制……如果有多个颜色，一定要让用户去选择」
//   「B 应该是拿着 A 环节用户选的那个颜色，然后再去找库存」
//   现货的候选要标「有货 / 无货」—— 避免她选到一个没货的颜色再重选
//   （Lead 2026-10-07 替她定，理由即此）。
//
// ⚠️ 本文件**只管显示** + 颜色候选的**取值域 / 文案**：候选从哪来（A 的「货品信息」，
//    兜底才是 B 的「实时库存」）、什么时候跑 B、**候选推哪些颜色**（范围按交易类型，
//    `config/salesTradeTypePolicy`）—— 都在别处。改这里的文案 / 取值域不碰逻辑。
// ⚠️ 取值规则走 `config/envValue`（**没设** → 默认值；**设了**（含空串）→ 就是显式取值）。
// ⚠️ **调用时才解析**（`resolveSalesColorChoiceConfig(process.env)`），
//    不在模块加载时求值 —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。
//
// ⭐「有货 / 无货」怎么算（**零新增远端请求**）：
//    只用**录单时已经读进来的**那张「实时库存」索引（`LiveInventoryIndex`），
//    对每个候选颜色看**那个尺码**有没有实物。判断在 `services/larkMvpService`
//    （`colorOptionsWithStockStatus`），这里只提供两个后缀文案。
//
// ⭐ 2026-10-07 第四刀：现货 / 未付的候选**只推在售**（预付推全部，范围在
//    `config/salesTradeTypePolicy`）。本文件负责这件事的两件"值域 / 文案"：
//    · `SALES_PRODUCT_STATUS_OFF_SHELF` —— 「货品状态」里**哪些取值算不在售**；
//    · `SALES_COLOR_SCOPE_EMPTY_TEXT` —— 候选被过滤空了以后回她的那句话。
//    过滤本身（纯函数、零远端请求）在 `services/larkMvpService.colorOptionsInScope`。

const { readRaw, readString } = require('./envValue');

const AVAILABLE_KEY = 'SALES_COLOR_STOCK_LABEL_AVAILABLE';
const UNAVAILABLE_KEY = 'SALES_COLOR_STOCK_LABEL_UNAVAILABLE';
const STOCK_LOOKUP_FAILED_TEXT_KEY = 'SALES_COLOR_STOCK_LOOKUP_FAILED_TEXT';
const SCOPE_EMPTY_TEXT_KEY = 'SALES_COLOR_SCOPE_EMPTY_TEXT';

// 候选颜色上的库存状态（`color_options[].stock_status`）。
// ⚠️ 用常量而不是散落的字符串字面量：渲染与判定共用同一份取值。
const SALES_COLOR_STOCK_STATUS = Object.freeze({
  available: 'available',
  unavailable: 'unavailable',
});

// 「货品信息」的「货品状态」里，**哪些取值算"不在售"**（现货 / 未付的候选要把它去掉）。
// 这是生产表里那个飞书**公式字段**（在售 / 下架）的取值域 —— 她在生产表里改了选项名，
// 只改这一处。逻辑里**不许**再出现「下架」这两个字。
//
// ⚠️ 判据是「**明确标成不在售**才去掉」，不是"只保留 status === 在售"：
//    状态读不到（这一列缺失 / 公式还没算出来）**不等于下架** —— 那是把"没有证据"
//    当成"负向证据"（`AGENTS.md` 第 17 条）。这种情况下**保留**候选，
//    由选完颜色之后那次 B 给出"这个尺码到底有没有货"的定论（现货 / 未付本来就跑 B）。
//    好处还有一条：候选被清空时那句话可以说得很准 —— 空 = 每个候选都**明确**是下架。
const SALES_PRODUCT_STATUS_OFF_SHELF = Object.freeze(['下架']);

// 候选里的占位符：替换成**这一条明细**的货号（一单多双、只有一双没在售颜色时只报那一双）。
const ITEM_NO_PLACEHOLDER = '{item_no}';

const DEFAULTS = Object.freeze({
  // 跟在颜色名后面的后缀（含括号；这样"要不要括号"也是可配的）。
  availableLabel: '（有货）',
  unavailableLabel: '（无货）',
  // 她点选颜色之后、读「实时库存」失败时回她的那句（候选保留，让她再点一次）。
  // ⚠️ 与上面两个后缀不同：这里是**设成空串就用默认值**（与 `salesProductRegistration`
  //    的拦截文案同一条理由）——它是失败时唯一可见的解释，留空 = 她只看到"点了没反应"。
  stockLookupFailedText: '暂时读不到库存，请再点一次颜色～',
  // 现货 / 未付：这个货号的颜色**全是下架**（候选被过滤空了）时回她的那句。
  // `{item_no}` 换成货号。与上面同理：这是那一刻**唯一可见的解释**，空串 = 用默认。
  scopeEmptyText: '货品信息里 {item_no} 的颜色都下架了，没有在售的颜色可选，请核实～',
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
  const scopeEmptyText = read(SCOPE_EMPTY_TEXT_KEY, DEFAULTS.scopeEmptyText);
  return {
    availableLabel: read(AVAILABLE_KEY, DEFAULTS.availableLabel),
    unavailableLabel: read(UNAVAILABLE_KEY, DEFAULTS.unavailableLabel),
    // ⚠️ 空串 = 用默认文案（见 DEFAULTS 的注释）：它是失败时唯一可见的解释。
    stockLookupFailedText: stockLookupFailedText.trim() ? stockLookupFailedText : DEFAULTS.stockLookupFailedText,
    // 同上：候选被过滤空了，这句话是那一刻唯一可见的解释 —— 空串也回落到默认。
    scopeEmptyText: scopeEmptyText.trim() ? scopeEmptyText : DEFAULTS.scopeEmptyText,
  };
};

/**
 * 把 `{item_no}` 换成这一条明细的货号（与 `salesProductRegistration.formatMissingProductText`
 * 同一套写法：货号里可能出现 `$&` 之类字符，用 split/join 而不是拼正则）。
 */
const formatColorOptionsScopeEmptyText = (template, { itemNo } = {}) =>
  String(template ?? '').split(ITEM_NO_PLACEHOLDER).join(String(itemNo ?? '').trim());

/**
 * 候选按钮上的文字：`黑色（有货）` / `白色（无货）`。
 * `stock_status` 没给（该交易类型不跑 B，例如预付）时**不加后缀** —— 预付本来就没货，
 * 标"无货"只会误导她。
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
  SCOPE_EMPTY_TEXT_KEY,
  ITEM_NO_PLACEHOLDER,
  SALES_COLOR_STOCK_STATUS,
  SALES_PRODUCT_STATUS_OFF_SHELF,
  SALES_COLOR_CHOICE_DEFAULTS: DEFAULTS,
  resolveSalesColorChoiceConfig,
  colorOptionButtonText,
  formatColorOptionsScopeEmptyText,
};
