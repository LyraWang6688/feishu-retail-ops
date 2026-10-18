'use strict';

/**
 * ⭐⭐ **成功页上那一行单号**（她 2026-10-16 23:5x 逐字「**那我肯定能看到这个单号呀**」✓）
 *
 * 🔴🔴 **本文件一律【走外层】`renderSaleSuccessPage`** ✗ —— 这一条是**被真事教训出来的** ✓：
 *   · 有一次这个坑**逃掉了** ✗：原先 4 条判据**直接调内层** `renderScanMessagePage` ✓ ⇒
 *     ⭐ **测不到"外层转发"这一环** ✗ ⇒ ⭐ **万一外层哪天不再 `...input` 展开 ⇒ 判据照样绿、而真机红** ✓
 *   · 真机的路（实测 ✓）：⭐ `routes:156` `renderSuccess = options.render?.success || renderSaleSuccessPage` ✓
 *     ⇒ ⭐ `views/scanPage/index.js:265` `renderSaleSuccessPage`（**外层** ✓ 它自己补 `tone:'success'` ✓）
 *     ⇒ ⭐ 它 `return renderScanMessagePage({ ...input, tone:'success', … }, config)`（**内层** ✓）
 *   ⇒ ⭐ ⭐ **所以判据必须从【外层】进** ✓（与上游夹具 `test/support/scanSuccessPage.js:88-92` **同一写法** ✓）
 *
 * 🔴 两条她定的边界（**同时**满足 ✓ 缺一不可）：
 *   ① ⭐ **看得到单号** ✓（AC-ON1 / AC-ON5 / AC-ON6）
 *   ② ⭐ **就一页、没有按钮没有链接、也不自动跳** ✓（AC-ON3，**无号/有号都要** ✓）
 *
 * ⚠️ 本文件**不碰** `scanSaleE2E.test.js`（⭐ 那两条 `AC-H1/H2` / `AC-H3` 归 ④ 那支复跑 ✓）。
 * ⚠️ "号为空时逐字节不变"由上游 `successPageZeroRegression.test.js` 的 `AC-REG1` 锁着 ✓（不重复钉 ✗）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
// ⭐ **外层**（= 真机走的那个 ✓ 与上游夹具同一写法 ✓）
const { renderSaleSuccessPage } = require(path.join(SERVER, 'src', 'views', 'scanPageRenderer'));
// ⭐ **内层**（只用于 AC-ON4 那条"只对成功页生效"的反向 ✓）
const { renderScanMessagePage } = require(path.join(SERVER, 'src', 'views', 'scanPage'));
const { SCAN_PAGE } = require(path.join(SERVER, 'src', 'config', 'scanPage'));
const { SCAN_SUCCESS_PAGE } = require(path.join(SERVER, 'src', 'config', 'scanSuccessPage'));

const NUMBER = 'XSD-20261016-0001';
/** 路由真实形状的 payload（⭐ 关键那一项就是 `order_no` ✓ 与 `routes:2732` 同形 ✓）。 */
const payload = (extra = {}) => ({ title: 'T', body: 'B', order_no: NUMBER, ...extra });
const outer = (extra = {}) => renderSaleSuccessPage(payload(extra), SCAN_PAGE);
const lineOf = (html) => (/<p class="foot" data-view="success-order-no">([^<]*)<\/p>/.exec(html) || [])[1] || '';

test('AC-ON1 ⭐ **正向（走外层 ✓）**：路由形状的 payload 带号 ⇒ 成功页看得到该号', () => {
  const html = outer();
  assert.equal(html.includes('data-view="success-order-no"'), true,
    '⭐ 那一行必须在 ✓（她 23:5x「那我肯定能看到这个单号呀」）');
  assert.equal(html.includes(NUMBER), true, '⭐ 页面上必须**看得到这个号** ✓');
  assert.equal(lineOf(html), `本单已提交（${NUMBER}）`,
    '⭐ 文案逐字 `上一单已提交（<单号>）` ✓（模板走 config ✓ `SCAN_SUCCESS_PAGE.orderNoText`）');
  assert.equal(html.includes('{orderNo}'), false, '⭐ 占位符必须被替换掉 ✗（不许把 `{orderNo}` 漏出去）');
});

