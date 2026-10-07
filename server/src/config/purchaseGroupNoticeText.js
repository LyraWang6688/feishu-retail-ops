// 采购群那条「@经办人 + 供应商 + 这批 N 双」话术的**文案配置**（配置先行）。
//
// 背景（业务负责人 2026-10-07，逐字）：
//   「我需要你改一下机器人的话术，就是**不用说几条，只给出多少双就可以了**～」
//   她在群里看到的（逐字）：
//     `@王颖 未标注供应商 这批 5 条（共 5 双），图可以直接转给供应商。`
//     `@王颖 三星 这批 12 条（共 13 双），图可以直接转给供应商。`
//   要的：
//     `@王颖 未标注供应商 这批 5 双，图可以直接转给供应商。`
//     `@王颖 三星 这批 13 双，图可以直接转给供应商。`
//   ⇒ **删掉「N 条」（`items.length`）**，只留**双数**（`sum(items[].quantity)`）；
//     @经办人 · 供应商名 · 「图可以直接转给供应商」都保留；「共」也去掉（语义仍清楚）。
//
// ⚠️ 本文件**只管文案**：
//   · 双数怎么算（`sum(items[].quantity)`）**不在这里** —— 它在
//     `services/purchaseWebhookService.deliverSupplierImagesInner`，本次**一个字没改**；
//   · 发到哪个群、怎么进话题（`reply_in_thread`）也不在这里（`config/groupPurchase.js`
//     ＋ `deliverSupplierImagesInner` 的发送逻辑），本次未改。
//
// ⚠️ 采购申请单与采购退货单**共用这同一条文案**：两条链路都走
//   `deliverSupplierImages` → `deliverSupplierImagesInner`（只有标题 / 文件名后缀不同），
//   所以这里**只有一份模板** —— 改它两边一起变、且逐字一致；
//   若刻意只改一个分支，就会造出"同一句话两种写法"的不一致。
//
// ⭐ 取值规则走 `config/envValue`（与 `salesMissingInfoText` / `salesColorChoice`
//    / `salesProductRegistration` 同一套）：
//   · 变量**没设** → 默认值；
//   · 变量**设了** → 用设的值；**设成空串 / 只有空白 → 回落到默认值**
//     （这是她在群里**唯一能看到的那句话**，留空 = 只剩一个 @，等于把信息弄丢了）。
// ⚠️ **调用时才解析**（`resolvePurchaseGroupNoticeConfig(process.env)`），不在模块加载时求值
//    —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。

const { readRaw, readString } = require('./envValue');

const PREFIX = 'PURCHASE_GROUP_NOTICE_';

// 环境变量键（一个文案一个键；`.env.example` 里给了默认值说明，不配也能跑）。
const KEYS = Object.freeze({
  text: `${PREFIX}TEXT`,
  mention: `${PREFIX}MENTION_TEXT`,
  unknownSupplier: `${PREFIX}UNKNOWN_SUPPLIER_TEXT`,
});

// 占位符（**只有这几个**；未知占位符原样留着，方便一眼看出模板写错了）。
const PLACEHOLDERS = Object.freeze({
  supplier: '供应商名（取不到时用 `unknownSupplier` 那句兜底，如「未标注供应商」）',
  pairs: '**双数**（= 这一组明细的 `quantity` 求和；不是明细条数）',
  openId: '经办人的 open_id（只有 @ 那条模板用）',
});

const DEFAULTS = Object.freeze({
  // ⚠️ 2026-10-07 改动点：删掉「{rowCount} 条（共 …）」整段，只留 `{pairs} 双`。
  //    逐字 = 她要的那两句（`@… 三星 这批 13 双，图可以直接转给供应商。`）。
  text: '{supplier} 这批 {pairs} 双，图可以直接转给供应商。',
  // @ 经办人的飞书文本标记（唯一一处；原先硬编码在 `mentionOperatorText` 里）。
  // ⚠️ 末尾那一个空格是**她看到的样子**（`@某某 三星 这批…`）。
  //    走环境变量时会被 `config/envValue` 的 `trim()` 去掉末尾空格 ——
  //    要保留空格就用**默认值**（`SALES_MISSING_INFO_LINE_PREFIX_TEXT` 是同一个坑）。
  mention: '<at user_id="{openId}"></at> ',
  // 供应商取不到时的兜底写法（原先硬编码在 `deliverSupplierImagesInner` 里）。
  unknownSupplier: '未标注供应商',
});

