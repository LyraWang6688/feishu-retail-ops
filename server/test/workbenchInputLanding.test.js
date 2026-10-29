'use strict';

/**
 * ⭐⭐ 2026-10-16（Lead 放行："把建议 ① 建成真用例"）—— **落点哨兵**
 *
 * 起因（写在文件里当范例 ✗）：「**到货说明**」那个输入框当时**收了值、代码里没有任何落点** ✗ ——
 *   它一路走到 `purchaseArrivalConversationService` 的草稿，而「验收原话」**那一列 2026-10-09 已被她从真表删掉**
 *   ⇒ **写进一个不存在的东西**，而且**没人发现**，直到她追问 ✓
 *   ⭐ **它当时会在这里红**：提交键在、可**落点列在 schema 里根本不存在** ⇒ 红 ✓（现在整条已删：#651 ✓）
 *
 * 本哨兵钉**四跳链**（工作台每个提交键）：① 前端真的发出去 → ② 路由真的读到 → ③ 服务真的消费 →
 *   ④ **落到某表某列**（该列在 `V1_BITABLE_SCHEMA` 里真的存在）⇒ **任一环断了就红** ✓
 * ⇒ ⭐ **新增输入若说不出"落在哪张表哪一列"** ⇒ **必须红** ✗（`PENDING_LANDING` 也不收 ✓）
 *
 * 🔴 只读：**不改 `server/src/**` 一个字** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const FEATURE_DIR = 'public/workbench/features';

/** 前端实际发出的每一次 POST（`api.post(<目标>, …)`）—— 从源码取，**不靠人肉维护** ✓ */
const submittedTargets = () => {
  const out = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) {
        for (const m of read(rel).matchAll(/api\.post\(\s*([^,\n]+)/g)) out.add(m[1].trim());
      }
    }
  };
  walk(FEATURE_DIR);
  return [...out].sort();
};

