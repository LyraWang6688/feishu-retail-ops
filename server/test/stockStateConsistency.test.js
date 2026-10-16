/**
 * ⭐⭐ **扫码页四个 tab 的"库存口径一致性"证据用例**（2026-10-16 · 业务负责人真机报的不一致）。
 *
 * 她看到的现象（逐字要点，货品 8516 · 黑色 · 凉鞋 · 男 · ¥99 · 2026-10-16 20:35 上海）：
 *   · **库存** tab：`库存（共 1 双）`，表 4 列 = 门盒 / 样品 / 仓库 / **未标状态**；
 *     **44 码那一行只有「未标状态」= 1**（其它三列都是 `—`）；
 *   · **销售** tab：「有货（样品 + 门盒）」段写 `这一款现在没有可选的尺码`，8 个尺码**全在预订段**；
 *   · **补货** tab：38~45 全部 `0 双`；
 *   · **退货** tab：`这一款现在没有可退的库存`。
 *   ⇒ 同一双鞋，库存页说有 1 双（在"未标状态"），其余三页都说 0 —— 她问"这个是怎么回事"。
 *
 * 只读诊断（结论 + 证据链）见 `docs/scan-stock-state-consistency-2026-10-16.md`。一句话：
 *   · **四个 tab 读的是同一份视图模型、同一份快照** ⇒ 不是缓存分家；
 *   · 「有货 / 可卖」的**唯一判据**是 `views/scanPageRealm.js` 的
 *     `SELLABLE_STATES = ['门盒','样品']`（销售 / 补货 / 退货**三处共用** `sellableCountOf`）；
 *   · 「未标状态」= 「实时库存.所属状态」**为空**的行：**不在她定义的三态里**
 *     （`config/scanPage.js:STATES.columns` / `docs/inventory-adjustment-plan-2026-10-06.md:79`），
 *     而 `inventoryService` 只允许写门盒/样品/仓库（`LIVE_STATES`，写别的当场抛）
 *     ⇒ **它是脏数据/残缺行**，但**它确实占着 1 双** ⇒ **它算不算"库存"要她拍**；
 *   · 在不一致里，**三个 tab 与库存页都没有"算错"**：三个 tab 忠于她 2026-10-09 定的
 *     「可卖 = 样品 + 门盒」（`docs/scan-selling-caliber-2026-10-09.md`）；库存页忠于
 *     「配置外/空状态**不丢、不猜**、另列一列，否则共 N 双与明细对不上」。
 *     错的是**两套口径同时出现在一页上、而页面不解释**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉三件事（**先写判据、再谈改不改**）：
 *
 *  AC-ST1 **一致性**：**同一份库存数据** ⇒ 四个 tab 对"这个尺码现在能不能卖"的结论
 *          必须一致（含"未标状态"那一份）：库存页那一行的**可卖格**（门盒/样品）之和 > 0
 *          ⇔ 销售页把它放进「有货（现货）」段 ⇔ 补货页给它 `现货` tag ⇔ 退货页列出它。
 *          ⚠️ 反向也要钉：**只有未标状态**的尺码（44）**四个 tab 都不许说它有货**
 *          （当前口径：未标 = 不可卖 ⇒ 三页说没有 ✓、库存页那一行的可卖格也是 0 ✓）。
 *          哪天有人把「未标」塞进可卖清单（口径 A）⇒ 这条会**当场红**（44 会被三页认作有货）
 *          ⇒ 那时候**必须连同"库存页怎么说这句话"一起改**（不能只改一半）。
 *
 *  AC-ST2 **她那个真实现象复现成用例**：44 码 1 双在「未标状态」⇒ 四个 tab 的
 *          **逐字**显示钉死（库存页 `共 1 双` / `未标状态` 列 / 44 行只有那一格是 `1`；
 *          销售页「这一款现在没有可选的尺码」＋ 44 在预订段；补货页 44 `0 双`；
 *          退货页 `这一款现在没有可退的库存`）。
 *
 *  AC-ST4 **端到端（服务层 → 渲染层）**：拿"她那一款"的**真实形状**（「实时库存」里
 *          1 条记录、`所属状态` 为空）跑一遍 **`scanPageService.lookup`** ⇒
 *          视图模型 = 4 列（含配置里的 `emptyLabel`）＋ `total = 1` ＋ 44 不缺码；
 *          再拿它渲染四个 tab ⇒ 与 AC-ST2 的逐字结论**完全一致**。
 *          🔴 这一条是**服务层**的哨兵：谁把"共 N 双"改成只数三态（或把空状态列吞掉），
 *          它会**当场红**（AC-ST2 只钉渲染层，钉不到服务层）。
 *
 *  AC-ST3 **回归**：门盒 / 样品 / 仓库 三种状态的行 ⇒ 四个 tab 与今天**逐字一致**
 *          （逐字快照 = `test/fixtures/stockStateConsistency.golden.json`）。
 *          ⚠️ 快照里**唯一的动态位**是 `page_build`（`APP_VERSION@APP_COMMIT`，本地与 CI 不同）
 *          ⇒ 比对前把它换成占位符；其余**一个字节都不许差**。
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 🔴 本文件**只读**：只 require 视图层 / 配置，不碰任何写入口、不碰 `scanWriteService`、不碰路由。
 *
 * ⭐⭐ **2026-10-16 晚（本刀）成对迁移 · 改前逐字 → 改后逐字 → 依据**：
 *   改前逐字：本文件把「未标状态**不算**有货」当作**当前（唯一）口径**来钉
 *     （AC-ST1 的 `sellableOfRow(..., '44') === 0`、AC-ST2 的"预订段有 44"…）。
 *   改后逐字：**断言一条都没动** ✗ —— 只加了一句**前提自证**（AC-ST1 开头）：
 *     `SCAN_STOCK_POLICY.enabled === false` ⇒ 本文件钉的是**"开关关着（= 今天）"那条路**。
 *   依据：业务负责人 2026-10-16 20:5x 亲口改了口径 ——「**统一不用看状态**，只要在实时库存里
 *     这个编号**有尺码记录，就都是有货**」⇒ 她那把 44 码**在新口径下算有货**
 *     （钉在新文件 `test/scanStockPolicyUnifiedOn.test.js` 的 **AC-ST6**）。
 *     ⇒ 本文件不是"过期判据"：它是**新口径的零回归基线**（开关关着时必须逐字保持今天的样子 ✓）。
 *   ⚠️ **没有删 / 没有 skip / 没有放宽**：仅仅是**把口径归属写明**（避免下一个人以为它错了 ✗）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { SCAN_STOCK_POLICY } = require('../src/config/scanStockPolicy');
const { renderScanPage } = require('../src/views/scanPageRenderer');
// 改前逐字：`const { SELLABLE_STATES, … } = require(…)` ⇒ 改后：**名单已退场 ⇒ 不再 import** ✓
const { sellableCountOf, saleSizeGroups, purchaseSizeLines } = require('../src/views/scanPageRealm');

/** 四个 tab（渲染入口 = `?from=`；`realmBlockHtml` 只拼当前那一块）。 */
const REALM_IDS = ['inventory', 'sales', 'replenish', 'purchase_return'];

