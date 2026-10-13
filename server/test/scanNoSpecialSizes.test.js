/**
 * ⭐⭐ 她 2026-10-14 拍板：「**我们把采购明细给删除了，我们把特殊码给去掉吧**」
 *   ＋「**其他码如果有，就写，没有不做缺码范围**」⇒ 扫码页**不再读采购明细**（省那 1.7 秒 ✓）。
 * ⚠️ 本文件**先写先红**：删之前，这几条必红（`purchaseSizeReader` / `present_special_sizes` 还在 ✓）。
 * ⚠️ 只判**代码**（注释里解释历史用词不算 ✗ —— 我今晚在这上面翻过车 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const stripped = (file) => {
  const s = fs.readFileSync(path.join(SERVER, file), 'utf8');
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
};

test('AC-NS1 ⭐⭐ 扫码页这条链**不再读采购明细 / 不再有特殊码字段**（源码哨兵 · 能真红）', () => {
  for (const file of ['src/routes/scanPage.js', 'src/views/scanPageRealm.js', 'src/views/scanPageRenderer.js', 'src/config/scanPage.js']) {
    const code = stripped(file);
    for (const gone of ['purchaseSizeReader', 'present_special_sizes', 'specialSizeSetOf', 'presentSpecialSizeSet']) {
      assert.equal(code.includes(gone), false, `${file} 的**代码**里不该再有 ${gone}（她已裁定删掉 ✗）`);
    }
  }
});

test('AC-NS2 ⭐ 缺码只按**默认范围**判：A 38–45 · B **36–41**（逐档参数化 ✓）', () => {
  // eslint-disable-next-line global-require
  const { SCAN_PAGE } = require('../src/config/scanPage');
  const ranges = SCAN_PAGE.sizeSegments.ranges;
  assert.deepEqual(ranges.A.default, [38, 45], 'A（男）默认段 38–45 ✓');
  assert.deepEqual(ranges.B.default, [36, 41], 'B（女）默认段 **36–41**（她 2026-10-14 晚明确 ✓）');
});

test('AC-NS3 ⭐⭐ 其他码：**库存里有的就显示**（不算特殊码 ✗）；没有的不显示、也不计缺码', () => {
  // eslint-disable-next-line global-require
  const { saleSizeGroups } = require('../src/views/scanPageRealm');
  const VIEW = {
    number: 'MK31-1|咖色|B', // B = 女：43 在旧口径里是"特殊码"✗ ⇒ 新口径只要库存里有就要显示 ✓
    rows: [
      { size_text: '36', cells: [{ count: 1 }], total: 1 },   // 有货 ⇒ 现货
      { size_text: '43', cells: [{ count: 2 }], total: 2 },   // 老"特殊码"，但**库存里有** ⇒ 显示 ✓
      { size_text: '40', cells: [{ count: 0 }], total: 0 },   // 库存快照里有这一行（该款有的码）⇒ 显示、可预订 ✓
    ],
  };
  const groups = saleSizeGroups(VIEW);
  const texts = [...groups.inStock, ...groups.prepaid].map((item) => String(item.size_text));
  assert.ok(texts.includes('43'), '⭐ 库存里有的 43 必须显示（特殊码不再是"要采购明细出现过"✗）');
  assert.ok(texts.includes('36'), '有货的 36 显示在现货组 ✓');
  assert.ok(!texts.includes('38'), '库存里**没有**的码不显示 ✓（也不计缺码 ✓）');
});

test('AC-NS4 ⭐ 现货/预订分组**照旧**（仍按可售状态分组、仍只吃实时库存 rows ✓ 回归）', () => {
  // ⚠️ 我第一版用自造夹具去断言分组，夹具形状不对 ⇒ 改成**源码级**回归（分组的实现没动 ✓）
  const code = stripped('src/views/scanPageRealm.js');
  assert.match(code, /const SELLABLE_STATES = Object\.freeze\(\['门盒', '样品'\]\)/, '可售状态定义没动 ✓');
  // 2026-10-14：分组口径搬进 `config/scanPage.js`（配置先行）⇒ 签名多了可注入的 `behavior`；
  //   这条**不放宽**：既钉"函数还在 + 签名形状"，也钉"仍按可售数量分组、仍分两组" ✓
  assert.match(code, /const saleSizeGroups = \(view, behavior = SCAN_PAGE\.REALM_SIZE_BEHAVIOR\.sales\) => \{/,
    '分组函数还在（口径来自配置 ✓）');
  assert.match(code, /if \(item\.count > 0 \|\| !grouped\) inStock\.push\(item\)/, '仍按可售数量分"现货" ✓');
  assert.match(code, /prepaid\.push\(item\)/, '仍分出"预订"那一组 ✓');
  assert.match(code, /const sellableCountOf = |sellableCountOf\(row/, '仍按可售数量判"有货" ✓');
  assert.match(code, /const sizeRowsOf = \(view\) => \(Array\.isArray\(view\?\.rows\)/, '尺码行仍只吃 `view.rows`（实时库存 ✓ 不再读采购明细 ✓）');
});

test('AC-NS5 ⭐ `purchaseSizeReader.js` **文件保留**（不删 ✗）＋ 顶部注明"当前无生产引用"', () => {
  const file = fs.readFileSync(path.join(SERVER, 'src/services/purchaseSizeReader.js'), 'utf8');
  assert.ok(file.includes('当前无生产引用'), '文件顶部要注明现状 ✓（她的决定：接线删、文件留 ✓）');
});
