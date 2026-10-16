'use strict';

/**
 * ⭐⭐ **零回归：成功页开关【关着】⇒ 与改前【逐字节】一致（整页 sha256）**（2026-10-16 · **加固层**）。
 *
 * 背景（如实）：实现已随 **#770**（`062544d1`）落地；它自带的 AC-MS-P2 钉的是"关着时**形状**不变"（两次调用互相比较 ✓）。
 * 本文件把它升级成**能真红**的那一种：**同一条渲染路径渲出来的整页字节**，与
 * **动手之前（`origin/main 6ad32ea`）实测的那一个 sha256** 比 —— 差一个字节就红 ✓。
 *
 * 🔴 为什么单独一个文件、单独一个进程：开关在 `config/**` 的 **require 期**读 env
 *   ⇒ 一个进程里只能摆一种开关状态（本文件 = **关**；开着那半在 `test/successPageFourChains.test.js` ✓）。
 *
 * 🔴 台账（改前逐字 → 改后逐字 → 依据）：
 *   · 改前（`origin/main 6ad32ea`，实测）：`82858f52ac40fa4eb0588ad4b87167916b5959e3fcfa27ee0d3d89898a765772`（108,615 字节）
 *   · 改后（`origin/main ef45150d`，实测）：**同一个值** ✓（⇒ 判据不必迁移 ✓）
 *   · 依据：Lead 的口径「开关关着 ⇒ 与今天逐字节一致（整页 sha256）」
 *   ⚠️ 将来**合法**地改成功页 ⇒ 按 `docs/frozen-sha-pin-rule-2026-10-16.md` **成对迁移**这个常量（改前 sha → 改后 sha → 依据）✓
 *
 * 🔴 本文件**只动 `test/**`** ✗。
 */

// ⚠️ **刻意不设** `SCAN_SUCCESS_PAGE_MINIMAL_ENABLED`（缺省 = 关 ✓ —— 本文件就是要证"关着=今天"）
delete process.env.SCAN_SUCCESS_PAGE_MINIMAL_ENABLED;
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_success_zero_regression_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'success_zero_regression_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_SUCCESS_PAGE } = require('../src/config/scanSuccessPage');
const { renderChainSuccessPages, offendersOf } = require('./support/scanSuccessPage');

const SERVER_DIR = path.join(__dirname, '..');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** 改前（`origin/main` `6ad32ea`）三条链成功页全字节的 sha256 —— 见文件头台账 ✓。 */
const LEGACY_SHA256 = '82858f52ac40fa4eb0588ad4b87167916b5959e3fcfa27ee0d3d89898a765772';

/** 三条链（销售 / 补货 / 退货）渲染结果按**固定顺序**拼成一份字节流（判据 / 证据共用同一算法 ✓）。 */
const chainsBytes = (pages) => [pages.sale, pages.replenish, pages.purchaseReturn].join('');

test('AC-REG2 ⭐ 缺省 = **关**（没设 env ⇒ `minimalEnabled === false`）', () => {
  assert.equal(SCAN_SUCCESS_PAGE && typeof SCAN_SUCCESS_PAGE, 'object',
    '成功页开关要有**一处**配置（`config/scanSuccessPage.js` ✓）');
  assert.equal(SCAN_SUCCESS_PAGE.minimalEnabled, false,
    '缺省必须是 **false**（她的口径"缺省关"；显式 true 才变 ✓）');
});

test('AC-REG1 ⭐⭐ 开关关着 ⇒ 三条链成功页**与改前逐字节一致**（全字节 sha256 ✓）', () => {
  const pages = renderChainSuccessPages();
  const bytes = chainsBytes(pages);
  assert.equal(sha256(bytes), LEGACY_SHA256,
    '🔴 开关关着 ⇒ 成功页必须与改前**逐字节相同**（差一个字节 ⇒ 零回归破了 ✗）。'
    + `实际 sha256 = ${sha256(bytes)}（长度 ${Buffer.byteLength(bytes)} 字节）`);
  // ⭐ 同一件事的**可读**指纹（sha 红了的时候能一眼看出"是哪里回去了"）：
  for (const [chain, html] of Object.entries(pages)) {
    assert.match(html, /<a\s[^>]*href=/i, `${chain}：开关关着时，改前那颗回跳链接**照旧在** ✓（关着 = 今天）`);
  }
  assert.match(pages.sale, /http-equiv="refresh"/i, '销售那条：改前的**自动回跳**照旧在 ✓（关着 = 今天）');
  assert.ok(pages.sale.includes(SCAN_PAGE.successReturn.label),
    '销售那条：改前那句回跳文案照旧在 ✓（关着 = 今天）');
  assert.ok(pages.replenish.includes(SCAN_PAGE.saleSuccess.message)
    && pages.purchaseReturn.includes(SCAN_PAGE.saleSuccess.message),
  '补货 / 退货那条：改前**本来就是**统一那一句（本卡没动它们开着以外的行为 ✓）');
});

test('AC-REG3 ⭐ 探针：开关**开着** ⇒ 同一个 sha **必须不同** ＋ 零 offender（AC-REG1 不是空跑 ✓）', () => {
  const off = renderChainSuccessPages();
  // eslint-disable-next-line global-require
  const { renderScanMessagePage } = require('../src/views/scanPageRenderer');
  // 同一份"成功页入参"（含全部"要她跳走"的东西）：关 / 开各渲一次
  const payload = {
    title: 'T', body: 'B', tone: 'success', number: 'N', details: ['D'], retryHint: 'H',
    backPath: '/s/a', backLabel: '再录一单', returnPath: '/s/b', returnLabel: '返回扫码',
    autoReturnUrl: '/s/c', returnDelaySeconds: 2, extraActionsHtml: '<button>追加</button>',
  };
  const offHtml = renderScanMessagePage(payload, SCAN_PAGE);
  const onHtml = renderScanMessagePage({
    ...payload,
    successPage: { minimalEnabled: true, minimalText: SCAN_SUCCESS_PAGE.minimalText },
  }, SCAN_PAGE);
  assert.notEqual(sha256(onHtml), sha256(offHtml), '开关开着必须**真的**改变成功页（否则是假开关 ✗）');
  assert.deepEqual(offendersOf(onHtml), [], '开关开着 ⇒ 零 a-href/按钮/表单/自动跳转 ✓');
  assert.ok(onHtml.includes(SCAN_SUCCESS_PAGE.minimalText), '开关开着 ⇒ 统一那一句 ✓');
  assert.notDeepEqual(offendersOf(offHtml), [], '开关关着 ⇒ 今天那几样"要她跳走"的东西还在 ✓');
  for (const [chain, html] of Object.entries(off)) {
    assert.notDeepEqual(offendersOf(html), [], `${chain}：开关关着 ⇒ 今天那几样"要她跳走"的东西还在 ✓`);
  }
});

test('AC-REG4 ⭐ 回跳配置**没有被删**（本卡只改"成功页渲不渲染它" ✗ 不顺手删配置）', () => {
  assert.equal(SCAN_PAGE.successReturn && SCAN_PAGE.successReturn.enabled, true,
    '`successReturn` 照旧（删了 = 越界 ✗ —— 那一刀要单独评估）');
  assert.equal(typeof SCAN_PAGE.successReturn.delaySeconds, 'number', '回跳延迟照旧在配置里 ✓');
  const cfgSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'config', 'scanPage.js'), 'utf8');
  assert.match(cfgSrc, /const SUCCESS_RETURN = Object\.freeze\(/,
    '配置块本身照旧（本卡**加**一个开关，**不改**既有件 ✓）');
});
