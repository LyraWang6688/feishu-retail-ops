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

// 采购日夹具：上海时区 2026-10-12 / 2026-10-11 的 0 点（epoch ms ⇒ 前端按上海自然日格式化）
const SH_DAY = (y, m, d) => Date.UTC(y, m - 1, d - 1, 16);
const BATCH_ROWS = [
  // 供应商甲 · 采购日 2026-10-12（两条明细 ⇒ 同一批）
  { record_id: 'r1', batch_no: 'CGD-WAIT-1', product_number: 'N05', size: 40, quantity: 2, arrival_status: '未到货', supplier_record_id: 's1', supplier_name: '供应商甲', arrival_created_at: SH_DAY(2026, 10, 12) },
  { record_id: 'r2', batch_no: 'CGD-WAIT-1', product_number: 'N05', size: 41, quantity: 1, arrival_status: '未到货', supplier_record_id: 's1', supplier_name: '供应商甲', arrival_created_at: SH_DAY(2026, 10, 12) },
  // 供应商乙 · 采购日 2026-10-11
  { record_id: 'r3', batch_no: 'CGD-WAIT-2', product_number: 'X99', size: 43, quantity: 3, arrival_status: '未到货', supplier_record_id: 's2', supplier_name: '供应商乙', arrival_created_at: SH_DAY(2026, 10, 11) },
  // 已到货 ⇒ 验收页**不渲染**（连 data 属性都不该有）
  { record_id: 'r4', batch_no: 'CGD-DONE-1', product_number: 'D1', size: 42, quantity: 1, arrival_status: '已到货', supplier_record_id: 's1', supplier_name: '供应商甲', arrival_created_at: SH_DAY(2026, 10, 12) },
];

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC1 第一屏只有批次号（明细全部撤掉）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC1 ⭐⭐ 验收页第一层=供应商卡片；点供应商后按采购日**由远及近**；不显示采购单号', async () => {
  const orders = await loadOrdersModule();
  // ① 第一层：只有供应商卡片（不渲染任何批次/日期/「已到货」）
  const first = orders.purchaseOrdersHtml(BATCH_ROWS);
  assert.ok(first.includes('data-action="pick-supplier"'), '第一层 = 可点的供应商卡片 ✓');
  assert.ok(first.includes('供应商甲') && first.includes('供应商乙'), '两个供应商都要出现 ✓');
  assert.equal(first.includes('data-purchase-batch'), false, '第一层不渲染批次卡 ✓');
  assert.equal(first.includes('采购日'), false, '第一层不渲染采购日 ✓');
  assert.equal(first.includes('已到货'), false, '⛔ 已到货一律不出现 ✓');
  assert.equal(first.includes('CGD-DONE-1'), false, '⛔ 已到货批次不许出现 ✓');
  // ② 第二层：选中供应商甲 ⇒ 只显示它自己的批次，按采购日（早→晚）分组
  const second = orders.purchaseOrdersHtml(BATCH_ROWS, { supplierKey: 's1' });
  assert.ok(second.includes('data-view="purchase-supplier"'), '第二层有供应商分组容器 ✓');
  assert.ok(second.includes('供应商甲'), '显示选中的供应商名 ✓');
  assert.equal(second.includes('供应商乙'), false, '第二层不显示别的供应商 ✓');
  assert.equal(second.includes('采购日'), false, '⛔ 不出现「采购日」三个字（业务负责人批注）✓');
  assert.ok(second.includes('>2026-10-12<'), '⭐ 仍要有日期（只显示日期本身）✓');
  assert.equal(second.includes('返回供应商'), false, '⛔ 不需要「返回供应商」按钮（批注）✓');
  assert.equal(second.includes('data-action="back-suppliers"'), false, '返回按钮元素不许回来 ✓');
  assert.equal(second.includes('未到货'), false, '⛔ 此页都是未到货 ⇒ 不再显示「未到货」标签（批注）✓');
  assert.ok(second.includes('data-purchase-batch'), '第二层才有批次卡 ✓');
  assert.ok(second.includes('data-action-block="verify-arrival"'), '每批仍有验收入口 ✓');
  assert.ok(second.includes('data-view="arrival-batch-summary"'), '有一行摘要（多少双/几个货品）✓');
  // ③ **由远及近**（早 → 晚）：给同一供应商补一条更早的批次（日期不再显示，但顺序仍要由远及近）
  const earlier = {
    ...BATCH_ROWS[2], record_id: 'r5', batch_no: 'CGD-WAIT-3',
    supplier_record_id: 's1', supplier_name: '供应商甲', arrival_created_at: SH_DAY(2026, 10, 11),
  };
  const ordered = orders.purchaseOrdersHtml([...BATCH_ROWS, earlier], { supplierKey: 's1' });
  const earlyAt = ordered.indexOf('>2026-10-11<');
  const lateAt = ordered.indexOf('>2026-10-12<');
  assert.ok(earlyAt >= 0 && lateAt >= 0, '两个日期标题都要出现 ✓');
  assert.ok(earlyAt < lateAt, '⭐ 由远及近：10-11 在 10-12 上面（早→晚）✓');
  // 供应商名居中（批注）
  const css = readWorkbench('features/orders/orders.css');
  assert.ok(css.includes('text-align: center'), '供应商名居中样式在 ✓');
  // ⭐ 2026-11-09 批注：展开后不再显示「验收到货」按钮和「点开看明细」提示
  assert.ok(css.includes('.action-form[open] > summary'), '展开后隐藏入口按钮的样式在 ✓');
  assert.ok(css.includes('.action-form[open] [data-view="arrival-detail-hint"]'), '展开后隐藏提示文字的样式在 ✓');
  assert.ok(css.includes('.form-field.action-form__amount { display: flex'), '实际金额与输入框同一行 ✓');
  assert.ok(readWorkbench('config/orders.js').includes("arrivalAmount: '货款'"), '金额字段文案 = 「货款」（业务负责人 2026-11-09）✓');
  // ④ **采购单号不许作为可见文字出现**（data 属性留给提交用，页面看不到）
  for (const batch of ['CGD-WAIT-1', 'CGD-WAIT-2', 'CGD-WAIT-3']) {
    assert.equal(second.includes(`>${batch}<`), false, `${batch} 不许作为可见文字 ✗`);
    assert.equal(ordered.includes(`>${batch}<`), false, `${batch} 不许作为可见文字 ✗`);
  }
  assert.equal(/class="order-no"/.test(second), false, '不许再有"批次号标题"那个元素 ✗');
  // ⑤ 一个未到货批次都没有 ⇒ 空态人话（不是空白）
  const onlyArrived = orders.purchaseOrdersHtml([BATCH_ROWS[3]]);
  assert.ok(onlyArrived.includes('data-view="purchase-empty"'), '没有未到货批次 ⇒ 空态 ✓');
  assert.ok(onlyArrived.includes('当前没有未到货的批次'), '空态人话走配置 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC1c 第一层固定展示「供应商管理」全部供应商（没有未到货也出现）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC1c ⭐ 第一层固定展示供应商管理全部供应商（没有未到货也出现 + 空态）', async () => {
  const orders = await loadOrdersModule();
  const suppliers = [
    { record_id: 's1', name: '供应商甲' },
    { record_id: 's2', name: '供应商乙' },
    { record_id: 's3', name: '供应商丙' }, // 没有未到货批次 ⇒ 也要固定出现
  ];
  const html = orders.purchaseOrdersHtml(BATCH_ROWS, { suppliers });
  assert.equal((html.match(/data-action="pick-supplier"/g) || []).length, 3,
    '配置表 3 个供应商 ⇒ 3 张卡片（不管有没有未到货）✓');
  assert.ok(html.includes('供应商丙'), '没有未到货的供应商也要出现 ✓');
  assert.ok(html.includes('暂无未到货'), '没有未到货时卡片摘要 = 配置文案 ✓');
  assert.ok(html.includes('供应商甲'), '有未到货的供应商照旧 ✓');
  // 点进"没有未到货"的供应商 ⇒ 第二层空态（不渲染任何批次卡）
  const empty = orders.purchaseOrdersHtml(BATCH_ROWS, { suppliers, supplierKey: 's3' });
  assert.ok(empty.includes('供应商丙'), '空态里仍显示供应商名 ✓');
  assert.ok(empty.includes('这个供应商暂时没有未到货的批次'), '空态人话走配置 ✓');
  assert.equal(empty.includes('data-purchase-batch'), false, '没有未到货 ⇒ 不渲染批次卡 ✓');
  // 配置表读不到（suppliers 为空）⇒ 退回原来的"有未到货的供应商"，页面不空白
  const fallback = orders.purchaseOrdersHtml(BATCH_ROWS, { suppliers: [] });
  assert.ok(fallback.includes('供应商甲') && fallback.includes('供应商乙'), '无配置表时按未到货供应商兜底 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC1d ⭐ 同一批次号混多家供应商 ⇒ 按采购明细的供应商**拆成不同验收卡**（采购侧仍一个批次号）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC1d ⭐ 一批多供应商 ⇒ 按供应商拆卡；每张卡只含该供应商的明细子集', async () => {
  const orders = await loadOrdersModule();
  const base = { ...BATCH_ROWS[0], batch_no: 'CGD-MULTI' };
  const rows = [
    { ...base, supplier_record_id: 's1', supplier_name: '一代千金', size: 38, quantity: 2 },
    { ...base, supplier_record_id: 's1', supplier_name: '一代千金', size: 39, quantity: 1 },
    { ...base, supplier_record_id: 's2', supplier_name: '信踏', size: 40, quantity: 4 },
  ];
  // 验收单位 = 批次 × 供应商（同一批次号不再整批归到第一行那家）
  const units = orders.groupAcceptanceUnits(rows);
  assert.equal(units.length, 2, '一批两家供应商 ⇒ 2 个验收单位 ✓');
  assert.equal(units.find((u) => u.supplier_key === 's1').rows.length, 2, '一代千金卡只含自己 2 行 ✓');
  assert.equal(units.find((u) => u.supplier_key === 's2').rows.length, 1, '信踏卡只含自己 1 行 ✓');
  // 第一层：两张供应商卡，各自数量不互相混
  const first = orders.purchaseOrdersHtml(rows);
  assert.ok(first.includes('data-supplier-key="s1"') && first.includes('data-supplier-key="s2"'),
    '两家供应商都固定出现 ✓');
  assert.ok(first.includes('1 批 · 3 双待验收'), '一代千金 = 自己 3 双 ✓');
  assert.ok(first.includes('1 批 · 4 双待验收'), '信踏 = 自己 4 双 ✓');
  // 第二层：点一代千金 ⇒ 只有一张卡（3 双），不带信踏的货
  const s1 = orders.purchaseOrdersHtml(rows, { supplierKey: 's1' });
  assert.equal((s1.match(/data-purchase-batch=/g) || []).length, 1, '一代千金在这批只出一张卡 ✓');
  assert.ok(s1.includes('data-purchase-supplier="s1"')); 
  assert.ok(s1.includes('3 双'), '卡片摘要按本供应商明细算（3 双）✓');
  assert.equal(s1.includes('信踏'), false, '一代千金的卡里不混另一家的供应商名 ✓');
  assert.ok(s1.includes('data-arrival-supplier="s1"'), '提交按钮带供应商范围 ✓');
  const s2 = orders.purchaseOrdersHtml(rows, { supplierKey: 's2' });
  assert.ok(s2.includes('4 双'), '信踏卡摘要按自己的明细算（4 双）✓');
  // ⭐ 已验收完的供应商（任务 posted）⇒ 卡片隐掉；另一家继续显示
  const unitsAfter = orders.groupAcceptanceUnits(rows, { 'CGD-MULTI': ['s1'] });
  assert.equal(unitsAfter.length, 1, 's1 验收完 ⇒ 只剩 s2 一个单位 ✓');
  assert.equal(unitsAfter[0].supplier_key, 's2');
  const afterHtml = orders.purchaseOrdersHtml(rows, { acceptedSuppliers: { 'CGD-MULTI': ['s1'] } });
  assert.equal(afterHtml.includes('data-supplier-key="s1"'), false, '已验收的 s1 卡片不再出现 ✓');
  assert.ok(afterHtml.includes('data-supplier-key="s2"'), '未验收的 s2 卡片继续出现 ✓');
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
  // ⭐ 2026-11-09（业务负责人）：「申请 / 报货」的字样和数量提示都不需要 ——
  //   输入框默认值就是报货数量，尺码格只留尺码 + 输入。
  assert.equal(htmlA.includes('申请'), false, '⛔ 不再出现「申请」✓');
  assert.equal(htmlA.includes('报货'), false, '⛔ 不再出现「报货」✓');
  assert.equal(htmlA.includes('pr-sale'), false, '⛔ 不再显示额外的数量提示 ✓');
  assert.ok(htmlA.includes('3 双'), '货号卡片右上角保留合计双数（2+1=3 双）✓');
  // ⭐ 2026-11-09（业务负责人「套用采购页模板」）：明细 = 采购页的卡片/尺码格/步进器
  assert.ok(htmlA.includes('class="pr-group'), '明细组套用采购页 `.pr-group` 卡片 ✓');
  assert.ok(htmlA.includes('class="pr-size-row"'), '尺码格套用 `.pr-size-row` ✓');
  assert.ok(htmlA.includes('class="pr-stepper"'), '数量控件套用 `.pr-stepper` ✓');
  assert.ok(htmlA.includes('data-action="arrival-step"'), '有 +/− 步进按钮 ✓');
  // 拉明细的接口与参数逐字（既有只读口，不新造 ✗）
  const src = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(src.includes('ARRIVAL_FULL_API.detail') && src.includes('ARRIVAL_FULL_FIELDS.batchNo'),
    '点开时按 `batchNo` 调既有 `detail` 接口 ✓');
  assert.ok(src.includes('ARRIVAL_FULL_FIELDS.supplierRecordId'), '拆卡后明细还要带供应商范围 ✓');
  assert.ok(src.includes('state.arrivalRowsByBatch'), '明细按「批次 × 供应商」存（不许串 ✗）✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC2b ⭐ 同一批次内：明细**按编号分组**（编号只出现一次，尺码在组内）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC2b ⭐ 同一批次里按编号分组：一个编号一个组，组内按尺码给实际数量', async () => {
  const orders = await loadOrdersModule();
  const html = orders.arrivalDetailHtml([
    { item_no: 'N05', color: '黑色', size: 41, quantity: 1, product_record_id: 'p1' },
    { item_no: 'N05', color: '黑色', size: 40, quantity: 2, product_record_id: 'p1' },
    { item_no: 'X99', color: '白色', size: 43, quantity: 3, product_record_id: 'p2' },
  ]);
  const groups = html.match(/data-view="arrival-line-group"/g) || [];
  assert.equal(groups.length, 2, '两个编号 ⇒ 两个分组 ✓');
  assert.ok(html.includes('data-item-no="N05"') && html.includes('data-item-no="X99"'), '编号挂在分组上 ✓');
  // ⭐ 显示口径跟采购页卡片标题一致 =「货号 · 颜色」
  assert.ok(html.includes('N05 · 黑色') && html.includes('X99 · 白色'), '分组标题 = 「货号 · 颜色」✓');
  // 编号只出现一次（组标题）；每行不再重复编号
  assert.equal((html.match(/>N05</g) || []).length, 0, '行内不重复编号 ✗');
  // 组内尺码 / 实际数量输入都在（提交要用 data-*，不许丢）
  assert.ok(html.includes('data-size="40"') && html.includes('data-size="41"') && html.includes('data-size="43"'));
  assert.equal((html.match(/data-field="arrival-actual"/g) || []).length, 3, '每行一个实际数量输入 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC3 / AC-RC4 提交的就是"她填的实际值"——绝不按申请数补齐
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC3 ⭐ 改数量 ⇒ 提交 body 恰好是"她填的实际值"（不再有自定义补行）', async () => {
  const orders = await loadOrdersModule();
  const built = orders.arrivalSubmitLines({
    rows: [
      { product_record_id: 'p1', size: 40, quantity: 2 },
      { product_record_id: 'p1', size: 41, quantity: 1 },
    ],
    // 她把 40 改成 2（原样）、41 改成 3（多到）
    actuals: { 'p1|40': '2', 'p1|41': '3' },
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.lines, [
    { productRecordId: 'p1', size: 40, quantity: 2 },
    { productRecordId: 'p1', size: 41, quantity: 3 },
  ], '⭐ 提交的每条都是**她填的那个数** ✓（不再接受自定义补行 ✗）');
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
  for (const key of ['detailFailed', 'sizeInvalid', 'accepted']) {
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
  // ⑤ 成功后**回工作台 + 统一 toast**（服务端必回 redirect_url；前端 assign）
  assert.ok(src.includes('window.location.assign(result.redirect_url)'), '成功后回工作台（统一 toast）✓');
  assert.ok(src.includes('if (!result?.redirect_url) throw new Error(ARRIVAL_FULL_TEXTS.redirectMissing)'),
    '没有 redirect_url ⇒ 按失败报错（不保留"留在本页"的旧兜底）✓');
  assert.equal(src.includes('result.notice'), false, '⛔ 不再回退到本页 renderResult 兜底 ✓');
  assert.ok(readWorkbench('config/orders.js').includes('redirectMissing:'), '缺失回执的失败文案走配置 ✓');
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
  assert.ok(html.includes('供应商甲') && html.includes('供应商乙'), '有批次的供应商照样显示（第一层卡片）✓');
  // 全都没有批次 ⇒ 空态人话（既有 `purchase-empty` 口径没动 ✓）
  assert.ok(orders.purchaseOrdersHtml([]).includes('purchase-empty'), '空列表 ⇒ 人话 ✓');
  // 源码哨兵：分组时**跳过**没有批次号的行（不是"留着 + 写说明" ✗）
  const src = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(src.includes('if (!key || key === NO_BATCH_KEY) continue;'),
    '⭐ 没有批次号 ⇒ 分组时直接跳过（能真红）✓');
});

test('AC-RC2c ⭐ 移动端明细：去掉外层卡片容器；一行两码且尺码与数量选择器同一行', () => {
  const css = readWorkbench('features/orders/orders.css');
  assert.ok(css.includes('[data-view="purchase-acceptance"] .action-form[open]'), '展开态去掉 action-form 内边距/边框 ✓');
  assert.ok(css.includes('[data-view="purchase-acceptance"] .pr-group.order-line-group'), '货号组不再套外层卡片容器 ✓');
  const rowRule = css.slice(css.indexOf('[data-view="purchase-acceptance"] .pr-group.order-line-group .pr-size-row {'));
  assert.ok(rowRule.includes('flex-direction: row'), '尺码与数量选择器同一行 ✓');
  assert.ok(rowRule.includes('width: calc(50% - var(--space-1))'), '仍然一行两个尺码 ✓');
  assert.ok(css.includes('.order-card.order-card--detail-open'), '展开后去掉批次卡容器（padding/border/background/shadow）✓');
  assert.ok(readWorkbench('features/orders/index.js').includes("classList.toggle('order-card--detail-open'"), '展开态切类由 JS 挂上 ✓');
});

test('AC-RC6 ⭐ 货款必填（参考销售货品页）：required + 未填/<=0 不发请求、聚焦输入框 + 字段旁提示', () => {
  const src = readWorkbench('features/orders/index.js');
  const config = readWorkbench('config/orders.js');
  assert.ok(src.includes('data-field="arrival-amount" type="text" inputmode="decimal" required'),
    '金额输入框带 required ✓');
  assert.ok(src.includes('data-view="arrival-amount-hint"'), '字段旁有必填提示位 ✓');
  assert.ok(src.includes('reportValidity'), '未填时调用原生校验提示 ✓');
  assert.ok(src.includes("'[data-field=\"arrival-amount\"]'") && src.includes('amountInput?.focus()'),
    '未填时聚焦金额输入框 ✓');
  assert.ok(config.includes('amountRequired:'), '必填文案走配置 ✓');
  // 校验发生在 runWriteAction 之前（不发请求）；顺序：amount 判断在 runWriteAction 之前
  const amountCheck = src.indexOf('amountHint.textContent = ARRIVAL_FULL_TEXTS.amountRequired');
  const writeAction = src.indexOf('return runWriteAction(button', src.indexOf('async function submitArrival'));
  assert.ok(amountCheck > 0 && writeAction > amountCheck, '金额校验在发请求之前 ✓');
});
