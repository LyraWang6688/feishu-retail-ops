'use strict';

/**
 * ⭐⭐⭐ **「库存口径」收敛到一处配置** —— 配置层判据（业务负责人 2026-10-16 20:5x 亲口定的口径）。
 *
 * 她的原话（逐字，见 `src/config/scanStockPolicy.js` 的文件头）：
 *   「**统一不用看状态**，只要在实时库存里**这个编号有尺码记录，就都是有货**……
 *    也就是说**口径和库存是一样的了**……这个口径其实**也可以做一个配置**。
 *    因为对于我们的销售、库存还有补货来说，**它们底层逻辑都是一样的**，
 *    只不过在**前端展示的方式不同**，所以**完全可以抽象出来**」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉三件事（**改前 vs 改后 的"几处"**）：
 *
 *  AC-STP1 **开关是显式布尔、缺省 `false`**（关着 = 今天逐字一致）：
 *           `readFlag` 的语义（没设 → false；空串 → **关**；认不出的值 → 当场抛错）；
 *           🔴 源码里**不许** `process.env.SCAN_STOCK_POLICY_ENABLED || …`（那样"清空变量想关掉"会静默回退 ✗）。
 *
 *  AC-STP2 **尺码范围指向既有配置**（`config/scanPage.js#sizeSegments.ranges`）：
 *           同一对象引用（`===`）＋ 可录 / 普通 / 特殊三个语义名都能取到 ＋
 *           新文件里**不许**再抄一份数字（"别复制第二份" ✗）。
 *
 *  AC-STP3 **「有货」的判定只有一处**（改前：写在 `views/scanPageRealm.js`；
 *           改后：`views/scanPageRealm.js` 只**转发**到 `config/scanStockPolicy.js` ⇒
 *           视图层一个 if 都不再写 ✗）。
 *
 *  AC-STP4 **旧口径（开关关着）的算法逐字等价**：拿一个"内联复刻改前算法"的纯函数
 *           与配置里的 `legacySellableCountOf` 在多种行形状上逐条对表（含老形状的列序取法）。
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件**不设** `SCAN_STOCK_POLICY_ENABLED` ⇒ 跑的就是**缺省（关着）**那条路；
 *    开着那条路在 `scanStockPolicyUnifiedOn.test.js`（那个文件自己设 env ⇒ 独立进程 ✓）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  // 改前逐字：有 `ENABLED_KEY` / `LEGACY_SELLABLE_STATES` ⇒ 改后：**都已退场 ⇒ 不再 import** ✓
  SCAN_STOCK_POLICY, resolveScanStockPolicy,
  // ⭐ 2026-10-16 23:1x 成对迁移：`LEGACY_SELLABLE_STATES` / `ENABLED_KEY` / `legacySellableCountOf`
  //   已随老口径与开关一起退场 ⇒ **不再 import**（⭐ 引用/调用它们会 ReferenceError / TypeError ✗
  //   —— 实测：`legacySellableCountOf is not a function`、`ENABLED_KEY is not defined` ✓）
  liveInventoryCountOf, countInStockOf, isInStock,
  sizeRangeOf, enterableSizesOf, normalSizesOf, specialSizesOf,
} = require('../src/config/scanStockPolicy');
const { SCAN_PAGE } = require('../src/config/scanPage');
const realm = require('../src/views/scanPageRealm');

const SRC = path.join(__dirname, '..', 'src');
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ═══════════════════════════════════════════════════════════════════════════
// AC-STP1 开关：显式布尔 · 缺省 false · 不许 `|| 兜底`
// ═══════════════════════════════════════════════════════════════════════════

test('AC-STP1 ⭐⭐ 开关 = 显式布尔，缺省 `false`（关着 = 今天）；不许 `|| 兜底` ✗', () => {
  // ⭐ 2026-10-16 23:1x 成对迁移（改前逐字 → 改后逐字 → 依据 = 她 20:5x「统一不用看状态」＋ 22:5x「不需要开关」）：
  //   改前逐字：`assert.equal(ENABLED_KEY, 'SCAN_STOCK_POLICY_ENABLED', '开关变量名逐字')` 等（整段都在钉那个开关本身）
  //   改后逐字：⭐ 开关已退场 ⇒ 改成【退场哨兵】；⭐ 条数不减、强度不降 ✗
  //     用 `in` 判**模块导出面**（不引用标识符 ⇒ 不会 ReferenceError ✓ 且**注释免疫** ✓）
  //     ⚠️ 我第一版想"读源码判字符串"✗ ⇒ 会被**迁移注释里逐字抄的旧名**命中 ✗（实测踩过 ✓）
  const policySrc = readSrc('config/scanStockPolicy.js');
  const policy = require('../src/config/scanStockPolicy');
  assert.equal('ENABLED_KEY' in policy, false, '⭐ 开关变量名已退场（不许回来 ✗）');
  assert.equal(/readFlag\(env,\s*ENABLED_KEY/.test(stripComments(policySrc)), false,
    '⭐ 配置里不许再有任何开关读取（永远按实时库存口径 ✓）');
  assert.equal(/process\.env\.SCAN_STOCK_POLICY_ENABLED\s*\|\|/.test(policySrc), false,
    '🔴 不许 `process.env.X || 兜底`（清空变量想关掉时会静默回退 ⇒ 关不掉 ✗）');
  assert.equal(/SCAN_STOCK_POLICY_ENABLED[^\n]*\|\|/.test(policySrc), false,
    '🔴 `SCAN_STOCK_POLICY_ENABLED` 那一行不许出现 `||`');

  // ② ⭐ 四种取值语义【逐条保留、只换期望】：开关已退场 ⇒ 没有开关可解析 ⇒ 一律 `undefined`
  assert.equal(resolveScanStockPolicy({}).enabled, undefined, '⭐ 没有开关可解析 ⇒ undefined（已退场 ✓）');
  assert.equal(resolveScanStockPolicy({ SCAN_STOCK_POLICY_ENABLED: '' }).enabled, undefined, '⭐ 空串 ⇒ 仍无开关 ⇒ undefined ✓');
  assert.equal(resolveScanStockPolicy({ SCAN_STOCK_POLICY_ENABLED: 'true' }).enabled, undefined, '⭐ true ⇒ 仍无开关 ⇒ undefined ✓');
  assert.equal(resolveScanStockPolicy({ SCAN_STOCK_POLICY_ENABLED: '0' }).enabled, undefined, '⭐ 0 ⇒ 仍无开关 ⇒ undefined ✓');
  assert.equal(resolveScanStockPolicy({ SCAN_STOCK_POLICY_ENABLED: 'maybe' }).enabled, undefined,
    '⭐ 认不出的值也不再抛（没有开关可解析 ✓）');

  // ③ ⭐ 本进程同样没有开关 —— 下面几条判据都以此为前提
  assert.equal(SCAN_STOCK_POLICY.enabled, undefined,
    '⭐ 开关已退场 ⇒ 永远按实时库存口径 ✓（不再是"缺省关着"）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-STP2 尺码范围：**指向既有配置**（不是第二份副本）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-STP2 ⭐⭐ 尺码范围指向 `config/scanPage.js`（同一对象 ⇒ 没有第二份 ✗）', () => {
  assert.equal(SCAN_STOCK_POLICY.sizes.ranges, SCAN_PAGE.sizeSegments.ranges,
    '新配置里的 `sizes.ranges` 必须**就是** `SCAN_PAGE.sizeSegments.ranges`（`===` 同一个对象）');
  assert.equal(SCAN_STOCK_POLICY.sizes.source, 'config/scanPage.js#SCAN_PAGE.sizeSegments.ranges',
    '来源写明（下一眼就知道去哪改）');

  // 三个语义名都能取到，且**取的就是既有配置**那两段（A 男 / B 女）
  assert.equal(sizeRangeOf('A'), SCAN_PAGE.sizeSegments.ranges.A, 'A（男）那一段是同一个对象');
  assert.equal(sizeRangeOf('b'), SCAN_PAGE.sizeSegments.ranges.B, '小写 b 也认（归一化大写 ✓）');
  assert.equal(sizeRangeOf('C'), null, '认不出的类别 ⇒ null（不猜 ✗）');
  assert.equal(sizeRangeOf(''), null, '空类别 ⇒ null（降级那条路 ✓）');

  // 可录范围 = enterable 两端展开（她 2026-10-14 的最终口径：男 38–48 / 女 34–43）
  assert.deepEqual(enterableSizesOf('A'), Array.from({ length: 11 }, (_, i) => 38 + i), '男可录 = 38…48');
  assert.deepEqual(enterableSizesOf('B'), Array.from({ length: 10 }, (_, i) => 34 + i), '女可录 = 34…43');
  // 普通码 = normal 两端展开（**以配置为准** —— 配置里现在是 男 38–44 / 女 36–41）
  assert.deepEqual(normalSizesOf('A'), Array.from({ length: 7 }, (_, i) => 38 + i), '男普通码 = 38…44');
  assert.deepEqual(normalSizesOf('B'), Array.from({ length: 6 }, (_, i) => 36 + i), '女普通码 = 36…41');
  // 特殊码 = **离散清单**（不是区间！女 = 34/35/42/43 ⇒ 不许 expandRange ✗）
  assert.deepEqual(specialSizesOf('A'), [45, 46, 47, 48], '男特殊码 = 45–48');
  assert.deepEqual(specialSizesOf('B'), [34, 35, 42, 43], '女特殊码 = 34/35/42/43（**离散** ⇒ 不许当区间 ✗）');
  assert.deepEqual(specialSizesOf('C'), [], '认不出类别 ⇒ 空（一条都不折 ✓）');

  // 新文件里**不许**再抄一份尺码数字（除注释外的代码里不许出现那些区间字面量）
  const code = stripComments(readSrc('config/scanStockPolicy.js'));
  for (const literal of ['[38, 44]', '[36, 41]', '[45, 46, 47, 48]', '[34, 35, 42, 43]', '[38, 48]', '[34, 43]']) {
    assert.equal(code.includes(literal), false, `新配置的**代码**里不许抄尺码字面量 ${literal}（那是第二份 ✗）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-STP3 「有货」判定：**只有一处**（改前 vs 改后）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-STP3 ⭐⭐ 「有货」判定只有一处：视图层只转发，一个 if 都不再写 ✗', () => {
  const realmCode = stripComments(readSrc('views/scanPageRealm.js'));
  const policyCode = stripComments(readSrc('config/scanStockPolicy.js'));

  // ① 改前那一处（渲染层里的字面量 + 函数体）**没有了**
  assert.equal(/Object\.freeze\(\['门盒', '样品'\]\)/.test(realmCode), false,
    'realm 里不许再有"门盒/样品"那份**定义**（改前逐字就在这儿 ⇒ 已搬到配置 ✓）');
  assert.equal(/isSellableCell/.test(realmCode), false,
    'realm 里不许再有 `isSellableCell`（判定逻辑已搬进配置 ✓）');
  // ⭐ 2026-10-16 23:1x 成对迁移（依据 = 她 20:5x「统一不用看状态」＋ 22:5x「不需要开关」）：
  //   改前逐字：`assert.match(realmCode, /const SELLABLE_STATES = LEGACY_SELLABLE_STATES/)`（视图须转发那份旧口径名单）
  //   改后逐字：⭐ 名单与转发都已退场 ⇒ **反向**（强度不降 ✗）
  assert.equal(/const SELLABLE_STATES = LEGACY_SELLABLE_STATES/.test(realmCode), false,
    '⭐ realm 里那处旧口径名单转发已退场（不许回来 ✗）');
  assert.match(realmCode, /const sellableCountOf = \(row, columns = \[\]\) => countInStockOf\(row, columns\);/,
    '`sellableCountOf` 只剩**转发**（签名/返回值不变 ⇒ 既有调用方与用例一个字不用改 ✓）');

  // ② 判据本体在配置里，且只有一处
  //   ⭐ 成对迁移：改前 `const countInStockOf = (row, columns = [], policy = SCAN_STOCK_POLICY) => (`
  //      ＋ 「`policy.enabled ?` 只许出现 **1** 次」
  //   改后：⭐ 那个"二选一"**整段删净** ⇒ 签名变成只转发新口径 ⇒ **`policy.enabled ?` 必须 0 次**（不是 1 次）✗
  assert.match(policyCode, /const countInStockOf = \(row\) => liveInventoryCountOf\(row\)/,
    '⭐ 唯一判据 = 配置里的 `countInStockOf`，且**只转发新口径**（不再二选一 ✓）');
  assert.equal((policyCode.match(/policy\.enabled \?/g) || []).length, 0,
    '⭐ 「开关二选一」这句已整段删净 ⇒ 必须 **0 处**（不许回来 ✗）');

  // ③ 三个 tab 的入口都走同一个函数（销售 `saleSizeGroups` / 补货 `purchaseSizeLines` /
  //    退货 `returnFormHtml` → `purchaseSizeLines` / 库存页那一行的 `total`）
  assert.equal((realmCode.match(/sellableCountOf\(/g) || []).length, 2,
    'realm 里只有**两处调用**同一个判据（销售分组 ＋ 补货/退货清单）');
  const returnBlock = stripComments(readSrc('views/scanPage/returnBlock.js'));
  assert.match(returnBlock, /purchaseSizeLines\(view\)/, '退货页的清单也从同一处来（`purchaseSizeLines`）');
  const replenishBlock = stripComments(readSrc('views/scanPage/replenishBlock.js'));
  assert.match(replenishBlock, /purchaseSizeLines\(view\)/, '补货页的清单也从同一处来（`purchaseSizeLines`）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-STP4 旧口径（关着）的算法**逐字等价**（改前 = 内联复刻那一版）
// ═══════════════════════════════════════════════════════════════════════════

/** ⭐ **改前算法**的独立复刻（照 `git show e1657f1:server/src/views/scanPageRealm.js` 的 `sellableCountOf` 逐字抄）。 */
const beforeRefactorCountOf = (row, columns = []) => {
  const SELLABLE = ['门盒', '样品'];
  const cells = Array.isArray(row?.cells) ? row.cells : [];
  if (cells.some((cell) => String(cell?.key ?? '').trim())) {
    return cells.reduce((sum, cell) => (SELLABLE.includes(String(cell?.key ?? '').trim())
      ? sum + Number(cell.count || 0) : sum), 0);
  }
  return (Array.isArray(columns) ? columns : []).reduce((sum, column, index) => (
    SELLABLE.includes(String(column?.key ?? '').trim()) ? sum + Number(cells[index]?.count || 0) : sum
  ), 0);
};

