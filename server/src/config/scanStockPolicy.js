/**
 * ⭐⭐⭐ **扫码页四 tab 的「库存口径」唯一真源**（业务负责人 2026-10-16 20:5x **亲口定的口径**）。
 *
 * 她的原话（逐字，**这就是需求**）：
 *   「既然四个页面用的都是**实时库存**，那就**统一不用看状态**，只要在实时库存里**这个编号有尺码记录，
 *     就都是有货**……也就是说**口径和库存是一样的了**。另外，实际上对于**退货**来说，它展示的是
 *     **实时库存里所有的数据**。但像我们的**补货、销售以及库存**，尺码范围**男款是 38 到 48，
 *     女款是 34 到 43**。而且我们之前有个规定要分**普通码和特殊码**：**普通码有货无货都要展示出来，
 *     特殊码无货时则折叠**。所以你需要看一下，**补货、销售以及库存这边的口径是不是也是一致的**，
 *     这个口径其实**也可以做一个配置**。因为对于我们的销售、库存还有补货来说，**它们底层逻辑都是一样的，
 *     只不过在前端展示的方式不同，所以完全可以抽象出来**」
 *
 * ── 为什么放在 `config/` 而不是 `views/` ────────────────────────────────────
 *   「怎么算有货」是**业务口径**（会变的东西），「怎么摆」才是视图参数。
 *   她 2026-10-05 定的「配置先行」＋ 2026-10-16「这个口径其实也可以做一个配置」⇒
 *   **口径的家在 `config/**`**，视图层**只读**它、**一个字都不自己判** ✗。
 *   改前「有货 = `门盒 + 样品`」这条写死在 `views/scanPageRealm.js:184`（渲染层）——
 *   这正是"四页打架"的根因之一：**前端在决定算不算** ✗。
 *
 * ── 这份配置收敛的三件事（**改口径只改这一处**）────────────────────────────
 *  ① **「有货」怎么算**（`inStock`）—— ⭐ **唯一口径、没有开关**（2026-10-16 22:5x 起）：
 *       **实时库存里该【编号 + 尺码】有记录 = 有货**（**完全不看「所属状态」** ✗）。
 *       ⚠️ 旧口径（`门盒 + 样品`，她 2026-10-09）**已整段删净** ✗（不是「翻成 true」；见 `docs/no-switch-rule-2026-10-16.md`）。
 *  ② **尺码范围**（`sizes`）：**指向既有那一处配置** `config/scanPage.js#sizeSegments.ranges`
 *       （可录 `enterable` / 普通 `normal` / 特殊 `special`），本文件**不复制第二份** ✗ ——
 *       只把语义名挂上去、并提供**只读**取值函数。
 *  ③ **展示规则**（`display` / `realms`）：普通码**有货无货都展示**；
 *       特殊码**无货折叠**（复用**已有那一处** helper `views/scanPageRealm.js#foldedSpecialRowsOf`，
 *       **不在这里再写一遍 if** ✗）；**退货页全展示实时库存里的所有数据**
 *       （与另外三页"有货才显示"的**展示**口径不同 —— 但**"有货"的判据仍是上面这一处** ✓）。
 *
 * 🔴 **本文件没有开关**（2026-10-16 22:5x「不需要开关」✓）：口径只有一处，改口径 = 改这一处 ✓。
 *    判据：`scanStockPolicyUnifiedOn` 的 AC-ST5/6/8/9 ＋ `scanStockPolicyConfig`（形状）✓。
 *
 * ⚠️ **本文件只做纯函数判定**：零飞书读、零 IO、不 require 任何 service。
 */

const { SCAN_PAGE, expandRange } = require('./scanPage');


/**
 * ⭐ 取值（**纯函数**，进 `env` ⇒ 可单测、不碰全局 `process.env`）。
 *   · 没设 ⇒ `false`（缺省关着 = 与今天逐字一致）；
 *   · 设了（含空串）⇒ 显式取值（空串 = 关）；
 *   · 认不出来的值 ⇒ **当场抛错**（`readFlag` 的语义，不猜）。
 */
