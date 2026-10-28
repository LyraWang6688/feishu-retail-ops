'use strict';
/**
 * ⭐⭐ 2026-10-28「尺码范围口径收口」的**单一来源哨兵**。
 *
 * 背景：女士尺码在历史上改过三次（36–42 → 36–41 → **36–40 + 41 特殊码**），
 *   旧 helper（`normalScopeOf` / `loadSizeScope` / `missingSizes` / `displaySizes`）
 *   与旧注释/旧文档并存，读代码时容易误判“到底哪个是普通码、哪个参与缺码”。
 *
 * 本文件钉住三件事（**只看代码，注释不算**）：
 *   ① 旧 helper 不得回到源码（定义、调用、导出都不许）；
 *   ② 现行配置只有一份：`config/scanPage.js` 的 `SIZE_SEGMENTS.ranges`；
 *   ③ 运行时 helper 读到的值与配置一致：
 *      `scanStockPolicy.specialSizesOf('B')` / `enterableScopeOf('B')` / `normalSizesOf('B')`。
 *
 * ⚠️ 只读源码 + 纯函数，不读表、不写表。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 剥掉 JS 注释（注释里允许写沿革；能力判断只看代码）。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const SOURCE_FILES = [
  'src/config/scanPage.js',
  'src/config/scanStockPolicy.js',
  'src/services/scanPageService.js',
  'src/views/scanPageRealm.js',
];

test('AC-SR1 ⭐ 旧 helper 不得回到源码（定义 / 调用 / 导出）', () => {
  const removed = ['normalScopeOf', 'loadSizeScope', 'missingSizes', 'displaySizes'];
  for (const file of SOURCE_FILES) {
    const code = stripComments(read(file));
    for (const name of removed) {
      assert.equal(code.includes(name), false,
        `${file} 的代码里仍出现旧 helper \`${name}\` ⇒ 与现行口径并存，必须删干净 ✗`);
    }
  }
  // 配置模块不再导出旧 helper
  // eslint-disable-next-line global-require
  const config = require('../src/config/scanPage');
  assert.equal(config.missingSizes, undefined, '`missingSizes` 不许再导出');
  assert.equal(config.displaySizes, undefined, '`displaySizes` 不许再导出');
});

test('AC-SR2 ⭐⭐ 现行配置只有一份：女 36–40 普通 / 34,35,41,42,43 特殊 / 34–43 可录', () => {
  // eslint-disable-next-line global-require
  const { SCAN_PAGE } = require('../src/config/scanPage');
  const ranges = SCAN_PAGE.sizeSegments.ranges;
  assert.deepEqual(ranges.B.normal, [36, 40], '女普通码 = 36–40');
  assert.deepEqual(ranges.B.special, [34, 35, 41, 42, 43], '女特殊码 = 34/35/41/42/43');
  assert.deepEqual(ranges.B.enterable, [34, 43], '女可录范围 = 34–43');
  assert.deepEqual(ranges.A.normal, [38, 44], '男普通码 = 38–44');
  assert.deepEqual(ranges.A.special, [45, 46, 47, 48], '男特殊码 = 45–48');
  assert.deepEqual(ranges.A.enterable, [38, 48], '男可录范围 = 38–48');
});

test('AC-SR3 ⭐⭐ 运行时 helper 读到的值与配置一致（不另写第二份数字）', () => {
  // eslint-disable-next-line global-require
  const stock = require('../src/config/scanStockPolicy');
  assert.deepEqual(stock.normalSizesOf('B'), [36, 37, 38, 39, 40], '女普通码 helper = 36–40');
  assert.deepEqual(stock.specialSizesOf('B'), [34, 35, 41, 42, 43], '女特殊码 helper = 34/35/41/42/43');
  assert.deepEqual(stock.enterableSizesOf('B'), [34, 35, 36, 37, 38, 39, 40, 41, 42, 43], '女可录 helper = 34–43');
  // eslint-disable-next-line global-require
  const { enterableScopeOf } = require('../src/services/scanPageService');
  assert.deepEqual(enterableScopeOf('B').sizes, [34, 35, 36, 37, 38, 39, 40, 41, 42, 43],
    '缺货基准 helper = 可录范围 34–43');
});

test('AC-SR4 ⭐ 展示层的特殊码折叠读的是同一份配置（不是第二份清单）', () => {
  const realm = stripComments(read('src/views/scanPageRealm.js'));
  assert.match(realm, /specialSizesOf\(categoryCode\)/, '折叠判定必须走 `specialSizesOf(categoryCode)`');
  assert.equal(/\[34,\s*35,\s*42,\s*43\]/.test(realm), false, '源码里不许再出现旧的离散清单字面量 ✗');
});