/** ⭐ 已核的四跳链（每条都真核过 ✓）；`landing` = [表语义键, 列语义键]，断言该列真的在 schema 里 ✓ */
const CHAINS = Object.freeze({
  'ARRIVAL_FULL_API.accept': {
    fe: 'features/orders/index.js', feKey: 'ARRIVAL_FULL_API.accept',
    // ⭐ 2026-10-16：注册处是**变量路径**（不是字面量 ✗）——
    //    `src/routes/workbench.js:252` 的 `router.post(arrivalTab.api.accept, …)`，
    //    而 `arrivalTab.api.accept` = `config/workbenchArrival.js` 的 '/purchase/arrivals/accept' ✓
    //    ⚠️ 这条是我 grep 了三轮才核到的（先以为是别的 router / catch-all ✗）⇒ 断言必须认"变量路径"这种形状 ✓
    route: 'src/routes/workbench/purchase.js', routeKey: /router\.post\(arrivalTab\.api\.accept/,
    config: 'src/config/workbenchArrival.js', configKey: /accept: '\/purchase\/arrivals\/accept'/,
    service: 'src/services/workbenchPurchaseArrivalService.js', serviceKey: /async confirmArrival\(\{ batchNo, actualAmount/,
    landing: [['purchaseOrderBatch', 'actualAmount'], ['purchaseOrderBatch', 'arrivalStatus'], ['liveInventory', 'stockKey']],
  },


  // ⭐ 2026-10-28（采购页进入生产）：采购页提交 = **多货品**那条既有链路。
  //    前端目标在 `config.endpoints.submit`（配置先行 ⇒ 源码里是变量路径，不是字面量）
  //    ④ 落点只读核过：`publishPurchaseRequest` 写「报货批次」(batchNo / 供应商 / 发生行为)
  //    ＋「采购明细」(数量 / 幂等键 / 采购明细ID) —— 列都在 schema 里真实存在。
  'config.endpoints.submit': {
    fe: 'features/procurement/api.js', feKey: 'api.post(config.endpoints.submit',
    route: 'src/routes/workbench/purchase.js', routeKey: /router\.post\(PROCUREMENT_PAGE\.endpoints\.submit/,
    service: 'src/services/procurementPageSubmitService.js', serviceKey: /engine\.submitDraft\(/,
    landing: [
      ['purchaseOrderBatch', 'batchNo'], ['purchaseOrderBatch', 'behavior'],
      ['purchaseRequest', 'quantity'], ['purchaseRequest', 'idempotencyKey'],
      ['purchaseRequest', 'detailId'], ['purchaseRequest', 'supplier'],
    ],
  },
  "'/api/workbench/sales/delivery/deliveries'": {
    fe: 'features/sales-delivery/index.js', feKey: "'/api/workbench/sales/delivery/deliveries'",
    route: 'src/routes/workbenchSalesDelivery.js', routeKey: /router\.post\('\/sales\/delivery\/deliveries'[\s\S]{0,600}?req\.body\?\.detailRecordIds/,
    service: 'src/services/salesDeliveryService.js', serviceKey: /deliver\(/,
    landing: [['salesDetail', 'fulfillmentStatus'], ['liveInventory', 'stockKey']],
  },
  "'/api/workbench/sales/delivery/payments'": {
    fe: 'features/sales-delivery/index.js', feKey: "'/api/workbench/sales/delivery/payments'",
    route: 'src/routes/workbenchSalesDelivery.js', routeKey: /router\.post\('\/sales\/delivery\/payments'[\s\S]{0,600}?req\.body\?\.method/,
    service: 'src/services/salesDeliveryPaymentService.js', serviceKey: /const pay = async/,
    landing: [['paymentRecord', 'amount'], ['paymentRecord', 'status'], ['paymentRecord', 'method'], ['paymentRecord', 'receivedAt'], ['paymentRecord', 'tradeDirection']],
  },
  "'/api/workbench/inventory/adjustments/count'": {
    fe: 'features/inventory/adjustment.js', feKey: '/api/workbench/inventory/adjustments/count',
    route: 'src/routes/workbenchInventoryAdjustment.js', routeKey: /count/i,
    service: 'src/services/inventoryAdjustmentService.js', serviceKey: /count/i,
    landing: [['liveInventory', 'stockKey'], ['inventoryLedger', 'quantityChange']],
  },
  "'/api/workbench/inventory/adjustments/season'": {
    fe: 'features/inventory/adjustment.js', feKey: '/api/workbench/inventory/adjustments/season',
    route: 'src/routes/workbenchInventoryAdjustment.js', routeKey: /season/i,
    service: 'src/services/inventoryAdjustmentService.js', serviceKey: /season|state/i,
    landing: [['liveInventory', 'state'], ['inventoryLedger', 'quantityChange']],
  },
});

/**
 * ⚠️ **已登记、但本刀还没核到列**的提交 —— **如实登记**（≠"没问题" ✓）：
 * 要加新输入 ⇒ 必须先在这里登记**并**去核落点，否则 AC-LANDING-1 红 ✓
 */
const PENDING_LANDING = Object.freeze([
  'SCAN_PRINT_ENDPOINTS.report', 'SCAN_PRINT_ENDPOINTS.jobs',
  "'/api/workbench/label-print/jobs'",
]);

test('AC-LANDING-1 ⭐⭐ 每个提交键都得"说得出来落到哪张表哪一列"（新增输入 ⇒ 先登记 + 核落点 ⇒ 否则红 ✗）', () => {
  const unknown = submittedTargets().filter((t) => !(t in CHAINS) && !PENDING_LANDING.includes(t));
  assert.deepEqual(unknown, [],
    `⛔ 这些提交键**没有登记落点** ⇒ 加新输入前必须写清"落到哪张表哪一列" ✗：${unknown.join(' / ')}`);
});

test('AC-LANDING-2 ⭐ 已核的每条链四跳都在（前端 → 路由 → 服务 → **落点列存在**）—— 任一环断了就红 ✓', () => {
  for (const [target, chain] of Object.entries(CHAINS)) {
    const fe = read(`${FEATURE_DIR}/${chain.fe.replace(/^features\//, '')}`);
    assert.ok(fe.includes(chain.feKey), `① 前端没有发出 ${target} ✗`);
    assert.match(read(chain.route), chain.routeKey, `② 路由没读到 ${target} 的入参 ✗`);
    assert.match(read(chain.service), chain.serviceKey, `③ 服务没消费 ${target} ✗`);
    if (chain.config) assert.match(read(chain.config), chain.configKey, `②b 端点常量对不上 ${target} ✗`);
    for (const [table, column] of chain.landing) {
      const tableDef = V1_BITABLE_SCHEMA.tables[table];
      assert.ok(tableDef, `④ 落点表 ${table} 不存在 ✗`);
      assert.ok(tableDef.fields[column],
        `④ 落点列 \`${table}.${column}\` 不存在 ⇒ 这正是「到货说明」当时那种"写进不存在的东西" ✗（${target}）`);
    }
  }
});

test('AC-LANDING-3 ⭐ 范例：把"到货说明"那种形状塞回来 ⇒ **红**（反向钉住 ✓）', () => {
  const batch = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  assert.equal(Object.prototype.hasOwnProperty.call(batch, 'acceptanceText'), false,
    '⭐「验收原话」那一列**确实**已不在 schema 里 ✓（她 2026-10-09 删的）⇒ 当时那个提交键在这里就会红 ✓');
  const missing = (table, column) => !V1_BITABLE_SCHEMA.tables[table]?.fields?.[column];
  assert.equal(missing('purchaseOrderBatch', 'acceptanceText'), true, '那条当时会红 ✓（这就是哨兵的意义）');
  assert.equal(missing('purchaseOrderBatch', 'actualAmount'), false, '而现在的落点（发生金额）是真列 ✓');
});

test('AC-LANDING-4 ⭐ 只读筛选**不许**出现在提交体里（防"筛选参数被误存进表" ✗）', () => {
  const labels = read(`${FEATURE_DIR}/labels/index.js`);
  for (const filter of ['keyword', 'category', 'state', 'size', 'sort', 'recent-days']) {
    assert.ok(labels.includes(`data-field="${filter}"`), `筛选控件 ${filter} 仍在 ✓`);
  }
  assert.equal(/api\.post\(/.test(labels), false, '⛔ 标签打印那一屏**不许**有 POST（它全是只读查询 ✓）');
});
