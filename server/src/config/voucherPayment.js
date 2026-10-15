'use strict';

/**
 * 抖音团购券 · 扫码页「资金页」那一行收款的全部口径（**配置先行**的落地件）。
 *
 * 业务负责人 2026-10-16 逐字（唯一权威）：
 *   「**抖音团购券**……**差额的计算按照面值来**，但是**收款明细里的收款金额按照平台结算款**来」
 *   「是的，抖音团购券的是**待平台结算**，你可以看到我们往群里推送抖音团购券的消息链路」
 *
 * ⇒ **三个数各用各的**（一张券 = 一行收款，但这一行有**两个金额口径**）：
 *   · 「**面值**」（券能抵多少钱）        → 算**差额（未收款）**：差额 = 货品 − Σ面值（她例：300 + 面值 100 ⇒ 未收款 200）
 *   · 「**平台结算款**」（平台真给店里的钱） → 写**收款明细那一笔的金额**（如 47.40 / 85.40，**不是面值** ✗）
 *   · 「**待平台结算**」                → 那一笔的**收款状态**（钱还在平台上，不算"已收"）
 *
 * 券的判定（她 ④ + 生产真表只读核实 2026-10-16）：收款方式那条记录上的
 *   「**团购券管理**」**关联列非空** ⇒ 这条收款方式是券。
 *   ⚠️ 列名放**语义键**里（`config/v1BitableSchema` 的 `paymentMethod.fields.voucher`），
 *      **逻辑里一行中文都不写** ✗。
 *
 * ⚠️ 本文件只放**会改的口径**（语义键 / 状态取值 / 事件名 / 开关 / 那一句人话）——
 *    service 与路由拿它，自己不放中文。她要换状态取值、换那句话，只改这里。
 *
 * ⚠️ 取值规则（"空串算不算关"）走 `config/envValue`：**变量没设** → 默认值；
 *    **设了**（含空串）→ 就是显式取值。**不写 `process.env.X || fallback`** ✗。
 */

const { V1_BITABLE_SCHEMA } = require('./v1BitableSchema');
const { readFlag, readString } = require('./envValue');
// 「待平台结算」是**收款明细里的取值**（表里的事实，不是文案）——真源在 `config/salesCardFacts`，
// 这里**只引用**，不另抄一个中文字面量（换取值时只改那一处）。
const { PENDING_SETTLEMENT_STATUS } = require('./salesCardFacts');
// 券目录「在售」的口径与 9 点推送【团购券待结算】那一块**同一份**（真源 `config/voucherSettlement`）：
//   连**环境变量名**都用它那一个 ⇒ 一处换个值，两块一起变 ✓（**不新造第二个旋钮** ✗）。
const { DEFAULT_ON_SALE_STATUS, VOUCHER_ON_SALE_STATUS_ENV_KEY } = require('./voucherSettlement');

// ── 语义键（**只读** `config/v1BitableSchema`，不复制字段名）────────────────────
const PAYMENT_METHOD_TABLE_KEY = 'paymentMethod';
const VOUCHER_TABLE_KEY = 'groupBuyVoucher';
/** 收款方式表上「团购券管理」关联列的**语义键**（列名本身在 `v1BitableSchema`）。 */
const VOUCHER_LINK_FIELD_KEY = 'voucher';
/** 券表上要用的四个语义键（目录匹配 / 两个金额 / 在售状态）。 */
const VOUCHER_FIELDS = Object.freeze({
  name: 'name', faceValue: 'faceValue', settlementAmount: 'settlementAmount', status: 'status',
});

/** 收款方式那条记录上「团购券管理」的真列名；取不到 = 配置缺了（调用方照推 + warn）。 */
const voucherLinkFieldName = () => V1_BITABLE_SCHEMA.tables?.[PAYMENT_METHOD_TABLE_KEY]
  ?.fields?.[VOUCHER_LINK_FIELD_KEY] || '';

/** 券表四个语义键 → 真列名。 */
const voucherFieldNames = () => {
  const fields = V1_BITABLE_SCHEMA.tables?.[VOUCHER_TABLE_KEY]?.fields || {};
  const resolved = {};
  for (const [key, semantic] of Object.entries(VOUCHER_FIELDS)) resolved[key] = fields[semantic] || '';
  return resolved;
};

// ── 事件名（**既定的可 grep 事件名**，一查日志就知道是哪一步）──────────────────
// 缺映射（这条券方式在券目录里找不到对应那张券）⇒ **大声 warn**，**不许静默当普通收款** ✗。
const VOUCHER_METHOD_UNMAPPED_EVENT = 'scan.write.voucher_method_unmapped';
// 券目录读不到（读表挂了 / 没配表 ID）⇒ 同样大声 warn（"读不到"与"没有券"是两件事 ✗）。
const VOUCHER_CATALOG_UNREADABLE_EVENT = 'scan.write.voucher_catalog_unreadable';
// 券方式读不到「收款方式管理」表 ⇒ 与既有那条读表失败的 warn 同一件事，用既有事件名 ✓。
const PAYMENT_METHODS_UNREADABLE_EVENT = 'scan.sale.payment_methods_unreadable';