test('AC-ON2 ⭐ **负向（走外层 ✓）**：号为空 ⇒ 整行不出现（不显示空括号 ✓）', () => {
  for (const extra of [{ order_no: '' }, { order_no: '   ' }, {}]) {
    const html = renderSaleSuccessPage({ title: 'T', body: 'B', ...extra }, SCAN_PAGE);
    assert.equal(html.includes('data-view="success-order-no"'), false,
      `⭐ 没有号（${JSON.stringify(extra)}）⇒ 整行不出现 ✓（不显示空括号 ✗）`);
    assert.equal(html.includes('上一单已提交'), false, '⭐ 连文案都不许出现 ✓');
  }
});

test('AC-ON3 ⭐⭐ **零链接零跳转（走外层 ✓ 无号/有号都要）**（她 23:5x「没有按钮没有链接、也不自动跳」）', () => {
  for (const [label, extra] of [['无号', { order_no: '' }], ['有号', { order_no: NUMBER }]]) {
    const html = renderSaleSuccessPage({ title: 'T', body: 'B', ...extra }, SCAN_PAGE);
    assert.equal(/href="\/(s|r)\//.test(html), false, `⭐ ${label}：不许有回跳链接 ✗（零链接 ✓）`);
    assert.equal(/<a\b/.test(html), false, `⭐ ${label}：一个 <a> 都不许有 ✗`);
    assert.equal(/<button\b/i.test(html), false, `⭐ ${label}：不许有按钮 ✗`);
    assert.equal(/<form\b/i.test(html), false, `⭐ ${label}：不许有表单 ✗`);
    assert.equal(/http-equiv="refresh"/i.test(html), false, `⭐ ${label}：**不许自动跳** ✗`);
    assert.equal(/setTimeout|location\.(href|replace)\s*=/.test(html), false, `⭐ ${label}：不许有自动跳转脚本 ✗`);
  }
});

test('AC-ON4 ⭐ **只对成功页生效**：非成功页（`tone` 不是 `success`）不许挂这一行 ✗', () => {
  // 这条**故意调内层** ✓ —— 因为"非成功页"就是绕开外层（外层一律补 `tone:'success'` ✓）
  const html = renderScanMessagePage({ title: 'T', body: 'B', order_no: NUMBER }, SCAN_PAGE);
  assert.equal(html.includes('data-view="success-order-no"'), false,
    '⭐ 非成功页不许出现那行 ✗（免得给别的结果页平白加东西 ✓）');
  assert.equal(SCAN_SUCCESS_PAGE.orderNoText.includes('{orderNo}'), true,
    '⭐ 配置模板必须**带占位符** ✓（这样才能拼出任意号 ✓）');
});

test('AC-ON5 ⭐⭐ **外层必须把 `order_no` 传下去**（钉 `...input` 展开这个机制本身 ✗）', () => {
  // 机制：⭐ `renderSaleSuccessPage` 用 `...input` 把整个 payload 展开给内层 ⇒ `order_no` 才能到内层 ✓
  //   ⇒ 谁把它改成"按名转发、漏掉 `order_no`" ⇒ 本用例必须红 ✓
  const withNo = renderSaleSuccessPage(payload(), SCAN_PAGE);
  assert.equal(withNo.includes(NUMBER), true,
    '⭐ 外层收到了 `order_no` ⇒ **必须原样传到内层** ✓（`...input` 展开这条机制不许被拆掉 ✗）');
  const other = 'XSD-20990101-0007';
  const withOther = renderSaleSuccessPage(payload({ order_no: other }), SCAN_PAGE);
  assert.equal(withOther.includes(other), true, '⭐ 换号 ⇒ 页面跟着换 ✓（不许写死 ✗）');
  assert.equal(withOther.includes(NUMBER), false, '⭐ 旧号不许残留 ✗');
});

test('AC-ON6 ⭐ **外层拿不到号时不许编**（没有就不显示 ✓ 她"没有就不编一个"口径 ✓）', () => {
  const html = renderSaleSuccessPage({ title: 'T', body: 'B' }, SCAN_PAGE);
  assert.equal(/XSD-/.test(html), false, '⭐ 没有号 ⇒ **不许编一个出来** ✗');
  assert.equal(html.includes('data-view="success-order-no"'), false, '⭐ 那行也不出现 ✓');
});
