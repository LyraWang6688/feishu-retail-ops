require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
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

test('AC-NS2 ⭐ 普通码默认段：A 38–44 · B **36–40**（逐档参数化 ✓）', () => {
  // eslint-disable-next-line global-require
  const { SCAN_PAGE } = require('../src/config/scanPage');
  const ranges = SCAN_PAGE.sizeSegments.ranges;
  assert.deepEqual(ranges.A.default, [38, 44], 'A（男）普通码 38–44 ✓');
  assert.deepEqual(ranges.B.default, [36, 40], 'B（女）普通码 **36–40**（2026-10-18 起 41 移入特殊码 ✓）');
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
  // ⭐ 2026-10-14 改指向：**缺货的特殊码**已归到 `folded`（折叠块）⇒ 判"显示不显示"要把三组都算上 ✓
  //   （本夹具没给 `columns` ⇒ 有货数算成 0 ⇒ 43 落到折叠块；真页面会传 columns ⇒ 它就在现货区 ✓ 见 AC-SF2）
  const texts = [...groups.inStock, ...groups.prepaid, ...(groups.folded || [])].map((item) => String(item.size_text));
  assert.ok(texts.includes('43'), '⭐ 库存里有的 43 必须显示（特殊码不再是"要采购明细出现过"✗）');
  assert.ok(texts.includes('36'), '有货的 36 显示在现货组 ✓');
  assert.ok(!texts.includes('38'), '库存里**没有**的码不显示 ✓（也不计缺码 ✓）');
});

test('AC-NS4 ⭐ 现货/预订分组**照旧**（仍按可售状态分组、仍只吃实时库存 rows ✓ 回归）', () => {
  // ⚠️ 我第一版用自造夹具去断言分组，夹具形状不对 ⇒ 改成**源码级**回归（分组的实现没动 ✓）
  const code = stripped('src/views/scanPageRealm.js');
  // ⭐⭐ 2026-10-16 晚 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.match(code, /const SELLABLE_STATES = Object\.freeze\(\['门盒', '样品'\]\)/, '可售状态定义没动 ✓');`
  //     （"可卖 = 门盒 + 样品"那份字面量**写在渲染层**）
  //   改后逐字：那份字面量**搬进 `config/scanStockPolicy.js`**（名字 = `LEGACY_SELLABLE_STATES`）；
  //     `views/scanPageRealm.js` 只**引用**它（`const SELLABLE_STATES = LEGACY_SELLABLE_STATES`）⇒
  //     这条改成**两条**：配置里有那份定义 ＋ realm 里只是引用（**不许再定义第二份** ✗）
  //   依据：她 2026-10-16 20:5x「这个口径其实**也可以做一个配置**」＋
  //     「**统一不用看状态**」（新口径开关见 `config/scanStockPolicy.js` 的 `enabled`）。
  //   ⚠️ **没有放宽**：旧口径的字面量仍然**只存在一处**（只是从 realm 换成 config ✓）。
  const policyCode = stripped('src/config/scanStockPolicy.js');
  // ⭐⭐ 2026-10-16 23:2x **成对迁移**（改前逐字 → 改后逐字 → 依据 · 第二刀：删开关②）：
  //   改前逐字：`assert.match(policyCode, /const LEGACY_SELLABLE_STATES = Object\.freeze\(\['门盒', '样品'\]\)/)`
  //            ＋ `assert.match(code, /const SELLABLE_STATES = LEGACY_SELLABLE_STATES/)`
  //   改后逐字：⭐ 那份旧口径名单**连同开关一起退场**（policy 里 −48 行整段删净、realm 里转发退场）
  //     ⇒ 两条都改成【反向哨兵】—— ⭐ 用 `in` 判**模块导出面**
  //       （不引用标识符 ⇒ 不会 ReferenceError ✓ **注释免疫** ✓ —— 我第一版想"读源码判字符串"被迁移注释命中过 ✗）
  //   依据：她 2026-10-16 22:5x「不要开关思维 ⇒ 既有开关要删掉（连同关着时的老分支）」
  //   ⚠️ **没有放宽**：`assert.match`（必须存在）⇒ `assert.equal(… in …, false)`（必须不存在）——
  //     两者都能真红（塞回去 ⇒ 立刻红 ✓）；
  //   ⭐ 下面 `:73-80` 那几条（分组函数还在 / 仍分两组 / 仍只吃 view.rows）**照旧不动** ✗
  const policyMod = require('../src/config/scanStockPolicy');
  const realmMod = require('../src/views/scanPageRealm');
  assert.equal('LEGACY_SELLABLE_STATES' in policyMod, false,
    '⭐ 旧口径名单已随开关退场（不许回来 ✗）');
  assert.equal('SELLABLE_STATES' in realmMod, false,
    '⭐ realm 那处转发也已退场（不许回来 ✗）');
  // 2026-10-14：分组口径搬进 `config/scanPage.js`（配置先行）⇒ 签名多了可注入的 `behavior`；
  //   这条**不放宽**：既钉"函数还在 + 签名形状"，也钉"仍按可售数量分组、仍分两组" ✓
  assert.match(code, /const saleSizeGroups = \(view, behavior = SCAN_PAGE\.REALM_SIZE_BEHAVIOR\.sales\) => \{/,
    '分组函数还在（口径来自配置 ✓）');
  assert.match(code, /if \(item\.count > 0 \|\| !grouped\) inStock\.push\(item\)/, '仍按可售数量分"现货" ✓');
  assert.match(code, /prepaid\.push\(item\)/, '仍分出"预订"那一组 ✓');
  assert.match(code, /const sellableCountOf = |sellableCountOf\(row/, '仍按可售数量判"有货" ✓');
  assert.match(code, /const sizeRowsOf = \(view\) => \(Array\.isArray\(view\?\.rows\)/, '尺码行仍只吃 `view.rows`（实时库存 ✓ 不再读采购明细 ✓）');
});

test('AC-NS5 ⭐ `purchaseSizeReader.js` 已删除（2026-10-18 业务负责人确认「前端没有就删」）', () => {
  assert.equal(fs.existsSync(path.join(SERVER, 'src/services/purchaseSizeReader.js')), false,
    '无生产引用的 reader 文件应已删除 ✓');
});
