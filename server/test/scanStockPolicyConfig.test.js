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
  ENABLED_KEY, LEGACY_SELLABLE_STATES, SCAN_STOCK_POLICY, resolveScanStockPolicy,
  legacySellableCountOf, liveInventoryCountOf, countInStockOf, isInStock,
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
  // ① 变量名一处定义 + 用 readFlag（"空串 = 关""认不出 = 抛"那套语义的唯一实现）
  const policySrc = readSrc('config/scanStockPolicy.js');
  assert.equal(ENABLED_KEY, 'SCAN_STOCK_POLICY_ENABLED', '开关变量名逐字');
  assert.match(stripComments(policySrc), /readFlag\(env, ENABLED_KEY, false\)/,
    '取开关只许用 `readFlag(env, ENABLED_KEY, false)`（缺省 false ✓）');
  assert.equal(/process\.env\.SCAN_STOCK_POLICY_ENABLED\s*\|\|/.test(policySrc), false,
    '🔴 不许 `process.env.X || 兜底`（清空变量想关掉时会静默回退 ⇒ 关不掉 ✗）');
  assert.equal(/SCAN_STOCK_POLICY_ENABLED[^\n]*\|\|/.test(policySrc), false,
    '🔴 `SCAN_STOCK_POLICY_ENABLED` 那一行不许出现 `||`');

  // ② 四种取值语义（纯函数：不碰全局 process.env ⇒ 与别的用例并发也互不污染）
  assert.equal(resolveScanStockPolicy({}).enabled, false, '没设 ⇒ false（缺省关着 = 今天）');
  assert.equal(resolveScanStockPolicy({ [ENABLED_KEY]: '' }).enabled, false, '设成空串 ⇒ **关**（显式取值，不是回退）');
  assert.equal(resolveScanStockPolicy({ [ENABLED_KEY]: 'true' }).enabled, true, 'true ⇒ 开');
  assert.equal(resolveScanStockPolicy({ [ENABLED_KEY]: '0' }).enabled, false, '0 ⇒ 关');
  assert.throws(() => resolveScanStockPolicy({ [ENABLED_KEY]: 'maybe' }), /显式布尔/,
    '认不出来的值 ⇒ **当场抛错**（不静默按 true/false 处理 ✗）');

  // ③ 本进程（缺省）就是"关着"那条路 —— 下面几条判据都以此为前提
  assert.equal(SCAN_STOCK_POLICY.enabled, false,
    '缺省必须是关着（否则"与今天逐字一致"那条零回归判据无从谈起）');
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
  // 普通码 = normal 两端展开（**以配置为准** —— 配置里现在是 男 38–45 / 女 36–41）
  assert.deepEqual(normalSizesOf('A'), Array.from({ length: 8 }, (_, i) => 38 + i), '男普通码 = 38…45');
  assert.deepEqual(normalSizesOf('B'), Array.from({ length: 6 }, (_, i) => 36 + i), '女普通码 = 36…41');
  // 特殊码 = **离散清单**（不是区间！女 = 34/35/42/43 ⇒ 不许 expandRange ✗）
  assert.deepEqual(specialSizesOf('A'), [46, 47, 48], '男特殊码 = 46/47/48');
  assert.deepEqual(specialSizesOf('B'), [34, 35, 42, 43], '女特殊码 = 34/35/42/43（**离散** ⇒ 不许当区间 ✗）');
  assert.deepEqual(specialSizesOf('C'), [], '认不出类别 ⇒ 空（一条都不折 ✓）');

  // 新文件里**不许**再抄一份尺码数字（除注释外的代码里不许出现那些区间字面量）
  const code = stripComments(readSrc('config/scanStockPolicy.js'));
  for (const literal of ['[38, 45]', '[36, 41]', '[46, 47, 48]', '[34, 35, 42, 43]', '[38, 48]', '[34, 43]']) {
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
  assert.match(realmCode, /const SELLABLE_STATES = LEGACY_SELLABLE_STATES/,
    'realm 只是**引用**配置里那一份旧口径（唯一真源 ✓）');
  assert.match(realmCode, /const sellableCountOf = \(row, columns = \[\]\) => countInStockOf\(row, columns\);/,
    '`sellableCountOf` 只剩**转发**（签名/返回值不变 ⇒ 既有调用方与用例一个字不用改 ✓）');

  // ② 判据本体在配置里，且只有一处（`countInStockOf` 里那个二选一）
  assert.match(policyCode, /const countInStockOf = \(row, columns = \[\], policy = SCAN_STOCK_POLICY\) => \(/,
    '唯一判据 = 配置里的 `countInStockOf`');
  assert.equal((policyCode.match(/policy\.enabled \?/g) || []).length, 1,
    '「开关二选一」这句在配置里**只许出现一次**（多处 = 又散了 ✗）');

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
    assert.equal(legacySellableCountOf(row, columns), beforeRefactorCountOf(row, columns),
      `旧口径逐字等价：row=${JSON.stringify(row)}`);
    // 缺省（本进程开关关着）走的就是这一条 ⇒ `countInStockOf` 与它同结论
    assert.equal(countInStockOf(row, columns), beforeRefactorCountOf(row, columns),
      `缺省口径 = 旧口径：row=${JSON.stringify(row)}`);
  }
  // 旧口径的状态清单本身也逐字不变
  assert.deepEqual([...LEGACY_SELLABLE_STATES], ['门盒', '样品'], '旧口径 = 门盒 + 样品（她 2026-10-09）');
  assert.deepEqual([...realm.SELLABLE_STATES], ['门盒', '样品'], 'realm 导出的那个名字仍指向同一份');
  // 「仓库 2 双」在**旧口径**下不算有货（这一点**没被本刀改** ✗ —— 它只在开关开着时变）
  assert.equal(isInStock(cases[2], columns), false, '旧口径：43 只有仓库 ⇒ 不算有货');
  assert.equal(isInStock(cases[3], columns), false, '旧口径：44 只有未标状态 ⇒ 不算有货');
});

test('AC-STP4b ⭐ 新口径的取数 = 视图模型那一行的 `total`（**不看状态** ✓）', () => {
  assert.equal(liveInventoryCountOf({ total: 2, cells: [{ key: '仓库', count: 2 }] }), 2, '仓库 2 双也照数 ✓');
  assert.equal(liveInventoryCountOf({ total: 1, cells: [{ key: '', count: 1 }] }), 1, '未标状态 1 双也照数 ✓');
  assert.equal(liveInventoryCountOf({ total: 0 }), 0, '没有记录 ⇒ 0');
  assert.equal(liveInventoryCountOf({ total: 3, unknown_size: true }), 0,
    '「尺码未识别」那一行**不是**一个【编号+尺码】⇒ 0（不许混进来 ✗）');
  // 开关**开着**（显式注入 policy，不改全局 env）：与 total 一致、与旧口径不同
  const on = resolveScanStockPolicy({ [ENABLED_KEY]: 'true' });
  assert.equal(countInStockOf({ total: 2, cells: [{ key: '仓库', count: 2 }] }, [], on), 2, '开着 ⇒ 仓库也算有货');
  assert.equal(countInStockOf({ total: 1, cells: [{ key: '', count: 1 }] }, [], on), 1, '开着 ⇒ 未标状态也算有货');
  assert.equal(countInStockOf({ total: 0, cells: [] }, [], on), 0, '开着 ⇒ 没有记录 = 无货');
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
