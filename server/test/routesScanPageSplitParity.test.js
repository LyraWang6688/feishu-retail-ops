'use strict';


/**
 * ⭐⭐ `routes/scanPage.js` 拆分（阶段二）的**搬运保真**哨兵。
 *
 * 本刀的口径 = 「**纯搬运 · 一个字节的行为都不许变**」⇒ 两件事必须**可被机器证明**：
 *
 *   **AC-SP-R1（薄壳）**：`routes/scanPage.js` 只剩转发（行数 ≤ 20 ✓ 且 `require('./scanPage/index')` ✓
 *     且**不含**任何业务代码 ⇒ 谁把逻辑塞回壳里 ⇒ 红 ✓）。
 *   **AC-SP-R2（函数体：逐字 + sha 基线 + 恰好一次 + index 里不出现）** ⭐ 第 2 轮**新口径**（Lead 批 ✓）：
 *     第 1 轮的"聚合 == 原文"只在**整块拼接**下成立 ✓；第 2 轮搬闭包函数/分支时 index 里会留**调用行** ✗
 *     ⇒ 聚合不可能再等于原文 ✗ ⇒ 改成**逐个函数体钉 sha** ✓（登记表见 `test/support/scanPageMovedBodies.js` ✓）。
 *   **AC-SP-R5（聚合文本必须能过语法解析）** ⭐⭐ 2026-10-16 加（Lead 批 ✓）：
 *     **有一批用例会把读到的源码拿去 require/eval** ✗ ⇒ 若聚合不是**合法 JS**（例：重复声明 ✗）
 *     它们会**整片崩**（那次的现场：**31 红 ＋ 用例数 2899 → 2579** ✗）⇒ 本判据用
 *     `new vm.Script(聚合)` **只解析、不执行** ✓ ⇒ **秒级**就能拦住它 ✗（不必等 48 分钟全量 ✓）。
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

test('AC-SP-R2 ⭐⭐ 被搬走的函数体：逐字（sha 基线）＋ 恰好一次 ＋ index 里不出现', () => {
  const { MOVED_BODIES, checkMovedBodies } = require('./support/scanPageMovedBodies');
  assert.ok(MOVED_BODIES.length > 0, '登记表不许为空 ✗');
  const bad = checkMovedBodies().filter((row) => !row.ok);
  assert.deepEqual(bad, [], '有函数体不符（' + bad.length + ' 条）：' + String.fromCharCode(10)
    + bad.map((r) => '· ' + r.name + '（基线 ' + r.baseline + '）⇒ ' + r.why).join(String.fromCharCode(10)));
});
test('AC-SP-R3 ⭐ 导出符号原样（7 个 · 一个不换）', () => {
  // ⚠️ 读**真身 index.js**（聚合里每个子文件都有自己的 `module.exports` ✗ 用 lastIndexOf 会切错 ✓）
  const realIndex = require('node:fs').readFileSync(
    require('./support/scanPageSource').SCAN_PAGE_DIR + '/index.js', 'utf8',
  );
  const source = realIndex;
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

test('AC-SP-R5 ⭐⭐ 聚合文本必须能通过**语法解析**（有一批用例会把它拿去 require/eval ✗）', () => {
  const vm = require('node:vm');
  const { scanPageSource } = require('./support/scanPageSource');
  const aggregate = scanPageSource();
  // ⭐ **只解析、不执行** ✓（不跑它 ⇒ 不会碰 env / 不会发请求 ✓）
  assert.doesNotThrow(() => new vm.Script(aggregate, { filename: 'scanPage-aggregate.js' }),
    '聚合文本不是**合法 JS** ✗ —— 典型原因：切片与 index 里有**重复声明**（SyntaaxError: Identifier … has already been declared ✗）'
    + String.fromCharCode(10) + '⇒ 处置见 test/support/scanPageSource.js 文件头（去掉切片里的冗余 require 声明 ＋ module.exports ✓）');
  // ⭐ 反向钉住：聚合里**只许有一处** `const asList`（重复声明正是上次崩的根因 ✗）
  const occurrences = (aggregate.match(/const asList\s*=/g) || []).length;
  assert.equal(occurrences, 1, '`const asList` 在聚合里只能出现 1 次（当前 ' + occurrences + ' 次 ✗）');
});