const resolveScanStockPolicy = (env = process.env) => Object.freeze({
  // ── ① 「有货」的两种口径（**判据本体在下面 `countInStockOf`**）────────────────
  inStock: Object.freeze({
    // 开着：实时库存里该【编号 + 尺码】**有记录**（**不看状态** ✗）—— 她 2026-10-16 20:5x 的口径
    liveInventoryRecord: 'live-inventory-record',
  }),
  // ── ② 尺码范围：**指向既有配置**（同一个对象引用 —— 不是第二份副本 ✗）──────────
  sizes: Object.freeze({
    source: 'config/scanPage.js#SCAN_PAGE.sizeSegments.ranges',
    // ⚠️ `ranges` 是 `SCAN_PAGE.sizeSegments.ranges` **本身**（`===` 同一个对象）；
    //    语义名：`enterable` = 可录范围（男 38–48 / 女 34–43）·
    //             `normal`    = 普通码（有货无货都展示 ＋ 缺码判据）·
    //             `special`   = 特殊码（无货折叠）。
    ranges: SCAN_PAGE.sizeSegments.ranges,
  }),
  // ── ③ 展示规则（**只决定"怎么摆"**，不决定"算不算" ✗）──────────────────────
  display: Object.freeze({
    // 普通码：**有货无货都要展示出来**（她 2026-10-16 20:5x 逐字）
    normal: 'always',
    // 特殊码：**无货时折叠**（她 2026-10-16 20:5x 逐字）
    special: 'fold-when-out-of-stock',
    // 折叠的**判据**只有一处（`foldedSpecialRowsOf` = 缺货 ∩ 特殊码，销售/库存/补货共用 ✓）
    foldedHelper: 'views/scanPageRealm.js#foldedSpecialRowsOf',
  }),
  // 四个 tab 各自"展示什么"（**判据同一处，展示可以不同** ✓ —— 她就是这么说的）
  realms: Object.freeze({
    sales: 'in-stock-first',
    replenish: 'in-stock-first',
    // 库存页：**基线** —— 表体 = 实时库存里每一行（本来就"都算" ✓）
    inventory: 'all-live-inventory-records',
    // ⭐ 退货页：她 2026-10-16 20:5x 逐字「**它展示的是实时库存里所有的数据**」
    //    ⇒ 与另外三页"有货才显示"的展示口径**不同**（写在这里，免得下次又有人"顺手统一"✗）
    purchase_return: 'all-live-inventory-records',
  }),
});

/** 进程启动时取一次（与 `SCAN_PAGE.cache.enabled` / `snapshot.enabled` 同一套"模块级求值"惯例）。 */
const SCAN_STOCK_POLICY = resolveScanStockPolicy(process.env);

// ═══════════════════════════════════════════════════════════════════════════
// ① 「有货」的**唯一判据**
// ═══════════════════════════════════════════════════════════════════════════

/** 一格的列名是不是"旧口径的可卖状态"（门盒 / 样品）。 */
const isLegacySellableCell = (cell, states = LEGACY_SELLABLE_STATES) => (
  states.includes(String(cell?.key ?? '').trim())
);



/**
 * **新口径**的数量 = 实时库存里该【编号 + 尺码】的**记录条数**（**完全不看「所属状态」** ✗）。
 *
 * ⚠️ 为什么就是视图模型那一行的 `total`：服务层（`services/scanPageService.js:1298`）
 *    的行集 = `实时库存记录建出来的 buckets` ∪ `可录范围内的缺货尺码`，
 *    且 `row.total` = 那一行**所有状态格之和** ⇒
 *      **`total > 0` ⟺ 这个尺码在「实时库存」里至少有一条记录** ✓
 *    —— 与库存页看到的是**同一份数**（"口径和库存是一样的了" ✓ 零新增读 ✓）。
 * ⚠️ 「尺码未识别」那一行（`unknown_size`）**不是**一个【编号 + 尺码】⇒ 一律 0。
 */
