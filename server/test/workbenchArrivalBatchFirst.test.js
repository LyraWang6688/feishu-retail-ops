'use strict';

/**
 * ⭐⭐ task-27（2026-10-15 · 业务负责人真机逐字）：
 *   「验收页展示应该是**采购主表里未到货的批次号**，然后**用户点击之后才是对应的采购明细情况**，
 *     然后**可以自行补充**这个货号下的其余尺码和数量」
 *   「（一键确认按申请数）……**实际到多少就是到多少**」
 *   ⭐ 同日**追加口径**（覆盖 Lead 早前写法）：「（无批次号）……后续不会出现了，然后最新的逻辑，
 *     这些数据也不会出现，**因为首先得在采购主表有批次号才会展示**」
 *
 * ## 改前（真源见 PR）
 * · `purchaseBatchCardHtml` 在**第一屏**就把该批明细铺开（`<ul class="order-lines">`）✗ ——
 *   不是她要的"先批次、点进去才看明细"；
 * · `submitArrival` 在"没有自定义行"时走 `ORDERS_API.arrivalConfirm`（自述「**全部按申请数到货**」）✗
 *   ⇒ 少到的会被**按申请数补齐** ⇒ 与"实际到多少就是到多少"**正面冲突** ✗；
 * · 明细只有"读"（`data-view="arrival-detail"` 渲染成只读清单）⇒ 她**改不了实际到货数量** ✗。
 *
 * ## 改后
 * · 第一屏 = **只有批次号 + 到货状态**（明细全部撤掉 ✓ 已到货的仍折叠 ✓）；
 * · **点开**那个折叠 ⇒ 拉 `GET /purchase/arrivals/detail?batchNo=…` ⇒ 每个尺码一行：
 *   货号 · 尺码 · **申请数量** · **实际到货数量输入**（默认 = 申请数量 ✓）；
 * · 提交**一律**走 `POST /purchase/arrivals/accept`，`lines` = **她填的实际值**（填 0 的那行**不提交** ✓）＋
 *   她自行补充的行 ✓ —— **没有任何"按申请数补齐"的路径** ✗；
 * · **挂不上批次的明细根本不进这一屏**（她追加口径 ✓）；**批次存在但读不到明细** ⇒ 人话（不许空白 ✗）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *  AC-RC1 第一屏**只有批次号**（页面里**不出现明细行**）✓
 *  AC-RC2 点批次 ⇒ 只显示**该批**明细（A 批的明细**不许**出现在 B 批里）✓
 *  AC-RC3 改数量 + 补一条额外尺码 ⇒ 提交 body **恰好**是她填的实际值 ✓
 *  AC-RC4 🔴 **实际 < 申请** ⇒ 提交的是**实际值**；**没有**任何按申请数补齐的路径 ✓
 *  AC-RC5 批次缺失 / detail 失败 / accept 失败 ⇒ 人话 + **不许假成功** ✓
 *  AC-RC6（她追加口径后**改过**）明细**挂不上批次** ⇒ **不出现在页面**；**批次无明细** ⇒ **人话** ✓
 *  AC-RC7 既有判据没放宽：`test/purchaseArrivalSubPage.test.js` 那**两条**哨兵经 Lead 放行更新（PR 里逐字写依据）✓
 *
 * ⚠️ 本文件是**新建**的（task-26 同时在动 `server/test/**` ⇒ 不去改别的文件 ✓）。
 * ⚠️ 加载方式与既有工作台用例**同一套**：把前端 ES 模块平铺复制成 `.mjs`、只改 import 文件名 ✓。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 去掉注释再判"代码里有没有某件事"（注释里提一句历史不算实现 ✓）。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 把前端 ES 模块复制成 `.mjs` 平铺到临时目录，只改 import 的文件名（既有做法 ✓）。 */
function loadOrdersModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-arrival-batch-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  return import(pathToFileURL(path.join(dir, 'orders-index.mjs')).href);
}