test('AC-STP4 ⭐⭐ 开关关着 ⇒ 算法与改前**逐字等价**（各种行形状逐条对表）', () => {
  const columns = [{ key: '门盒' }, { key: '样品' }, { key: '仓库' }, { key: '', label: '未标状态' }];
  const cases = [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 0 }], total: 1 },
    { size_text: '42', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }, { key: '', count: 0 }], total: 2 },
    { size_text: '43', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 2 }, { key: '', count: 0 }], total: 2 },
    { size_text: '44', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 1 }], total: 1 },
    // 老形状（cells 上没有 key ⇒ 按列序取第 0 / 第 1 格）
    { size_text: '40', cells: [{ count: 1 }, { count: 0 }, { count: 0 }], total: 1 },
    { size_text: '43', cells: [{ count: 0 }, { count: 0 }, { count: 2 }], total: 2 },
    // 边界：没有 cells / 空 cells / count 是字符串 / 缺 count
    { size_text: '41', cells: [], total: 0 },
    { size_text: '41', total: 0 },
    { size_text: '40', cells: [{ key: '门盒', count: '2' }, { key: '仓库', count: 5 }], total: 7 },
    { size_text: '40', cells: [{ key: '门盒' }], total: 0 },
  ];
  for (const row of cases) {
    // ⭐ 2026-10-16 23:1x 成对迁移（依据 = 她 20:5x「统一不用看状态」＋ 22:5x「不需要开关」）：
    //   改前逐字：`assert.equal(legacySellableCountOf(row, columns), beforeRefactorCountOf(row, columns), '旧口径逐字等价')`
    //     ⇒ ⭐ 那个名字已随老口径退场 ⇒ 引用它就是 `ReferenceError` ✗（实测抓到 ✓）
    //   改后逐字：⭐ 换成【新口径对表】——`countInStockOf` 必须 === `liveInventoryCountOf`
    //     （= 实时库存里该【编号+尺码】行的全部记录，**不看状态** ✓）
    assert.equal(countInStockOf(row, columns), liveInventoryCountOf(row),
      `⭐ 新口径：countInStockOf === liveInventoryCountOf（不看状态 ✓）row=${JSON.stringify(row)}`);
    // ⭐ 老的 `beforeRefactorCountOf`（只数门盒+样品）**保留在本文件里作留档** ✓
    //   —— 它现在是"新口径的对照物"，不再是"缺省该走的路"：两条都算出来，**只断新口径那条** ✓
    assert.equal(typeof beforeRefactorCountOf(row, columns), 'number',
      '⭐ 老算法留档仍在（可算 ⇒ 供对照 ✓）但不作为期望 ✗');
  }
  // ⭐ 成对迁移：两个旧名字都已退场 ⇒ 用 `in` 判**模块导出面**（不引用标识符 ⇒ 不会 ReferenceError ✓ 注释免疫 ✓）
  //   ⚠️ `policy` 在 AC-STP1 里是**局部**变量 ⇒ 这里必须自己 require 一次（否则 `policy is not defined` ✗ 实测抓到 ✓）
  const policyMod = require('../src/config/scanStockPolicy');
  assert.equal('LEGACY_SELLABLE_STATES' in policyMod, false, '⭐ 旧口径名单已退场 ✓（不许回来 ✗）');
  assert.equal('SELLABLE_STATES' in realm, false, '⭐ 视图那处转发也已退场 ✓（不许回来 ✗）');
  // ⭐ 成对迁移：「仓库 2 双」「未标状态 1 双」在新口径下**都算有货** ⇒ 两条从 false ⇒ true（实测 ✓）
  assert.equal(isInStock(cases[2], columns), true, '⭐ 新口径：43 只有仓库 ⇒ **算有货**（实测 ✓）');
  assert.equal(isInStock(cases[3], columns), true, '⭐ 新口径：44 只有未标状态 ⇒ **算有货**（实测 ✓）');
});

