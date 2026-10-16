'use strict';

/**
 * ⭐⭐ **四条链「提交成功页」的判据共用件**（2026-10-16）——
 *   把"她提交之后看到的那一页"按**路由真实 payload 形状**造出来，供：
 *     · `test/successPageMinimal.test.js`（开关开着 ⇒ 统一极简 · 判据）
 *     · `test/successPageZeroRegression.test.js`（开关关着 ⇒ 与今天逐字节一致 · 判据）
 *     · 证据脚本（改前 / 改后各渲一遍，比 sha256）共用 ✓
 *
 * 🔴 **形状只有一个来源**：下面每个 builder 的字段都逐字抄自**路由那个调用点**
 *   （`routes/scanPage/index.js` 的 `sendSuccess(...)` payload），行号写在每段注释里 ✓；
 *   路由改了形状 ⇒ 这里**必须成对迁移**（否则判据测的就不是她真看到的那一页 ✗）。
 *
 * ⚠️ 本文件**不写死任何用户可见文案**：所有文案都从 `config/**` 取（`SCAN_PAGE` / `SCAN_WRITE`）✓
 */

/** 判据用的货号（与 `test/purchaseAsyncAcceptance.test.js` 等既有用例同一个 ✓）。 */
const NUMBER = 'YD6693-2|黑色|A';
/** 判据用的销售单号（路由那条路会给真号；这里是**已经拿到手**的那个 ✓ 不编格式 ✗）。 */
const ORDER_NO = 'XSD-20261016-0001';

/** `/s/<编号>` 这一段（与路由 `scanTargetOf` 同口径：编号原样 encode ✓）。 */
const encodePath = (number) => encodeURIComponent(String(number));

/** `config/scanWrite.js` 的 `{name}` 占位替换（与 `fillWriteText` 逐字同形 ✓）。 */
const fill = (template, values = {}, missing = '') => String(template ?? '')
  .replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? missing : String(value);
  });

/**
 * ⭐ 路由里的 `successReturnFields(req, target, noticeNo)`（`routes/scanPage/index.js:1156`）——
 *   返回的就是那四个"要她跳走"的字段（`returnPath` / `returnLabel` / `returnDelaySeconds` / `autoReturnUrl`）。
 *   🔴 本判据要钉的正是**这四个字段在成功页上不再产生任何东西** ✗。
 */
const successReturnFields = (SCAN_PAGE, noticeNo = '') => {
  const cfg = SCAN_PAGE.successReturn || {};
  const base = `/s/${encodePath(NUMBER)}?from=${cfg.homeRealm || 'sales'}`;
  const homePath = String(noticeNo || '').trim()
    ? `${base}&${encodeURIComponent(cfg.noticeKey || 'done')}=${encodeURIComponent(String(noticeNo).trim())}`
    : base;
  return {
    returnPath: homePath,
    returnLabel: cfg.label || '',
    returnDelaySeconds: Number(cfg.delaySeconds) || 0,
    autoReturnUrl: homePath,
  };
};

/**
 * ⭐ **销售**那条成功页的 payload —— 逐字抄自 `routes/scanPage/index.js:3011`（跳过付款那条）
 *   （提交那条 `:3366` 与它**逐字同形**，只差 `retryHint`，同样含 `backPath/backLabel`）。
 */
const saleSuccessPayload = (SCAN_PAGE, SCAN_WRITE) => {
  const t = SCAN_WRITE.texts;
  return {
    ...successReturnFields(SCAN_PAGE, ORDER_NO),
    title: t.submittedTitle,
    body: fill(t.submittedBody, { orderNo: ORDER_NO, count: 2 }),
    order_no: ORDER_NO,
    details: [fill(t.submittedOrderLine, { orderNo: ORDER_NO }), fill(t.submittedDetailLine, { count: 2 })],
    retryHint: t.submittedNextHint,
    requestId: 'req-success-sale',
    backPath: `/s/${encodePath(NUMBER)}?from=sales`,
    backLabel: t.submittedRecordAnother,
    backHint: t.submittedRecordAnotherHint,
  };
};

/**
 * ⭐ **补货 / 退货**那条成功页的 payload —— 逐字抄自 `routes/scanPage/index.js:3483` 与 `:3580`
 *   （两条**同形**：只有 `requestId` ＋ 那四个回跳字段 ⇒ 标题 / 正文走 `config.saleSuccess` 的缺省 ✓）。
 */
const purchaseSuccessPayload = (SCAN_PAGE, requestId) => ({
  ...successReturnFields(SCAN_PAGE, ''),
  requestId,
});

/** 三条【扫码页】链路各渲一遍（`renderSaleSuccessPage` = 成功页**唯一**渲染入口 ✓）。 */
const renderChainSuccessPages = () => {
  // ⚠️ 懒 require：调用方要先把自己那份 env（开关）摆好，再进来 ✓（配置在 require 期读 env ✗）
  // eslint-disable-next-line global-require
  const { SCAN_PAGE } = require('../../src/config/scanPage');
  // eslint-disable-next-line global-require
  const { SCAN_WRITE } = require('../../src/config/scanWrite');
  // eslint-disable-next-line global-require
  const { renderSaleSuccessPage } = require('../../src/views/scanPageRenderer');
  return {
    sale: renderSaleSuccessPage(saleSuccessPayload(SCAN_PAGE, SCAN_WRITE), SCAN_PAGE),
    replenish: renderSaleSuccessPage(purchaseSuccessPayload(SCAN_PAGE, 'req-success-replenish'), SCAN_PAGE),
    purchaseReturn: renderSaleSuccessPage(purchaseSuccessPayload(SCAN_PAGE, 'req-success-return'), SCAN_PAGE),
  };
};

/**
 * ⭐ 「要她跳走」的东西（她的口径：成功页上**一个都不许有** ✗）：
 *   `<a href>` / `<button>` / `<form>` / **自动跳转**（`<meta http-equiv="refresh">`）。
 *   ⚠️ `<form>` 也算：她口径里的"链接"是"**能点的、会把她带到别处的东西**"——
 *     一颗 form 按钮就是那个东西 ✗（`skipPathsMinimal.test.js` 的检测器同口径 ✓）。
 */
const OFFENDERS = Object.freeze([
  ['a-href', /<a\s[^>]*href=/i],
  ['button', /<button\b/i],
  ['form', /<form\b/i],
  ['auto-jump', /<meta[^>]*http-equiv=["']?refresh/i],
]);

/** 一页 HTML 里还剩哪些"要她跳走"的东西（空数组 = 干净 ✓）。 */
const offendersOf = (html) => OFFENDERS
  .filter(([, pattern]) => pattern.test(String(html ?? '')))
  .map(([name]) => name);

module.exports = {
  NUMBER,
  ORDER_NO,
  encodePath,
  fill,
  successReturnFields,
  saleSuccessPayload,
  purchaseSuccessPayload,
  renderChainSuccessPages,
  offendersOf,
  OFFENDERS,
};