/**
 * ⚠️ `page_build` 是**动态位**（`config/scanPage.js` 的 `PAGE_BUILD` = `APP_VERSION@APP_COMMIT`，
 *    本地与 CI 不同）⇒ 逐字比对前换成占位符。**只换这一个**（别的都是配置里的确定值）。
 */
const PAGE_BUILD_TOKEN = '«page_build»';
const normalize = (text) => String(text).split(SCAN_PAGE.pageBuild).join(PAGE_BUILD_TOKEN);

/** 取某一份 HTML 里领域那一块（到页脚 `<p class="foot">` 之前）。 */
const blockOf = (html, id) => {
  const page = html.slice(html.indexOf('</head>'));
  const start = page.indexOf(`realm-block--${id}"`);
  assert.ok(start > -1, `缺 ${id} 块`);
  const foot = page.indexOf('<p class="foot">', start);
  return page.slice(start, foot > -1 ? foot : page.length);
};

/** 一行的可卖数量（**唯一判据**：`SELLABLE_STATES` = 门盒 + 样品）。 */
const sellableOfRow = (view, size) => {
  const row = view.rows.find((item) => String(item.size_text) === String(size));
  return row ? sellableCountOf(row, view.columns) : 0;
};

/** 库存页那一行：`<th scope="row">44</th>` 之后到 `</tr>` 之间的所有数字格（含 `—`）。 */
const inventoryCellsOf = (html, size) => {
  const block = blockOf(html, 'inventory');
  const start = block.indexOf(`<th scope="row">${size}`);
  assert.ok(start > -1, `库存表里缺 ${size} 那一行`);
  const row = block.slice(start, block.indexOf('</tr>', start));
  return [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((match) => match[1]);
};

/** 某个 tab 里「有货」的尺码集合（**按它自己的渲染产物**读出来，不借内部函数）。 */
const sellableSizesOf = (html, realm) => {
  const block = blockOf(html, realm);
  if (realm === 'inventory') {
    // 库存页没有"现货组"：可卖 = 那一行里**门盒 / 样品两格**有数 ⇒ 用同一份视图模型对表。
    return null; // 由调用方用 sellableOfRow 对表（见 AC-ST1）
  }
  if (realm === 'sales') {
    const start = block.indexOf('data-stock-group="in_stock"');
    const end = block.indexOf('</fieldset>', start);
    return [...block.slice(start, end).matchAll(/name="size" value="(\d+)"/g)].map((m) => m[1]);
  }
  if (realm === 'replenish') {
    // 「现货」tag 的那一格（`<li … data-purchase-size="NN">` 里带 `>现货<`）
    return [...block.matchAll(/data-purchase-size="(\d+)"[\s\S]*?<\/li>/g)]
      .filter((m) => m[0].includes('>现货<')).map((m) => m[1]);
  }
  // 退货：列出来 = 有数量可退（`<input … name="return_sizes" value="NN">`）
  return [...block.matchAll(/name="return_sizes" value="(\d+)"/g)].map((m) => m[1]);
};

/**
 * ⭐ 夹具 = **照她的真实现象**（货品 8516）：44 码那 1 双的「所属状态」是**空**。
 *   40 码 = 门盒 1 + 样品 1（⇒ 三页都必须说"有货"）
 *   43 码 = 仓库 2（⇒ 三页都不许说有货：她 2026-10-09「仓库不算可卖」）
 *   44 码 = 未标状态 1（⇒ 本次不一致的那一双）
 */
const BLANK_STATE_FIXTURE = {
  found: true,
  number: '8516|黑色|A',
  item_no: '8516',
  color: '黑色',
  category_name: '凉鞋',
  category_code: 'A',
  price_text: '¥99',
  total: 5, // 40 的 2 双 + 43 的 2 双 + 44 的 1 双（标题「共 N 双」= 记录条数）
  columns: [
    { key: '门盒', label: '门盒' },
    { key: '样品', label: '样品' },
    { key: '仓库', label: '仓库' },
    { key: '', label: SCAN_PAGE.states.emptyLabel },
  ],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }, { key: '', count: 0 }], total: 2, missing: false },
    { size_text: '43', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 2 }, { key: '', count: 0 }], total: 2, missing: false },
    { size_text: '44', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 1 }], total: 1, missing: false },
  ],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 20:35',
  product_record_id: 'prod_8516',
};

