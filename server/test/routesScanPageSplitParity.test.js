'use strict';


/**
 * ⭐⭐ `routes/scanPage.js` 拆分（阶段二）的**搬运保真**哨兵。
 *
 * 本刀的口径 = 「**纯搬运 · 一个字节的行为都不许变**」⇒ 两件事必须**可被机器证明**：
 *
 *   **AC-SP-R1（薄壳）**：`routes/scanPage.js` 只剩转发（行数 ≤ 20 ✓ 且 `require('./scanPage/index')` ✓
 *     且**不含**任何业务代码 ⇒ 谁把逻辑塞回壳里 ⇒ 红 ✓）。
 *   **AC-SP-R2（源码聚合 = 原文）**：把拆开的块按**原文顺序**拼回、并把 `require` 前缀反向 ⇒
 *     与 `3d97bfa:server/src/routes/scanPage.js` **逐字节相同**（sha256 基线写死在下面 ✓）
 *     ⇒ 那几十条"读源码"的判据照旧成立 ✓ 也保证搬运**没夹带**（少一行注释 / 改一个空格 ⇒ 红 ✓）。
 *   **AC-SP-R3（导出符号原样）**：`module.exports` 的 **7 个**符号一个不换 ✓（75 个测试 + `app.js` 零改动 ✓）。
 *   **AC-SP-R4（路由注册顺序）**：六个注册**相对顺序**不变 ✓（Express 先匹配先处理 ⇒ 顺序 = 语义 ✗）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { scanPageSource, SHELL, SHELL_MAX_LINES } = require('./support/scanPageSource');
const { readRealSync } = require('./support/scanPageReadRedirect');   // ⭐ 读**真壳**（绕过重定向 ✓）

/** ⭐ 基线：`git show 3d97bfa:server/src/routes/scanPage.js | shasum -a 256`（拆之前那一份 ✓ 不许改 ✗）。 */
const ORIGINAL_SHA256 = '74cc86d900ab93831723c29c5e195c5e8324804305240504dcf60d367281c285';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('AC-SP-R1 ⭐ 薄壳：`routes/scanPage.js` 只转发（≤20 行 · require ./scanPage/index · 无业务代码）', () => {
  const shell = readRealSync(SHELL, 'utf8');   // ⚠️ 必须读**真壳** ✗（重定向会把聚合文本给它 ⇒ 本判据失效 ✓）
  const lines = shell.split('\n').length;
  assert.ok(lines <= SHELL_MAX_LINES, `壳必须很薄（当前 ${lines} 行 ≤ ${SHELL_MAX_LINES} ✓）`);
  assert.match(shell, /require\('\.\/scanPage\/index'\)/, '壳必须**显式**转发到 ./scanPage/index ✓（写 ./scanPage 会自命中 ⇒ 循环 require ✗）');
  assert.equal(/\brouter\.(get|post)\(/.test(shell), false, '壳里**不许**出现任何路由注册 ✗');
  assert.equal(/function\s+\w+\s*\(/.test(shell), false, '壳里**不许**出现任何函数定义 ✗');
});

test('AC-SP-R2 ⭐⭐ 源码聚合 = 拆之前那一份（逐字节 · sha256 基线）', () => {
  const aggregate = scanPageSource();
  assert.equal(sha256(aggregate), ORIGINAL_SHA256,
    '聚合文本与 `3d97bfa:server/src/routes/scanPage.js` 必须**逐字节相同** ✗'
    + '（少一行 / 多一个空格 / 块顺序错 ⇒ 这条红 ✓）');
});

test('AC-SP-R3 ⭐ 导出符号原样（7 个 · 一个不换）', () => {
  const source = scanPageSource();
  const tail = source.slice(source.lastIndexOf('module.exports'));
  for (const name of ['createScanPageRouter', 'isDataNotReady', 'parseReplenishEntries',
    'parseReturnEntries', 'parsePaymentRows', 'parseMultiItemGroups', 'mergeFirstItemEntries']) {
    assert.ok(tail.includes(name), `导出符号 ${name} 必须在 ✓（75 个测试 + app.js 都按它 require ✓）`);
  }
});

test('AC-SP-R4 ⭐ 路由注册顺序不变（六个注册的相对顺序 = 原文顺序）', () => {
  const source = scanPageSource();
  const order = [
    "router.get('/',",
    'router.post(config.tapFeedback?.reportPath',
    'router.get(realmScanSignaturePath',
    'router.post(realmScanSignaturePath.replace(',
    'router.get(ROUTE_PATTERNS',
    'router.post(ROUTE_PATTERNS',
    "router.post('/',",
  ];
  let at = -1;
  for (const frag of order) {
    const found = source.indexOf(frag, at + 1);
    assert.ok(found > at, `注册顺序错了 ✗：\`${frag}\` 必须出现在 \`${order[order.indexOf(frag) - 1] || '(开头)'}\` 之后 ✓`);
    at = found;
  }
});