// ── 开关与取值 ────────────────────────────────────────────────────────────────
const VOUCHER_PAYMENT_ENABLED_ENV_KEY = 'SCAN_VOUCHER_PAYMENT_ENABLED';
// 券方式**认不出那张券**时给她的那句人话（**拦住 + 一个字都不写**，绝不当普通收款记一笔 ✗）。
const VOUCHER_UNRESOLVED_TEXT_ENV_KEY = 'SCAN_VOUCHER_PAYMENT_UNRESOLVED_TEXT';
const DEFAULT_VOUCHER_UNRESOLVED_TEXT = '这张团购券没在「团购券管理」里找到（或券目录暂时读不到），'
  + '先别提交这一单：请核对收款方式与券目录，或改用其它收款方式。';

// 日志里的 `hint`（**用户可见中文只许在 config** ✗ 不许写进 service —— 有源码哨兵扫它 ✓）。
const VOUCHER_HINT_METHODS_UNREADABLE = '收款方式表读不到 ⇒ 认不出哪条是券；有金额空的行就拦住'
  + '（不静默当普通收款 / 不被整行丢掉）';
const VOUCHER_HINT_CATALOG_UNREADABLE = '券目录读不到 ⇒ 认不出面值/结算款 ⇒ 拦住这一单（不静默拿收款金额顶替）';
const VOUCHER_HINT_UNREACHABLE = '这些在售券没有任何收款方式关联 ⇒ 她在页面上点不到它（请到「收款方式管理」补关联）';
const VOUCHER_HINT_METHOD_UNMAPPED = '券方式在「团购券管理」里找不到对应那张券 ⇒ 拦住这一单（不静默当普通收款）';

/**
 * 一次把整份配置读出来。**用错一眼能看出来**：字段名 / 状态名 / 事件名都在这儿。
 */
const resolveVoucherPaymentConfig = (env = process.env) => ({
  // 这一刀显不显示（默认**开**：她 2026-10-16 已定案）。
  enabled: readFlag(env, VOUCHER_PAYMENT_ENABLED_ENV_KEY, true),
  paymentMethodTableKey: PAYMENT_METHOD_TABLE_KEY,
  voucherTableKey: VOUCHER_TABLE_KEY,
  voucherLinkFieldKey: VOUCHER_LINK_FIELD_KEY,
  // 真列名（取不到 = ''，调用方**不许**拿空列名去读表 —— 会读成"全体非券" ✗）
  voucherLinkField: voucherLinkFieldName(),
  voucherFields: voucherFieldNames(),
  // 收款明细那一笔的状态（**表里的取值**；钱还在平台上，不算"已收"）。
  pendingStatus: PENDING_SETTLEMENT_STATUS,
  // 券目录只取这一种「销售状态」的券（与 `LarkMvpService.listGroupBuyVouchers` / 9 点推送同一口径）。
  // ⚠️ 它只用来判"这张券**在不在售**"（下架的券没人点得到 = 正常 ✓）——
  //    **认券**一律按收款方式那条关联记录的 record_id 认（关联就是事实 ✓ 不看销售状态 ✗），
  //    否则一条陈旧的关联会因为她下架了券而把这一单**拦住** ✗。
  onSaleStatus: readString(env, VOUCHER_ON_SALE_STATUS_ENV_KEY, DEFAULT_ON_SALE_STATUS),
  // 认不出券时拦住她那句话（**用户可见中文只许在 config** ✗ 不许在逻辑里写）。
  unresolvedText: readString(env, VOUCHER_UNRESOLVED_TEXT_ENV_KEY, DEFAULT_VOUCHER_UNRESOLVED_TEXT),
  events: {
    methodUnmapped: VOUCHER_METHOD_UNMAPPED_EVENT,
    catalogUnreadable: VOUCHER_CATALOG_UNREADABLE_EVENT,
    paymentMethodsUnreadable: PAYMENT_METHODS_UNREADABLE_EVENT,
  },
  // 日志里那句 `hint`（同一件事的"人话"只有一份，service 里不写中文 ✗）。
  hints: {
    methodsUnreadable: VOUCHER_HINT_METHODS_UNREADABLE,
    catalogUnreadable: VOUCHER_HINT_CATALOG_UNREADABLE,
    unreachable: VOUCHER_HINT_UNREACHABLE,
    methodUnmapped: VOUCHER_HINT_METHOD_UNMAPPED,
  },
});

module.exports = {
  PAYMENT_METHOD_TABLE_KEY,
  VOUCHER_TABLE_KEY,
  VOUCHER_LINK_FIELD_KEY,
  VOUCHER_FIELDS,
  VOUCHER_METHOD_UNMAPPED_EVENT,
  VOUCHER_CATALOG_UNREADABLE_EVENT,
  VOUCHER_PAYMENT_ENABLED_ENV_KEY,
  VOUCHER_UNRESOLVED_TEXT_ENV_KEY,
  DEFAULT_VOUCHER_UNRESOLVED_TEXT,
  voucherLinkFieldName,
  voucherFieldNames,
  resolveVoucherPaymentConfig,
};