// 把 `{name}` 换成值。用**替换回调**而不是拼字符串（值里可能出现 `$&` 这类字符，
// 回调的返回值是字面量、不做二次解释）；认不出的占位符**原样留着**。
const format = (template, values = {}) =>
  String(template ?? '').replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
  ));

// ⭐ **键 → 默认值**的唯一定义（`resolvePurchaseGroupNoticeConfig` 就按它逐个读）。
//    ⚠️ 同时与 `.env.example` 里那一段**逐字对应**，有守门用例
//    （`purchaseGroupNoticeText.test.js`）—— 新加一条文案却忘了写进 `.env.example`、
//    或两处默认值改歪了，测试会红。
const DEFAULTS_BY_KEY = Object.freeze({
  [KEYS.text]: DEFAULTS.text,
  [KEYS.mention]: DEFAULTS.mention,
  [KEYS.unknownSupplier]: DEFAULTS.unknownSupplier,
});

/** 读一份文案：任何一项 —— 没设 → 默认；设了但只有空白 → 也用默认（见文件头注释）。 */
const resolvePurchaseGroupNoticeConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    if (raw === null) return fallback;
    const value = readString(env, key, fallback);
    if (!String(value).trim()) return fallback;
    return String(value);
  };
  const text = Object.create(null);
  for (const [key, fallback] of Object.entries(DEFAULTS_BY_KEY)) text[key] = read(key, fallback);
  return {
    text: text[KEYS.text],
    mention: text[KEYS.mention],
    unknownSupplier: text[KEYS.unknownSupplier],
  };
};

/** 供应商名 → 群里那个说法：有名字就用名字，取不到才用兜底写法（**绝不编**）。 */
const supplierLabel = (supplierName, config = resolvePurchaseGroupNoticeConfig()) => {
  const name = String(supplierName || '').trim();
  return name || config.unknownSupplier;
};

/**
 * 那段正文（**不含 @**）：`三星 这批 13 双，图可以直接转给供应商。`
 * `pairs` = 这一组明细的 `quantity` 求和（口径由调用方给，本模块**不算数**）。
 */
const renderPurchaseGroupNoticeText = ({ supplierName, label, pairs } = {},
  config = resolvePurchaseGroupNoticeConfig()) => format(config.text, {
  supplier: label === undefined ? supplierLabel(supplierName, config) : label,
  pairs: Number(pairs || 0),
});

/** @ 经办人：拿不到 open_id 就**不加 @**（只给正文），绝不 @错人、更不 @所有人。 */
const renderPurchaseGroupNoticeMention = (operatorOpenId, config = resolvePurchaseGroupNoticeConfig()) => {
  const openId = String(operatorOpenId || '').trim();
  if (!openId) return '';
  return format(config.mention, { openId });
};

/** 唯一入口：正文 ＋ （拿得到经办人时的）@ —— 就是她群里看到的那一整条（改后逐字）。 */
const renderPurchaseGroupNotice = ({ supplierName, label, pairs, operatorOpenId } = {},
  config = resolvePurchaseGroupNoticeConfig()) => (
  `${renderPurchaseGroupNoticeMention(operatorOpenId, config)}`
  + `${renderPurchaseGroupNoticeText({ supplierName, label, pairs }, config)}`
);

module.exports = {
  PREFIX,
  KEYS,
  PLACEHOLDERS,
  PURCHASE_GROUP_NOTICE_DEFAULTS: DEFAULTS,
  PURCHASE_GROUP_NOTICE_DEFAULTS_BY_KEY: DEFAULTS_BY_KEY,
  formatPurchaseGroupNotice: format,
  resolvePurchaseGroupNoticeConfig,
  supplierLabel,
  renderPurchaseGroupNoticeText,
  renderPurchaseGroupNoticeMention,
  renderPurchaseGroupNotice,
};