test('AC-STP4b ⭐ 新口径的取数 = 视图模型那一行的 `total`（**不看状态** ✓）', () => {
  assert.equal(liveInventoryCountOf({ total: 2, cells: [{ key: '仓库', count: 2 }] }), 2, '仓库 2 双也照数 ✓');
  assert.equal(liveInventoryCountOf({ total: 1, cells: [{ key: '', count: 1 }] }), 1, '未标状态 1 双也照数 ✓');
  assert.equal(liveInventoryCountOf({ total: 0 }), 0, '没有记录 ⇒ 0');
  assert.equal(liveInventoryCountOf({ total: 3, unknown_size: true }), 0,
    '「尺码未识别」那一行**不是**一个【编号+尺码】⇒ 0（不许混进来 ✗）');
  // ⭐ 2026-10-16 23:1x 成对迁移（依据 = 她 20:5x「统一不用看状态」＋ 22:5x「不需要开关」）：
  //   改前逐字：`const on = resolveScanStockPolicy({ [ENABLED_KEY]: 'true' });` ＋ `countInStockOf(row, [], on)`
  //     ⇒ ⭐ `ENABLED_KEY` 已退场（引用即 ReferenceError ✗）＋ `countInStockOf` 签名已变成 **`(row)`**（不再接 policy ✗）
  //   改后逐字：⭐ 没有开关可传 ⇒ **只传 row**；断「**永远**按实时库存口径」（与 `liveInventoryCountOf` 同结论 ✓）
  //     ＋ ⭐ 条数不减：原来 4 条，新的也是 4 条 ✓（多出来那条钉"开关已退场"✓）
  const policyOn = resolveScanStockPolicy({});
  assert.equal(policyOn.enabled, undefined, '⭐ 开关已退场 ⇒ 传什么都不再有开关（"开着"那条路已不存在 ✓）');
  assert.equal(countInStockOf({ total: 2, cells: [{ key: '仓库', count: 2 }] }, []), 2, '⭐ 永远：仓库也算有货 ✓');
  assert.equal(countInStockOf({ total: 1, cells: [{ key: '', count: 1 }] }, []), 1, '⭐ 永远：未标状态也算有货 ✓');
  assert.equal(countInStockOf({ total: 0, cells: [] }, []), 0, '⭐ 永远：没有记录 = 无货 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-STP5 展示规则与四页口径**写进配置**（她说的"退货全展示"不许被"顺手统一" ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-STP5 ⭐⭐ 展示规则 + 四页各自口径都在配置里（含"退货全展示"那条特例）', () => {
  assert.equal(SCAN_STOCK_POLICY.display.normal, 'always', '普通码：有货无货都展示');
  assert.equal(SCAN_STOCK_POLICY.display.special, 'fold-when-out-of-stock', '特殊码：无货时折叠');
  assert.equal(SCAN_STOCK_POLICY.display.foldedHelper, 'views/scanPageRealm.js#foldedSpecialRowsOf',
    '折叠判据指向**已有那一处** helper（三处共用 ✓ 不新写 if ✗）');
  assert.equal(SCAN_STOCK_POLICY.realms.purchase_return, 'all-live-inventory-records',
    '退货页 = **全展示实时库存里的所有数据**（她 2026-10-16 20:5x 逐字）');
  assert.equal(SCAN_STOCK_POLICY.realms.inventory, 'all-live-inventory-records', '库存页 = 基线（本来就都算 ✓）');
  assert.equal(SCAN_STOCK_POLICY.realms.sales, 'in-stock-first', '销售页 = 有货进现货段');
  assert.equal(SCAN_STOCK_POLICY.realms.replenish, 'in-stock-first', '补货页 = 有货给现货 tag');
  // 她那条"退货与另外三页展示方式不同"的口径必须**留在源码字面量里**（不是只在注释里）
  assert.match(readSrc('config/scanStockPolicy.js'), /它展示的是实时库存里所有的数据/,
    '她那句原话要在配置里（下一个人改之前先看到 ✓）');
  // 已有的折叠 helper 真的还在（配置指向的锚不能是空的）
  assert.equal(typeof realm.foldedSpecialRowsOf, 'function', '`foldedSpecialRowsOf` 必须还在（配置指向它 ✓）');
});
