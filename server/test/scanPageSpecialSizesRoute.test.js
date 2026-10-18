require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ 2026-10-14 **改指向**（她拍板：「把采购明细给删除了，把特殊码给去掉吧」✗）：
 *   本文件原来钉的是"路由里那次特殊码接线 + 读失败降级"✗ —— 那条接线**已整体删除** ✓。
 *   现在钉：**路由不再做那次读**（省 ~1.7 秒 ✓），且**页面照常**（缺码只按默认段 ✓ 不白屏 ✓）。
 * ⚠️ 改前逐字（留档）：AC-SP1「降级接线在（源码哨兵）：读失败 ⇒ 只给默认范围 + 一条可 grep 的 warn」
 *                    AC-SP2「读成功 ⇒ 只读一次、且**不许**报那条失败 warn」
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const stripped = (file) => fs.readFileSync(path.join(SERVER, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('AC-SPR1 ⭐ 路由：不再有任何"采购明细 / 特殊码"接线（删之前这条必红 ✓ 能真红）', () => {
  const route = stripped('src/routes/scanPage.js');
  for (const gone of ['purchaseSizeReader', 'present_special_sizes', 'purchase_size_list_failed']) {
    assert.equal(route.includes(gone), false, `routes/scanPage.js 的**代码**里不该再有 ${gone} ✓`);
  }
});

test('AC-SPR2 ⭐ 路由仍走既有 lookup；缺码只按默认段（A 38–44 · B 36–41 ✓ 页面照常）', () => {
  const route = stripped('src/routes/scanPage.js');
  assert.ok(route.includes('service.lookup('), '仍然调既有 lookup ✓（页面还是那一款 ✓）');
  const { SCAN_PAGE } = require('../src/config/scanPage');
  assert.deepEqual(SCAN_PAGE.sizeSegments.ranges.A.default, [38, 44], 'A 38–44 ✓');
  assert.deepEqual(SCAN_PAGE.sizeSegments.ranges.B.default, [36, 41], 'B 36–41（她 2026-10-14 明确 ✓）');
  // ⭐ 2026-10-18：业务负责人确认删除该无引用文件（不再"文件留"）。
  assert.equal(fs.existsSync(path.join(SERVER, 'src/services/purchaseSizeReader.js')), false,
    'purchaseSizeReader.js 应已删除');
});
