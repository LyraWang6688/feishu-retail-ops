// 销售录单：**A（读「货品信息」）之后**那道「这个货号到底有没有建档」的判据（配置先行）。
//
// 为什么要有它（业务负责人口径，逐字）：
//   「对，所以三种交易类型，在看完货品信息之后，如果在货架上没有找到，
//     都应该给到这个提示，而不是说等到 B」
//
// 起因是真机那一单：`26002-52`（其实是 `B26002-52`，语音转文字漏了 `B`）走**预付**，
// 点了确认才失败（`找不到货品：26002-52`）。因为：
//   · 解析 A（货品信息）货号找不到时**只是空手回来、不吭声**；
//   · 解析 B（实时库存）才会把"库存里没有…"当缺项 —— 而**预付按交易类型根本不跑 B**。
// ⇒ 现货被 B 顺手拦住；**没货那一类（现口径的「预定」）一处提示都没有**。
//
// ⚠️ 这条判据**只**回答一件事：**「货品信息」这张表里有没有这个货号的记录**。
//    它与「货号找到了、只是齐备公式说缺字段（缺成本…）」**是两件事**：
//    后者仍然**不拦**，只进「补货品信息」那一段（**处理中卡 + 已入账终态卡**都带）
//    （见 `config/productInfoGaps.js`）——「没建档要拦、缺资料不拦」。
//
// ⚠️ 判据的**正证据**口径（写在 `larkMvpService.productRegistrationFrom` 上）：
//    只有「货品信息整表读成功 + 里面确实没有这个货号」才判"没建档"；
//    读不到就**不下结论**（记一条 undetermined 警告，不拦单）——
//    这正是 `AGENTS.md` 第 17 条「结论是『没有』→ 必须去事实表核过再说」的落地。
//
// ⚠️ 取值规则走 `config/envValue`（**没设** → 默认值；**设了**（含空串）→ 就是显式取值），
//    与 `productInfoGaps` / `salesProcessingCard` / `privateChatNotice` 共用同一套。
// ⚠️ **调用时才解析**（`resolveSalesProductRegistrationConfig(process.env)`），
//    不在模块加载时求值 —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。

const { readRaw, readString, readFlag } = require('./envValue');

const ENABLED_KEY = 'SALES_PRODUCT_REGISTRATION_GUARD_ENABLED';
const MISSING_TEXT_KEY = 'SALES_PRODUCT_REGISTRATION_MISSING_TEXT';

// 文案里的占位符：替换成**这一条明细**的货号（一单多双、只缺其中一双时只报那一双）。
const ITEM_NO_PLACEHOLDER = '{item_no}';

const DEFAULTS = Object.freeze({
  // **显式布尔**：`false` / 空串 = 不拦（但会记一条 `…guard_disabled`，"为什么没拦"可查）。
  enabled: true,
  // 拦截时回她的那句话。`{item_no}` 换成货号。
  missingText: '货品信息里没有 {item_no}，请先在「货品信息」建档或核对货号，再发一次～',
});

// 正向证据日志的事件名（判据命中的唯一"看得见"的痕迹：为什么没出卡片）。
// 与下面那句文案同源放在配置里：改名只改一处。
const EVENTS = Object.freeze({
  // 判据命中、已按缺项拦下（带 task_id / item_no / size）。
  blocked: 'lark.sales.product_missing.blocked',
  // 开关关掉时"本可以拦"的痕迹（诊断"为什么没拦"）。
  guardDisabled: 'lark.sales.product_missing.guard_disabled',
  // 读不到「货品信息」（索引没建出来）⇒ 不下结论、不拦，但要能查。
  undetermined: 'lark.sales.product_missing.undetermined',
});

/**
 * 读一份「货号建档判据」的配置。任何一项：
 *   · 环境变量**没设** → 默认值；
 *   · **设了**（含空串）→ 用设的值（`enabled` 空串 = false，见 envValue.readFlag）。
 */
const resolveSalesProductRegistrationConfig = (env = process.env) => {
  const readText = (key, fallback) => {
    const raw = readRaw(env, key);
    return raw === null ? fallback : readString(env, key, fallback);
  };
  const missingText = readText(MISSING_TEXT_KEY, DEFAULTS.missingText);
  return {
    enabled: readFlag(env, ENABLED_KEY, DEFAULTS.enabled),
    // ⚠️ 文案**设成空串时按默认文案**处理 —— 与「段落类」配置（`PRODUCT_INFO_GAPS_*`，
    //    空串 = 那一项渲染成空）**有意不同**：这句话是拦截时**唯一可见的解释**，
    //    留空 = 她那边只看到"没有卡片、也没有回复"（比不拦还坏，成了说不清的静默失败）。
    //    ⇒ 想关掉拦截请用上面的开关，不是把文案清空。
    missingText: missingText.trim() ? missingText : DEFAULTS.missingText,
  };
};

/**
 * 把 `{item_no}` 换成这一条明细的货号。
 * 用 split/join 而不是 RegExp：货号里可能出现 `$&` 之类的字符，替换串拼正则会被它咬。
 */
const formatMissingProductText = (template, { itemNo } = {}) =>
  String(template ?? '').split(ITEM_NO_PLACEHOLDER).join(String(itemNo ?? '').trim());

module.exports = {
  ENABLED_KEY,
  MISSING_TEXT_KEY,
  ITEM_NO_PLACEHOLDER,
  SALES_PRODUCT_REGISTRATION_DEFAULTS: DEFAULTS,
  SALES_PRODUCT_REGISTRATION_EVENTS: EVENTS,
  resolveSalesProductRegistrationConfig,
  formatMissingProductText,
};
