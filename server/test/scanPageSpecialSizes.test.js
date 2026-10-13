/**
 * ⭐⭐ 2026-10-14 **改指向**（她拍板：「把采购明细给删除了，把特殊码给去掉吧」✗）：
 *   本文件原来钉的是"**特殊码接线**"（路由里那次 `purchaseSizeReader.listSizes()` 读 + 失败降级 warn）——
 *   那条接线**已整体删除** ✓ ⇒ 现在钉的是"**它确实没了**"（**不是放宽** ✓：仍是源码哨兵 ✓）。
 * ⚠️ 改前逐字（留档）：
 *   AC-SP1「降级接线在（源码哨兵）：读失败 ⇒ 只给默认范围 + 一条可 grep 的 warn」✓
 *   AC-SP2「读成功 ⇒ 只读一次、且**不许**报那条失败 warn」✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const stripped = (file) => fs.readFileSync(path.join(SERVER, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('AC-SP1 ⭐ 那条接线**已删**：路由代码里不再 require/使用 purchaseSizeReader（源码哨兵 ✓）', () => {
  const route = stripped('src/routes/scanPage.js');
  assert.equal(route.includes('purchaseSizeReader'), false, '不再 require / 不再调用 ✓');
  assert.equal(route.includes('present_special_sizes'), false, '不再往视图模型挂那个字段 ✓');
  assert.equal(route.includes('purchase_size_list_failed'), false, '那条失败 warn 也随之删除 ✓（读都没了 ⇒ 没有"读失败"✗）');
});

test('AC-SP2 ⭐ 那次读**不再可能发生**（没有任何调用点 ⇒ 省掉 ~1.7 秒 ✓）', () => {
  for (const file of ['src/routes/scanPage.js', 'src/services/scanPageService.js', 'src/views/scanPageRealm.js', 'src/views/scanPageRenderer.js']) {
    const code = stripped(file);
    assert.equal(/purchaseSizeReader|present_special_sizes/.test(code), false, `${file} 里不许再有那次读/那个字段 ✓`);
  }
  // 文件本身**保留**（她 2026-10-14：接线删、文件留 ✓）
  const reader = fs.readFileSync(path.join(SERVER, 'src/services/purchaseSizeReader.js'), 'utf8');
  assert.ok(reader.includes('当前无生产引用'), 'reader 文件保留 + 顶部注明现状 ✓');
});