/**
 * ⭐⭐ **她真机那一款的完整形状**（货品 8516 · 男 A 段 38~48 全列）：
 *   只有 **44 码 1 双**，而且那一双的「所属状态」是**空**（未标状态）
 *   ⇒ 销售页两个组**都**没有现货 ⇒ 有货段才会写「这一款现在没有可选的尺码」（**她截图那一句**）。
 *   ⚠️ 缺货基准 = **可录范围**（A 38–48，她 2026-10-14 最终口径）⇒ 46/47/48 也在这里（展示层收进折叠块）。
 */
const FULL_SIZES_BLANK_FIXTURE = {
  found: true,
  number: '8516|黑色|A',
  item_no: '8516',
  color: '黑色',
  category_name: '凉鞋',
  category_code: 'A',
  price_text: '¥99',
  total: 1, // 记录条数 = 1（就是那双 44 码、状态为空的）
  columns: BLANK_STATE_FIXTURE.columns,
  rows: [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48].map((size) => ({
    size_text: String(size),
    cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 },
      { key: '', count: size === 44 ? 1 : 0 }],
    total: size === 44 ? 1 : 0,
    // 缺码 = 该码在可录范围里、且这一行合计为 0（44 有 1 双 ⇒ 不缺）
    missing: size !== 44,
  })),
  missing_count: 10,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 20:35',
  product_record_id: 'prod_8516',
};

