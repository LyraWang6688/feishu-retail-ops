/**
 * 🔴 2026-10-12 业务负责人指出的**真 bug**（她：「**为什么你选成了采购增加了呢？**」）：
 *   采购单的「采购行为」被写成了**库存环节**的行为「采购增加」✗
 *
 * 真表（「行为管理」，业务负责人只读核过，逐字）：
 *   · 「报货」     编码 `PURCHASE_ORDER`           所属环节=**采购**  库存方向=不影响 ← 采购单该用它 ✓
 *   · 「退货」     编码 `PURCHASE_RETURN`          所属环节=**采购**  库存方向=减少   ← 采购退货单该用它 ✓
 *   · 「采购增加」 编码 `STOCK_PURCHASE_INCREASE`  所属环节=**库存**  库存方向=增加   ← 这是**库存**行为 ✗
 *   · 「采购减少」 编码 `STOCK_PURCHASE_DECREASE`  所属环节=**库存**  库存方向=减少   ← 同上 ✗
 *   ⚠️ 「退货」有**同名两条**（采购 `PURCHASE_RETURN` / 销售 `SALE_RETURN`）⇒ **只能按编码**解析 ✗ 不能按名字。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**）
 *   AC-BH1 扫码补货 ⇒ 采购行为码 = `PURCHASE_ORDER`（名字「报货」）；env 覆盖仍在
 *   AC-BH2 扫码采购退货 ⇒ 采购行为码 = `PURCHASE_RETURN`（名字「退货」）；env 覆盖仍在
 *   AC-BH3 ⭐ **同批里「库存流水.库存行为」仍是** `STOCK_PURCHASE_INCREASE` / `..._DECREASE`
 *          （与采购行为是**两件事** ⇒ 两组编码**必须互不相交**，防"顺手改坏库存口径" ✗）
 *   AC-BH4 解析**按编码**（同名「退货」两条时，采购/销售必须分得开）
 *   AC-BH5 解析不到该编码 ⇒ **抛人话**（绝不写一条没有「采购行为」的单）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');
const inventoryService = require('../src/services/inventoryService');

/** 行为管理（真表那 5 条的形状；含**同名两条「退货」**）。 */
const BEHAVIORS = [
  { record_id: 'rec_order', fields: { 行为名称: '报货', 行为编码: 'PURCHASE_ORDER', 所属环节: '采购' } },
  { record_id: 'rec_return_purchase', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN', 所属环节: '采购' } },
  { record_id: 'rec_return_sale', fields: { 行为名称: '退货', 行为编码: 'SALE_RETURN', 所属环节: '销售' } },
  { record_id: 'rec_stock_in', fields: { 行为名称: '采购增加', 行为编码: 'STOCK_PURCHASE_INCREASE', 所属环节: '库存' } },
  { record_id: 'rec_stock_out', fields: { 行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 所属环节: '库存' } },
];

const fakeGateway = () => ({
  table: () => ({ tableName: '行为管理', tableId: 'tbl_behavior', fields: { code: '行为编码', name: '行为名称' } }),
  listAll: async () => BEHAVIORS,
  findOneByText: async (tableKey, semanticKey, expected) => BEHAVIORS
    .find((record) => record.fields['行为编码'] === String(expected ?? '').trim()) || null,
});

test('AC-BH1 扫码补货 ⇒ 采购行为码 = `PURCHASE_ORDER`（不再是库存行为「采购增加」）', () => {
  assert.equal(SCAN_WRITE.replenish.behaviorCode, 'PURCHASE_ORDER',
    '补货写的是**采购行为**（「报货」）—— 不是库存环节的 STOCK_PURCHASE_INCREASE ✗');
});

test('AC-BH2 扫码采购退货 ⇒ 采购行为码 = `PURCHASE_RETURN`', () => {
  assert.equal(SCAN_WRITE.purchaseReturn.behaviorCode, 'PURCHASE_RETURN',
    '采购退货写「退货」（采购环节），不是库存环节的 STOCK_PURCHASE_DECREASE ✗');
});

test('AC-BH3 ⭐ 库存那一边**不许动**：库存行为仍是采购增加/减少，两组编码互不相交', () => {
  const movements = inventoryService.STOCK_MOVEMENTS || inventoryService.MOVEMENTS || {};
  const codes = JSON.stringify(movements);
  assert.ok(codes.includes('STOCK_PURCHASE_INCREASE'), '库存流水.库存行为 = 采购增加（编码不变）');
  assert.ok(codes.includes('STOCK_PURCHASE_DECREASE'), '库存流水.库存行为 = 采购减少（编码不变）');
  // ⭐ 采购单的「采购行为」与库存的「库存行为」是**两张表两列** ⇒ 编码集合必须**不相交**
  const purchaseSide = [SCAN_WRITE.replenish.behaviorCode, SCAN_WRITE.purchaseReturn.behaviorCode];
  assert.deepEqual(purchaseSide, ['PURCHASE_ORDER', 'PURCHASE_RETURN']);
  for (const code of purchaseSide) {
    assert.equal(code.startsWith('STOCK_'), false, `采购行为码不许再用库存编码：${code} ✗`);
  }
});

test('AC-BH4 解析**按编码**：同名「退货」两条时也分得开（采购 vs 销售）', async () => {
  const resolver = new V1ReferenceResolver(fakeGateway());
  const purchase = await resolver.resolveBehavior('PURCHASE_RETURN');
  const sale = await resolver.resolveBehavior('SALE_RETURN');
  assert.equal(purchase.recordId, 'rec_return_purchase', '采购那条（按编码）');
  assert.equal(sale.recordId, 'rec_return_sale', '销售那条（按编码）');
  assert.notEqual(purchase.recordId, sale.recordId, '⚠️ 两条同名「退货」必须是不同记录');
  // 补货那条解析到「报货」
  assert.equal((await resolver.resolveBehavior('PURCHASE_ORDER')).recordId, 'rec_order');
});

test('AC-BH5 解析不到该编码 ⇒ 抛人话（绝不写一条没有「采购行为」的单）', async () => {
  const resolver = new V1ReferenceResolver(fakeGateway());
  await assert.rejects(() => resolver.resolveBehavior('STOCK_NOT_EXIST'),
    /行为管理中找不到已配置行为/, '找不到要**报出来**（上层据此停下来），不许静默给个别的行为');
});

test('AC-BH6 哨兵：扫码那条链路只从配置读采购行为码（不写死、也不再借库存编码）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const service = fs.readFileSync(path.join(__dirname, '../src/services/scanWriteService.js'), 'utf8');
  assert.ok(service.includes('behaviorCode'), '补货/退货链路从配置读采购行为码');
  assert.equal(service.includes('STOCK_PURCHASE_INCREASE'), false,
    '业务侧不许出现库存编码（那是 inventoryService 的事）✗');
  assert.equal(service.includes('STOCK_PURCHASE_DECREASE'), false, '同上');
});
