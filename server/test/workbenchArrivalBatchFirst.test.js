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
  copy('features/orders/acceptanceDoc.js', 'acceptanceDoc.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
    ["from './acceptanceDoc.js'", "from './acceptanceDoc.mjs'"],
  ]);
  return import(pathToFileURL(path.join(dir, 'orders-index.mjs')).href);
}

// 采购日夹具：上海时区 2026-10-12 / 2026-10-11 的 0 点（epoch ms ⇒ 前端按上海自然日格式化）
const SH_DAY = (y, m, d) => Date.UTC(y, m - 1, d - 1, 16);
const BATCH_ROWS = [
  // 供应商甲 · 采购日 2026-10-12（两条明细 ⇒ 同一批）
  { record_id: 'r1', batch_no: 'CGD-WAIT-1', product_number: 'N05', size: 40, quantity: 2, behavior_code: 'PURCHASE_ORDER', behavior_name: '报货', supplier_record_id: 's1', supplier_name: '供应商甲', arrival_created_at: SH_DAY(2026, 10, 12) },
  { record_id: 'r2', batch_no: 'CGD-WAIT-1', product_number: 'N05', size: 41, quantity: 1, behavior_code: 'PURCHASE_ORDER', behavior_name: '报货', supplier_record_id: 's1', supplier_name: '供应商甲', arrival_created_at: SH_DAY(2026, 10, 12) },
  // 供应商乙 · 采购日 2026-10-11
  { record_id: 'r3', batch_no: 'CGD-WAIT-2', product_number: 'X99', size: 43, quantity: 3, behavior_code: 'PURCHASE_ORDER', behavior_name: '报货', supplier_record_id: 's2', supplier_name: '供应商乙', arrival_created_at: SH_DAY(2026, 10, 11) },
  // 已到货 ⇒ 验收页**不渲染**（连 data 属性都不该有）
  { record_id: 'r4', batch_no: 'CGD-DONE-1', product_number: 'D1', size: 42, quantity: 1, behavior_code: 'PURCHASE_IN', behavior_name: '入库', supplier_record_id: 's1', supplier_name: '供应商甲', arrival_created_at: SH_DAY(2026, 10, 12) },
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
  assert.ok(second.includes('data-action="open-arrival"'), '每批有独立验收页跳转入口 ✓');
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
  // 2026-11-19：批次卡改为跳转独立明细页，不再原地展开。
  assert.ok(second.includes('/workbench/purchase-acceptance-detail.html?'), '验收入口指向独立明细页 ✓');
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
// AC-RC1c 第一层只展示当前有未到货批次的供应商
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC1c ⭐ 第一层只出现有未到货批次的供应商', async () => {
  const orders = await loadOrdersModule();
  const suppliers = [
    { record_id: 's1', name: '供应商甲' },
    { record_id: 's2', name: '供应商乙' },
    { record_id: 's3', name: '供应商丙' }, // 没有未到货批次 ⇒ 不出现
  ];
  const html = orders.purchaseOrdersHtml(BATCH_ROWS, { suppliers });
  assert.equal((html.match(/data-action="pick-supplier"/g) || []).length, 2,
    '只有两家有未到货 ⇒ 两张卡片（不再显示全部供应商）✓');
  assert.equal(html.includes('供应商丙'), false, '没有未到货的供应商不出现 ✓');
  assert.ok(html.includes('供应商甲') && html.includes('供应商乙'), '有未到货的供应商照旧 ✓');
  const fallback = orders.purchaseOrdersHtml(BATCH_ROWS, { suppliers: [] });
  assert.ok(fallback.includes('供应商甲') && fallback.includes('供应商乙'), '没有供应商配置时按未到货供应商出现 ✓');
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
  assert.ok(s1.includes('supplierRecordId=s1'), '跳转链接带供应商范围 ✓');
  const s2 = orders.purchaseOrdersHtml(rows, { supplierKey: 's2' });
  assert.ok(s2.includes('4 双'), '信踏卡摘要按自己的明细算（4 双）✓');
  // 不再依赖本地 accepted-suppliers 接口/参数
  const src = readWorkbench('features/orders/index.js');
  assert.equal(src.includes('/purchase/arrivals/accepted-suppliers'), false, '前端源码不再调本地 accepted-suppliers 端点 ✓');
  assert.equal(readWorkbench('config/orders.js').includes('acceptedSuppliers'), false,
    '前端配置不再有 accepted-suppliers 端点 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC2 点开某批 ⇒ 只显示该批的明细（每行带"实际到货数量"输入）
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

test('AC-RC6 ⭐ 明细**挂不上批次** ⇒ **不出现在页面**；**批次存在但没明细** ⇒ 人话', async () => {
  const orders = await loadOrdersModule();
  const html = orders.purchaseOrdersHtml([
    ...BATCH_ROWS,
    // 批次关联断掉的那些（#606 数据侧）—— 批次号空 / 旧的「（无批次号）」
    { record_id: 'o1', batch_no: '', product_number: 'ORPHAN-1', size: 44, quantity: 1, behavior_code: '', behavior_name: '' },
    { record_id: 'o2', batch_no: '（无批次号）', product_number: 'ORPHAN-2', size: 45, quantity: 1, behavior_code: '', behavior_name: '' },
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

test('AC-RC6 ⭐ 货款必填（独立明细页）：required + 未填/<=0 不发请求、聚焦输入框 + 字段旁提示', () => {
  const src = readWorkbench('features/acceptance-detail/index.js');
  const config = readWorkbench('config/orders.js');
  assert.ok(src.includes('data-field="arrival-amount" type="text" inputmode="decimal" required'),
    '金额输入框带 required ✓');
  assert.ok(src.includes('data-view="arrival-amount-hint"'), '字段旁有必填提示位 ✓');
  assert.ok(src.includes('reportValidity'), '未填时调用原生校验提示 ✓');
  assert.ok(src.includes("'[data-field=\"arrival-amount\"]'") && src.includes('?.focus()'),
    '未填时聚焦金额输入框 ✓');
  assert.ok(config.includes('amountRequired:'), '必填文案走配置 ✓');
  const amountCheck = src.indexOf('amountRequired');
  const postCheck = src.indexOf('ARRIVAL_FULL_API.accept');
  assert.ok(amountCheck > 0 && postCheck > amountCheck, '金额校验在发请求之前 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RC8 ⭐ 验收单：拍照/选图上传 → 主表「对方单据」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RC8 ⭐ 验收单一行：file input 支持拍照/选图；上传后随 accept 提交（我的单据保持不变）', async () => {
  const src = readWorkbench('features/acceptance-detail/index.js');
  const docModule = readWorkbench('features/orders/acceptanceDoc.js');
  assert.ok(src.includes('arrivalDocFieldHtml('), '验收单上传行走配置文案 ✓');
  assert.ok(src.includes('uploadArrivalDocuments('), '提交时调用验收单上传 ✓');
  assert.ok(src.includes('counterpartyDocuments: uploaded.documents'), 'accept body 带验收单 tokens ✓');
  assert.ok(docModule.includes('api.postRaw(endpoint, file)'), '验收单先上传拿 file_token ✓');

  const config = readWorkbench('config/orders.js');
  assert.ok(config.includes("acceptanceDoc: '/api/workbench/purchase/arrivals/acceptance-doc'"),
    '验收单上传端点走配置 ✓');
  assert.ok(config.includes("counterpartyDocuments: 'counterpartyDocuments'"),
    '验收单提交字段走配置 ✓');
  assert.ok(docModule.includes('data-field="arrival-doc"') && docModule.includes('multiple'),
    '验收单 file input 支持多张 ✓');
});


test('AC-RC9 验收单必填：未选图不发请求，字段旁提示并聚焦', () => {
  const src = readWorkbench('features/acceptance-detail/index.js');
  const config = readWorkbench('config/orders.js');
  const doc = readWorkbench('features/orders/acceptanceDoc.js');
  assert.ok(doc.includes('data-field="arrival-doc"') && doc.includes('required aria-required="true"'),
    '验收单 file input 必填 ✓');
  assert.ok(config.includes('acceptanceDocRequired:'), '必填文案走配置 ✓');
  assert.ok(src.includes('validateArrivalDocuments(form, ARRIVAL_FULL_TEXTS)'), '未选图时调用必填校验 ✓');
  assert.ok(doc.includes('texts.acceptanceDocRequired') && doc.includes("input?.focus()") && doc.includes('input.reportValidity()'),
    '未选图时聚焦并触发原生校验 ✓');
  const docCheck = src.indexOf('validateArrivalDocuments(form, ARRIVAL_FULL_TEXTS)');
  const postCheck = src.indexOf('ARRIVAL_FULL_API.accept');
  assert.ok(docCheck > 0 && postCheck > docCheck, '验收单校验在发请求之前 ✓');
});