/**
 * ⭐ **回归夹具**（= 今天四页都能看到的三种状态，**没有空状态列**）：
 *   与 `scanPageRealms.test.js` 的 `VIEW` **同一个形状**（40 门盒 1 / 42 门盒 1 + 样品 1 /
 *   41·44 缺码 / 43 只有仓库 2）——AC-ST3 拿它钉"与今天逐字一致"。
 */
const THREE_STATE_FIXTURE = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 5,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }], total: 2, missing: false },
    { size_text: '43', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 2 }], total: 2, missing: false },
    { size_text: '44', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 2,
  sizes_degraded: false,
  notes: ['缺码说明'],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
};

/** 最小写上下文（字段名 / 动作 / 文案照 `config/scanWrite.js` 的形状 —— 与既有用例一致）。 */
const WRITE = {
  ...SCAN_WRITE,
  enabled: true,
  sizes: [],
  draft: { lines: [] },
  postAction: '/s/8516',
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  returnKey: 'scan_return:scan_session_0123456789abcdef:1',
};

const htmlOf = (view, realm) => renderScanPage(view, SCAN_PAGE, WRITE, realm);

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST1 一致性：同一份库存数据 ⇒ 四个 tab 对"能不能卖"必须一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST1 同一份数据（含 1 双「未标状态」）⇒ 四个 tab 的"有货"判据必须一致', () => {
  // ⭐⭐ 2026-10-16 晚（本刀）**前提自证**：本文件钉的是**开关关着（= 今天）那条路**。
  //   她 20:5x 改口后的新口径（"实时库存里有记录 = 有货"）钉在
  //   `test/scanStockPolicyUnifiedOn.test.js` **AC-ST5/AC-ST6**（那个文件自己设 env ⇒ 独立进程 ✓）。
  //   ⇒ 若谁在跑全量时把 `SCAN_STOCK_POLICY_ENABLED=true` 带进环境，这一句会**当场点名**是环境问题 ✗。
  assert.equal(SCAN_STOCK_POLICY.enabled, false,
    'AC-ST1（旧口径）只在开关**关着**时成立 —— 新口径见 scanStockPolicyUnifiedOn.test.js');
  // ① 判据 = 她 2026-10-09 定的那两个状态（**开关关着时**的唯一真源，三个 tab 共用）
  assert.deepEqual([...SELLABLE_STATES], ['门盒', '样品'],
    '可卖 = 门盒 + 样品（她 2026-10-09）；「仓库」与「未标状态」都不在清单里');
  assert.equal(sellableOfRow(BLANK_STATE_FIXTURE, '40'), 2, '40：门盒 1 + 样品 1 ⇒ 可卖 2');
  assert.equal(sellableOfRow(BLANK_STATE_FIXTURE, '43'), 0, '43：只有仓库 2 ⇒ 不可卖（她 2026-10-09：仓库不算）');
  assert.equal(sellableOfRow(BLANK_STATE_FIXTURE, '44'), 0, '44：只有「未标状态」1 ⇒ **旧口径**：不可卖');

  // ② 三个 tab 各自渲染出来的"有货尺码集合"必须**完全一致**，且等于按判据算出来的那一组
  const byCriterion = BLANK_STATE_FIXTURE.rows
    .filter((row) => sellableCountOf(row, BLANK_STATE_FIXTURE.columns) > 0)
    .map((row) => String(row.size_text));
  for (const realm of REALM_IDS) {
    const html = htmlOf(BLANK_STATE_FIXTURE, realm);
    if (realm === 'inventory') {
      // 库存页没有"现货组"：对表 = 那一行的**门盒 + 样品两格**是不是 > 0（同一份判据）
      for (const row of BLANK_STATE_FIXTURE.rows) {
        const cells = inventoryCellsOf(html, row.size_text);
        assert.equal(cells.length, 4, `${row.size_text} 那一行要有 4 格（门盒/样品/仓库/未标状态）`);
        const boxAndSample = cells.slice(0, 2).filter((text) => /^\d+$/.test(text))
          .reduce((sum, text) => sum + Number(text), 0);
        assert.equal(boxAndSample > 0, sellableCountOf(row, BLANK_STATE_FIXTURE.columns) > 0,
          `库存页 ${row.size_text} 行的可卖格（门盒+样品）必须与 sellableCountOf 同结论`);
      }
      continue;
    }
    assert.deepEqual(sellableSizesOf(html, realm).slice().sort(), byCriterion.slice().sort(),
      `${realm} tab 的"有货"尺码集合必须与判据一致（当前 = 只有 40）`);
  }

  // ③ 🔴 反向钉住：**只有未标状态**的 44 ⇒ 三个 tab 都**不许说它有货**
  assert.deepEqual(sellableSizesOf(htmlOf(BLANK_STATE_FIXTURE, 'sales'), 'sales'), ['40'],
    '销售页「有货（现货）」段当前只有 40；44 不在里面');
  assert.deepEqual(sellableSizesOf(htmlOf(BLANK_STATE_FIXTURE, 'replenish'), 'replenish'), ['40'],
    '补货页当前只有 40 带「现货」tag');
  assert.deepEqual(sellableSizesOf(htmlOf(BLANK_STATE_FIXTURE, 'purchase_return'), 'purchase_return'), ['40'],
    '退货页当前只列出 40（可退 = 有可卖数量）');
  assert.deepEqual(inventoryCellsOf(htmlOf(BLANK_STATE_FIXTURE, 'inventory'), '44'), ['—', '—', '—', '1'],
    '库存页 44 那一行：门盒/样品/仓库 三格都没有，只有「未标状态」= 1（**她看到的那一行**）');

  // ④ 「仓库」那一行（43）也不许被任何一个 tab 说成有货（她 2026-10-09 的口径，回归）
  for (const realm of ['sales', 'replenish', 'purchase_return']) {
    assert.equal(sellableSizesOf(htmlOf(BLANK_STATE_FIXTURE, realm), realm).includes('43'), false,
      `${realm} tab 不许把「仓库」有货的 43 说成有货`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST2 她的真实现象（44 码 1 双在「未标状态」）—— 四个 tab 逐字钉死
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST2 44 码 1 双在「未标状态」⇒ 四个 tab 的显示逐字钉死（就是她截图那一幕）', () => {
  const inventory = htmlOf(FULL_SIZES_BLANK_FIXTURE, 'inventory');
  // 库存页：共 1 双（记录条数口径）—— 就是她看到的那句
  assert.ok(inventory.includes(`<h2 class="stock__heading">${SCAN_PAGE.texts.stockHeading.replace('{total}', '1')}</h2>`),
    '库存页标题 = 「库存（共 1 双）」（**她截图那一句**）');
  assert.ok(inventory.includes(`<th>${SCAN_PAGE.states.emptyLabel}</th>`),
    '库存页把空状态另列一列（列头 = 配置里的 emptyLabel）');
  assert.ok(inventory.includes('<th scope="row">44</th><td class="zero">—</td><td class="zero">—</td><td class="zero">—</td><td>1</td>'),
    '44 码那一行：**只有「未标状态」= 1**（她截图里的那一行）');
  assert.equal(/<tr class="missing"><th scope="row">44/.test(inventory), false,
    '44 码不算缺码（那一行合计 = 1）');
  assert.equal(inventoryCellsOf(inventory, '44').join('|'), '—|—|—|1', '44 行四格逐字');

  const sales = htmlOf(FULL_SIZES_BLANK_FIXTURE, 'sales');
  assert.ok(sales.includes('<span class="hint">这一款现在没有可选的尺码</span>'),
    '销售页有货段写着「这一款现在没有可选的尺码」（**她看到的那句**）');
  const inStockStart = sales.indexOf('data-stock-group="in_stock"');
  const inStockGroup = sales.slice(inStockStart, sales.indexOf('</fieldset>', inStockStart));
  assert.equal(inStockGroup.includes('name="size"'), false, '现货段一个尺码都没有');
  // 8 个常规码（38~45）全在「现在没有（预订）」段 —— 包括 44
  const prepaidStart = sales.indexOf('data-stock-group="prepaid"');
  const prepaidGroup = sales.slice(prepaidStart, sales.indexOf('</fieldset>', prepaidStart));
  for (const size of [38, 39, 40, 41, 42, 43, 44, 45]) {
    assert.ok(prepaidGroup.includes(`name="size" value="${size}"`), `${size} 码在预订段`);
  }
  assert.ok(prepaidGroup.includes('name="size" value="44"'),
    '44 落在「现在没有（预订）」段 ⇒ 这一单会被记成预订（**当前口径的后果，必须让她看到**）');

  const replenish = htmlOf(FULL_SIZES_BLANK_FIXTURE, 'replenish');
  assert.match(replenish, /data-purchase-size="44"[\s\S]*?0 双/,
    '补货页 44 显示 `0 双`（**她截图里的那一格**）');
  assert.match(replenish, /data-purchase-size="44"[\s\S]*?>无</,
    '补货页 44 的 tag 是「无」而不是「缺码」—— 它**有 1 双**，只是那 1 双不在可卖状态里（这处细节必须留着，不能糊成"缺码"）');

  const purchaseReturn = htmlOf(FULL_SIZES_BLANK_FIXTURE, 'purchase_return');
  assert.ok(purchaseReturn.includes(`data-view="return-no-stock">${SCAN_PAGE.returnForm.noReturnableStock}<`),
    '退货页写着「这一款现在没有可退的库存」（**她看到的那句**）');
  assert.equal(/name="return_sizes"/.test(purchaseReturn), false, '退货页一行可勾的尺码都没有');

  // 复现自证：同一双鞋，两个 tab 两个结论
  assert.ok(inventory.includes('<td>1</td>'), '库存页确实数到了那 1 双');
  assert.equal(inStockGroup.includes('name="size"'), false, '销售页确实把那 1 双当成了"现在没有"');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST3 回归：门盒 / 样品 / 仓库 三种状态 ⇒ 四个 tab 与今天逐字一致
// ═══════════════════════════════════════════════════════════════════════════

const GOLDEN_PATH = path.join(__dirname, 'fixtures', 'stockStateConsistency.golden.json');

/** 逐字快照的两款夹具（键名即快照里的字段名）。 */
const GOLDEN_CASES = [
  { key: 'blocks', view: THREE_STATE_FIXTURE, label: '门盒/样品/仓库 三种状态（= 今天线上那条路）' },
  { key: 'blankStateBlocks', view: FULL_SIZES_BLANK_FIXTURE, label: '她的现象（44 码 1 双在「未标状态」）' },
  { key: 'blankStateThreeSizeBlocks', view: BLANK_STATE_FIXTURE, label: '未标状态 + 仓库 + 门盒样品 混在一款上' },
];

test('AC-ST3 四 tab 的逐字快照：三种状态与「未标状态」两款都必须与诊断时逐一字节相同', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  for (const { key, view, label } of GOLDEN_CASES) {
    assert.deepEqual(Object.keys(golden[key] || {}).sort(), REALM_IDS.slice().sort(),
      `${label}：快照要四块齐全（库存 / 销售 / 补货 / 退货）`);
    for (const realm of REALM_IDS) {
      assert.deepEqual(normalize(blockOf(htmlOf(view, realm), realm)), golden[key][realm],
        `${label} · ${realm} tab 与诊断产物逐字一致`);
    }
  }
  // ⚠️ 快照里**只有** page_build 是动态位（本地 / CI 不同）——别的都是配置里的确定值
  assert.ok(Object.values(golden.blocks).some((text) => text.includes(PAGE_BUILD_TOKEN)),
    'page_build 确实被换成了占位符（否则本地绿、CI 红）');
});

test('AC-ST3b 快照是"活的"：把「未标状态」那一列整列拿掉 ⇒ 快照当场红', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  // 造一份"未标状态不再另列"的视图（= 有人把空状态列吞掉的样子）：快照必须对不上
  const withoutBlankColumn = {
    ...FULL_SIZES_BLANK_FIXTURE,
    columns: FULL_SIZES_BLANK_FIXTURE.columns.filter((column) => column.key !== ''),
    rows: FULL_SIZES_BLANK_FIXTURE.rows.map((row) => ({
      ...row, cells: row.cells.filter((cell) => cell.key !== ''),
    })),
  };
  assert.notDeepEqual(normalize(blockOf(htmlOf(withoutBlankColumn, 'inventory'), 'inventory')),
    golden.blankStateBlocks.inventory,
    '空状态那一列被吞掉 ⇒ 库存页快照必须变（这条证明快照不是"随便改都绿"）');
  assert.ok(golden.blankStateBlocks.inventory.includes(`<th>${SCAN_PAGE.states.emptyLabel}</th>`),
    '快照里确实留着「未标状态」那一列（**没被静默吞掉**）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ST4 端到端：服务层聚合 → 四个 tab（她那一款走完整条只读链路）
// ═══════════════════════════════════════════════════════════════════════════

const { createScanPageService } = require('../src/services/scanPageService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const SERVICE_NUMBER = '8516|黑色|A';
const SERVICE_PRODUCT = {
  record_id: 'prod_8516',
  fields: { 编号: SERVICE_NUMBER, 货号: '8516', 颜色: { text: '黑色' }, 类别: 'A', 品类: { text: '凉鞋' }, 单价: 99 },
};
const SERVICE_INVENTORY = [{
  record_id: 'inv_8516_44_blank',
  fields: {
    编号: ['prod_8516'], 尺码: ['size_44'], 所属状态: '', 库存键: '8516|黑色|A|44',
    品类: '凉鞋', 更新时间: Date.UTC(2026, 9, 16, 12, 35),
  },
}];
const fakeGateway = () => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => ({ product: [SERVICE_PRODUCT], liveInventory: SERVICE_INVENTORY, sizeManagement: [] }[key] || []),
  create: async () => { throw new Error('扫码页不许写'); },
  update: async () => { throw new Error('扫码页不许写'); },
  delete: async () => { throw new Error('扫码页不许写'); },
});

test('AC-ST4 端到端：她那一款（1 条记录、所属状态为空）⇒ 视图模型与四个 tab 逐字复现', async () => {
  const service = createScanPageService(fakeGateway(), { config: SCAN_PAGE });
  const view = await service.lookup({ number: SERVICE_NUMBER, requestId: 'ac_st4' });

  // ① 服务层聚合：空状态**不丢、不猜**，另列一列（列头来自配置），并且仍然计数
  assert.deepEqual(view.columns.map((column) => column.label),
    ['门盒', '样品', '仓库', SCAN_PAGE.states.emptyLabel],
    '四列：三个配置状态 + 配置里的 emptyLabel（空状态另列，不吞）');
  assert.equal(view.total, 1, '「共 N 双」= 「实时库存」里属于这一款的**记录条数**（含空状态那一条）');
  const row44 = view.rows.find((row) => row.size_text === '44');
  assert.deepEqual(row44.cells.map((cell) => cell.count), [0, 0, 0, 1], '44 码：只有空状态那一格 = 1');
  assert.equal(row44.missing, false, '44 不是缺码（它合计 = 1）');
  assert.equal(sellableCountOf(row44, view.columns), 0, '可卖 = 门盒 + 样品 = 0（空状态不在清单里）');

  // ② 渲染层：四个 tab 的结论与 AC-ST2（手写夹具）**完全一致** ⇒ 夹具没编错
  // ①b 「共 N 双」那一句必须把**空状态那一双**数进去（她自己看到的就是「共 1 双」）——
  //     🔴 这是**服务层**口径的哨兵：谁把标题改成只数三态，这条当场红。
  assert.equal(view.total, view.rows.reduce((sum, row) => sum + row.total, 0),
    '「共 N 双」必须与表里各行合计一致（含空状态那一行）');
  assert.ok(blockOf(renderScanPage(view, SCAN_PAGE, WRITE, 'inventory'), 'inventory')
    .includes(SCAN_PAGE.texts.stockHeading.replace('{total}', '1')),
  '库存页标题 = 「库存（共 1 双）」（**她截图那一句**）');

  for (const realm of REALM_IDS) {
    assert.equal(normalize(blockOf(renderScanPage(view, SCAN_PAGE, WRITE, realm), realm)),
      normalize(blockOf(htmlOf(FULL_SIZES_BLANK_FIXTURE, realm), realm)).replace(
        '2026-10-16 20:35', view.updated_at_text),
      `${realm} tab：服务层真数据渲染出来的产物必须与手写夹具的一致`);
  }

  // ③ 一句人话：空状态**不在**"配置外取值"那条 warn 的范围内（它是 emptyLabel 那一路），
  //    但页面上必须**看得见**它（否则她又会以为"这一双没了"）
  assert.ok(blockOf(renderScanPage(view, SCAN_PAGE, WRITE, 'inventory'), 'inventory')
    .includes(`<th>${SCAN_PAGE.states.emptyLabel}</th>`), '库存页那一列必须在页面上');
});

// ═══════════════════════════════════════════════════════════════════════════
// 判据自证：本文件钉的是"渲染产物"，不是"内部函数"（防假绿）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ST0 判据自证：`sellableSizesOf` 真从 HTML 里读（改一行渲染就会变）', () => {
  // 把 44 那 1 双从「未标状态」挪进「门盒」⇒ 三个 tab 必须**同时**变成"有货"
  // （这正是口径 A 落地后应该发生的事：一处配置改、三处跟着变 —— 反向也说明判据是活的）
  const moved = {
    ...BLANK_STATE_FIXTURE,
    rows: BLANK_STATE_FIXTURE.rows.map((row) => (row.size_text === '44'
      ? { ...row, cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 0 }] }
      : row)),
  };
  assert.deepEqual(sellableSizesOf(htmlOf(moved, 'sales'), 'sales').sort(), ['40', '44'],
    '44 进了门盒 ⇒ 销售页必须把它放进现货段');
  assert.deepEqual(sellableSizesOf(htmlOf(moved, 'replenish'), 'replenish').sort(), ['40', '44'],
    '44 进了门盒 ⇒ 补货页必须给它「现货」tag');
  assert.deepEqual(sellableSizesOf(htmlOf(moved, 'purchase_return'), 'purchase_return').sort(), ['40', '44'],
    '44 进了门盒 ⇒ 退货页必须列出它');
  assert.deepEqual(inventoryCellsOf(htmlOf(moved, 'inventory'), '44'), ['1', '—', '—', '—'],
    '库存页 44 那一行：门盒 = 1（同一份数据、四个 tab 一起变）');
});
