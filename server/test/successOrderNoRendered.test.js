'use strict';

/**
 * ⭐⭐ **成功页上那一行单号**（她 2026-10-16 23:5x 逐字「**那我肯定能看到这个单号呀**」✓）
 *
 * 背景（一条链路，两处，一处都不许少 ✗）：
 *   · 路由侧 ⭐ `routes/scanPage/index.js:2732` `order_no: skippedOrderNo` ✓ ⇒ 号**早就在 payload 里** ✓
 *   · 视图侧 ⭐ `views/scanPage/index.js` 的 `renderScanMessagePage` **参数表原来没有 `order_no`** ✗
 *     ⇒ ⭐ **号被"按名解构"静默丢掉** ✗（这才是"零消费者"的真正形状 ✓）⇒ 页面 `''` ✓
 *   · 现在：⭐ **收下 `order_no`** ✓ ＋ ⭐ **在极简覆盖【之外】渲染一行纯文案** ✓
 *     （⭐ 覆盖之内会被 `minimalSuccessOverrides` 吃掉 ✗ —— 实测 ✓）
 *
 * 🔴 两条她定的边界（**同时**满足 ✓ 缺一不可）：
 *   ① ⭐ **看得到单号** ✓（下面前两个用例）
 *   ② ⭐ **就一页、没有按钮没有链接、也不自动跳** ✓（第三个用例：**零链接零跳转** ✓）
 *
 * ⚠️ 本文件**不碰** `scanSaleE2E.test.js`（⭐ 那两条 `AC-H1/H2` / `AC-H3` 归 ④ 那支复跑 ✓）。
 * ⚠️ "号为空时逐字节不变"由上游 `successPageZeroRegression.test.js` 的 `AC-REG1` 锁着 ✓（不重复钉 ✗）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const { renderScanMessagePage } = require(path.join(SERVER, 'src', 'views', 'scanPage'));
const { SCAN_PAGE } = require(path.join(SERVER, 'src', 'config', 'scanPage'));
const { SCAN_SUCCESS_PAGE } = require(path.join(SERVER, 'src', 'config', 'scanSuccessPage'));

const NUMBER = 'XSD-20261016-0001';
const BASE = { title: 'T', body: 'B', tone: 'success' };
const render = (extra = {}) => renderScanMessagePage({ ...BASE, ...extra }, SCAN_PAGE);
const lineOf = (html) => (/<p class="foot" data-view="success-order-no">([^<]*)<\/p>/.exec(html) || [])[1] || '';

test('AC-ON1 ⭐ **正向**：号非空 ⇒ 成功页出现该号（纯文案 ✓ 锚点 `data-view="success-order-no"`）', () => {
  const html = render({ order_no: NUMBER });
  assert.equal(html.includes('data-view="success-order-no"'), true, '⭐ 那一行必须在 ✓（她 23:5x「那我肯定能看到这个单号呀」）');
  assert.equal(html.includes(NUMBER), true, '⭐ 页面上必须**看得到这个号** ✓');
  assert.equal(lineOf(html), `上一单已提交（${NUMBER}）`,
    '⭐ 文案逐字：`上一单已提交（<单号>）` ✓（模板走 config ✓ `SCAN_SUCCESS_PAGE.orderNoText`）');
  // ⭐ 号来自模板占位符 ⇒ 模板里那个占位**不许原样漏到页面上** ✗
  assert.equal(html.includes('{orderNo}'), false, '⭐ 占位符必须被替换掉 ✗（不许把 `{orderNo}` 漏出去）');
});

test('AC-ON2 ⭐ **负向**：号为空 ⇒ **整行不出现**（不显示空括号 ✓）', () => {
  const html = render({});
  assert.equal(html.includes('data-view="success-order-no"'), false,
    '⭐ 没有号 ⇒ **整行不出现** ✓（不显示空括号 ✗）');
  assert.equal(html.includes('上一单已提交'), false, '⭐ 连文案都不许出现 ✓');
  assert.equal(render({ order_no: '   ' }).includes('data-view="success-order-no"'), false,
    '⭐ 只有空白也算空 ✓（trim 之后判 ✓）');
});

test('AC-ON3 ⭐⭐ **零链接零跳转**（她 23:5x「没有按钮没有链接、也不自动跳」✓）—— 无号/有号**都要** ✓', () => {
  for (const [label, extra] of [['无号', {}], ['有号', { order_no: NUMBER }]]) {
    const html = render(extra);
    assert.equal(/href="\/(s|r)\//.test(html), false, `⭐ ${label}：成功页**不许有回跳链接** ✗（零链接 ✓）`);
    assert.equal(/<a\b/.test(html), false, `⭐ ${label}：成功页**一个 <a> 都不许有** ✗`);
    assert.equal(/<button\b/i.test(html), false, `⭐ ${label}：不许有按钮 ✗`);
    assert.equal(/<form\b/i.test(html), false, `⭐ ${label}：不许有表单 ✗`);
    assert.equal(/http-equiv="refresh"/i.test(html), false, `⭐ ${label}：**不许自动跳** ✗（她 23:5x「也不自动跳」✓）`);
    assert.equal(/setTimeout|location\.(href|replace)\s*=/.test(html), false, `⭐ ${label}：不许有自动跳转脚本 ✗`);
  }
});

test('AC-ON4 ⭐ **只对成功页生效**：非成功页（`tone` 不是 `success`）**不许挂这一行** ✗', () => {
  const html = renderScanMessagePage({ title: 'T', body: 'B', order_no: NUMBER }, SCAN_PAGE);
  assert.equal(html.includes('data-view="success-order-no"'), false,
    '⭐ 非成功页不许出现那行 ✗（免得给别的结果页平白加东西 ✓）');
  assert.equal(SCAN_SUCCESS_PAGE.orderNoText.includes('{orderNo}'), true,
    '⭐ 配置模板必须**带占位符** ✓（这样才能拼出任意号 ✓）');
});