const liveInventoryCountOf = (row) => (row?.unknown_size ? 0 : Number(row?.total ?? 0));

/**
 * ⭐⭐ **「有货」数量 —— 全仓唯一判据。**
 *
 *   唯一口径 ⇒ `liveInventoryCountOf`（实时库存里有记录，不看状态 ✓）；旧口径已删净 ✗
 *
 * 销售 / 补货 / 退货三页**都从这里取**（`views/scanPageRealm.js` 的 `sellableCountOf` 只是转发）；
 * 库存页那一行的 `total` 就是**同一个数**（基线对照 ✓）。⇒ **前端不再决定"算不算"** ✗
 */
// ⭐⭐ 2026-10-16 22:5x **成对迁移**（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：`policy.enabled ? liveInventoryCountOf(row) : legacySellableCountOf(row, columns)`
//   改后逐字：⭐ **只留新口径** ✓ `liveInventoryCountOf(row)`（老口径整段删净 ✗ 不是 `if (true)` ✗）
//   依据 = 她 20:5x「**统一不用看状态**，只要在实时库存里这个编号有尺码记录，就都是有货」
//          ＋ 22:5x「不需要开关」✓（`docs/no-switch-rule-2026-10-16.md` ✓）
const countInStockOf = (row) => liveInventoryCountOf(row);

/** 这一行现在算不算"有货"（布尔 —— 与 `countInStockOf > 0` 同一判据，避免各处再写一遍比较 ✗）。 */
const isInStock = (row, columns = [], policy = SCAN_STOCK_POLICY) => (
  countInStockOf(row, columns, policy) > 0
);

// ═══════════════════════════════════════════════════════════════════════════
// ② 尺码范围（**只读既有配置**：`config/scanPage.js` 的 `sizeSegments.ranges`）
// ═══════════════════════════════════════════════════════════════════════════

/** 这一款的类别（编号第 3 段，`A` / `B`）对应的那一段配置；认不出 ⇒ `null`（不猜 ✗）。 */
const sizeRangeOf = (categoryCode, policy = SCAN_STOCK_POLICY) => (
  policy.sizes.ranges[String(categoryCode ?? '').trim().toUpperCase()] || null
);

/** **可录范围**（`enterable`）展开成码数组 —— 男 38–48 / 女 34–43。 */
const enterableSizesOf = (categoryCode, policy = SCAN_STOCK_POLICY) => (
  expandRange(sizeRangeOf(categoryCode, policy)?.enterable)
);

/** **普通码**（`normal`）—— 有货无货都展示 ＋ 缺码分类；男 38–44 / 女 36–40（**以配置为准** ✓）。 */
const normalSizesOf = (categoryCode, policy = SCAN_STOCK_POLICY) => (
  expandRange(sizeRangeOf(categoryCode, policy)?.normal)
);

/**
 * **特殊码**（`special`）—— 缺货时折叠。
 * ⚠️ 它是**离散码清单**（女 = `[34,35,41,42,43]`），**不是区间** ⇒ **不许用 `expandRange`** ✗
 *    （`expandRange([34,35,…)` 会把第 3 个元素当垃圾、把 34~35 当成一个区间 ⇒ 静默错 ✓）。
 */
const specialSizesOf = (categoryCode, policy = SCAN_STOCK_POLICY) => {
  const range = sizeRangeOf(categoryCode, policy);
  const special = range?.special;
  return Array.isArray(special) ? special.map(Number).sort((a, b) => a - b) : [];
};

module.exports = {
  SCAN_STOCK_POLICY,
  resolveScanStockPolicy,
  liveInventoryCountOf,
  countInStockOf,
  isInStock,
  sizeRangeOf,
  enterableSizesOf,
  normalSizesOf,
  specialSizesOf,
};