const BATCH_ROWS = [
  { record_id: 'r1', batch_no: 'CGD-WAIT-1', product_number: 'N05', size: 40, quantity: 2, arrival_status: '未到货' },
  { record_id: 'r2', batch_no: 'CGD-WAIT-1', product_number: 'N05', size: 41, quantity: 1, arrival_status: '未到货' },
  { record_id: 'r3', batch_no: 'CGD-WAIT-2', product_number: 'X99', size: 43, quantity: 3, arrival_status: '未到货' },
  { record_id: 'r4', batch_no: 'CGD-DONE-1', product_number: 'D1', size: 42, quantity: 1, arrival_status: '已到货' },
];

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC1 第一屏只有批次号（明细全部撤掉）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC1 ⭐ 第一屏**只出现批次号**（页面里不出现明细行）', async () => {
  const orders = await loadOrdersModule();
  const html = orders.purchaseOrdersHtml(BATCH_ROWS);
  // ① 批次号都在
  for (const batch of ['CGD-WAIT-1', 'CGD-WAIT-2', 'CGD-DONE-1']) {
    assert.ok(html.includes(batch), `批次 ${batch} 要出现 ✓`);
  }
  // ② 到货状态仍在（既有口径：来自采购主表那一行 ✓）
  assert.ok(html.includes('未到货') && html.includes('已到货'), '状态标签照旧 ✓');
  // ③ 🔴 **明细一行都不许在第一屏**
  assert.equal(/class="order-lines"/.test(html), false, '⭐ 第一屏不许铺明细（能真红：把列表加回来 ⇒ 红）');
  assert.equal(html.includes('line-product'), false, '货号明细不许出现在第一屏 ✗');
  assert.equal(html.includes('data-view="arrival-detail-row"'), false, '明细行要在"点开"之后才渲染 ✗');
  // ④ 但每张卡的**验收入口**照旧（既有交互不减少 ✓）
  assert.ok(html.includes('data-action="verify-arrival"'), '每张卡仍有验收入口 ✓');
  // ⑤ "点开才看明细"那句话在（文案走配置 ✓）
  const config = readWorkbench('config/orders.js');
  assert.ok(html.includes('data-view="arrival-detail-hint"'), '要有"点开看明细"的提示 ✓');
  assert.ok(config.includes('detailOpenHint'), '那句提示来自配置 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC2 点开某批 ⇒ 只显示该批的明细（每行带"实际到货数量"输入）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC2 ⭐ 点批次 ⇒ 明细只属于**这一批**（且每行有可改的"实际到货数量"，默认=申请数）', async () => {
  const orders = await loadOrdersModule();
  // 这一批的两条明细（= `GET .../arrivals/detail?batchNo=CGD-WAIT-1` 回的那两行）
  const detailA = [
    { item_no: 'N05', size: 40, quantity: 2, product_record_id: 'p1' },
    { item_no: 'N05', size: 41, quantity: 1, product_record_id: 'p1' },
  ];
  const htmlA = orders.arrivalDetailHtml(detailA);
  assert.equal((htmlA.match(/data-view="arrival-detail-row"/g) || []).length, 2, 'A 批只有两行 ✓');
  for (const size of [40, 41]) {
    assert.ok(htmlA.includes(`data-size="${size}"`), `${size} 码要在 A 批里 ✓`);
  }
  // 🔴 B 批的东西**一个字都不许**出现在 A 批这里（能真红：把两批拼一起 ⇒ 红）
  assert.equal(htmlA.includes('X99'), false, '⛔ A 批里不许有 B 批的货号');
  assert.equal(htmlA.includes('data-size="43"'), false, '⛔ A 批里不许有 B 批的尺码');
  // 每行一个"实际到货数量"输入，默认 = 申请数量（她要"改"，不是从空开始填 ✓）
  assert.equal((htmlA.match(/data-field="arrival-actual"/g) || []).length, 2, '每行一个实际数量输入 ✓');
  assert.match(htmlA, /data-size="40"[^>]*value="2"/, '40 码默认 = 申请数 2 ✓');
  assert.match(htmlA, /data-size="41"[^>]*value="1"/, '41 码默认 = 申请数 1 ✓');
  // 申请数量也要给她看（她要看"申请 vs 实际"）
  assert.ok(htmlA.includes('申请 2'), '申请数量要显示 ✓');
  // 拉明细的接口与参数逐字（既有只读口，不新造 ✗）
  const src = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(src.includes('${ARRIVAL_FULL_API.detail}?${ARRIVAL_FULL_FIELDS.batchNo}='),
    '点开时按 `batchNo` 调既有 `detail` 接口 ✓');
  assert.ok(src.includes('state.arrivalRowsByBatch'), '明细按批次存（A 批的别串到 B 批 ✗）✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC3 / AC-RC4 提交的就是"她填的实际值"——绝不按申请数补齐
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC3 ⭐ 改数量 + 补一条额外尺码 ⇒ 提交 body 恰好是"她填的实际值"', async () => {
  const orders = await loadOrdersModule();
  const built = orders.arrivalSubmitLines({
    rows: [
      { product_record_id: 'p1', size: 40, quantity: 2 },
      { product_record_id: 'p1', size: 41, quantity: 1 },
    ],
    // 她把 40 改成 2（原样）、41 改成 3（多到）—— 再补一条 42 码 1 双
    actuals: { 'p1|40': '2', 'p1|41': '3' },
    extra: [{ productRecordId: 'p1', size: 42, quantity: 1 }],
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.lines, [
    { productRecordId: 'p1', size: 40, quantity: 2 },
    { productRecordId: 'p1', size: 41, quantity: 3 },
    { productRecordId: 'p1', size: 42, quantity: 1 },
  ], '⭐ 提交的每条都是**她填的那个数** ✓（能真红）');
});

test('AC-RC4 🔴 **实际 < 申请** ⇒ 提交实际值；**没有任何"按申请数补齐"的路径**', async () => {
  const orders = await loadOrdersModule();
  const built = orders.arrivalSubmitLines({
    rows: [
      { product_record_id: 'p1', size: 40, quantity: 2 },
      { product_record_id: 'p1', size: 41, quantity: 5 },
    ],
    // 40 只到 1 双（申请 2）；41 **填 0** = 一双都没到
    actuals: { 'p1|40': '1', 'p1|41': '0' },
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.lines, [{ productRecordId: 'p1', size: 40, quantity: 1 }],
    '⭐ 少到就是少到：40 提交 1（**不是** 2）· 41 填 0 ⇒ **不提交那一行** ✓');
  // ⚠️ 「没填」（清空）与「填 0」是**两件事** ✗ —— 没填不猜（拦住 + 人话），不许当成"到了 0"
  const missing = orders.arrivalSubmitLines({
    rows: [{ product_record_id: 'p1', size: 40, quantity: 2 }], actuals: { 'p1|40': '' },
  });
  assert.equal(missing.ok, false, '清空 ⇒ **不猜**（拦住 ✓）');
  assert.equal(missing.reason, 'actual_missing');
  // 🔴 前端**不再有**"按申请数一键确认"的调用路径（能真红：把那句加回来 ⇒ 红）
  const src = stripComments(readWorkbench('features/orders/index.js'));
  assert.equal(src.includes('api.post(ORDERS_API.arrivalConfirm'), false,
    '⭐ 前端不许再调 confirm（= 全部按申请数到货）✗');
  assert.ok(src.includes('api.post(ARRIVAL_FULL_API.accept, {'), '一律走 accept ✓');
  assert.ok(src.includes('[ARRIVAL_FULL_FIELDS.lines]: built.lines'), '提交的是 built.lines（实际值 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC5 人话 + 不许假成功
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC5 批次缺失 / detail 失败 / accept 失败 ⇒ 人话；**不许假成功** ✗', async () => {
  const orders = await loadOrdersModule();
  // ① 明细空 ⇒ 配置里那句人话（不许空白 ✗）
  assert.ok(orders.arrivalDetailHtml([]).includes('这一批没有可验收的采购明细'), '批次无明细 ⇒ 人话 ✓');
  const config = readWorkbench('config/orders.js');
  const serverConfig = fs.readFileSync(path.join(__dirname, '../src/config/workbenchArrival.js'), 'utf8');
  for (const key of ['detailFailed', 'itemNoNotFound', 'sizeInvalid', 'accepted']) {
    assert.ok(config.includes(key), `前端配置里要有 ${key} 那句人话 ✓`);
  }
  // ⚠️ `batchMissing` / `acceptFailed` 的**真源在服务端那一份**（前端不重复抄一份 ✗）
  for (const key of ['batchMissing', 'acceptFailed', 'itemNoUnresolved', 'sizeInvalid', 'detailFailed']) {
    assert.ok(serverConfig.includes(key), `服务端配置里要有 ${key} 那句人话 ✓`);
  }
  const src = stripComments(readWorkbench('features/orders/index.js'));
  // ② detail 读失败 ⇒ 人话（既有口径）
  assert.ok(src.includes('ARRIVAL_FULL_TEXTS.detailFailed'), 'detail 读不到 ⇒ 人话 ✓');
  // ③ 提交失败 ⇒ 把后端那句原因如实渲染，**不许**自己说成功 ✗
  assert.ok(src.includes('renderResult(describeError(error), true)'), 'accept 失败 ⇒ 如实说 ✗ 不许假成功 ✓');
  // ④ 一个可提交的行都没有 ⇒ 拦住 + 人话（不空提交）
  assert.ok(src.includes('ARRIVAL_FULL_TEXTS.noArrivalLines'), '没有可提交的实际值 ⇒ 人话 ✓');
  // ⑤ 后端那句"已确认到货"只在**服务端回了成功**之后才显示（既有 `result.notice` 口径没动 ✓）
  assert.ok(src.includes('result.notice'), '成功提示仍以后端回执为准 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC6（她追加口径后**改过**）挂不上批次的明细 ⇒ 根本不进这一屏
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC6 ⭐ 明细**挂不上批次** ⇒ **不出现在页面**；**批次存在但没明细** ⇒ 人话', async () => {
  const orders = await loadOrdersModule();
  const html = orders.purchaseOrdersHtml([
    ...BATCH_ROWS,
    // 批次关联断掉的那些（#606 数据侧）—— 批次号空 / 旧的「（无批次号）」
    { record_id: 'o1', batch_no: '', product_number: 'ORPHAN-1', size: 44, quantity: 1, arrival_status: '' },
    { record_id: 'o2', batch_no: '（无批次号）', product_number: 'ORPHAN-2', size: 45, quantity: 1, arrival_status: '' },
  ]);
  assert.equal(html.includes('ORPHAN-1'), false, '⭐ 挂不上批次 ⇒ **不进页面**（能真红：把它渲染出来 ⇒ 红）');
  assert.equal(html.includes('ORPHAN-2'), false, '⭐「（无批次号）」组也不进页面 ✓');
  assert.equal(html.includes('（无批次号）'), false, '连那个键都不该再出现在页面上 ✓');
  // 正常批次照旧都在（别误伤 ✗）
  assert.ok(html.includes('CGD-WAIT-1') && html.includes('CGD-WAIT-2'), '有批次的照样显示 ✓');
  // 全都没有批次 ⇒ 空态人话（既有 `purchase-empty` 口径没动 ✓）
  assert.ok(orders.purchaseOrdersHtml([]).includes('purchase-empty'), '空列表 ⇒ 人话 ✓');
  // 源码哨兵：分组时**跳过**没有批次号的行（不是"留着 + 写说明" ✗）
  const src = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(src.includes('if (!key || key === NO_BATCH_KEY) continue;'),
    '⭐ 没有批次号 ⇒ 分组时直接跳过（能真红）✓');
});
