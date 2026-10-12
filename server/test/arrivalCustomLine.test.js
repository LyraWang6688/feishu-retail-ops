/**
 * ⭐⭐ 2026-10-12（Lead 裁定，口径照业务负责人原话）：
 *   「**自定义加进来的尺码，必须能归到"她扫进来的那一款"**」——
 *   ⇒ `buildPlan` 判定"这一双不在本批"时：**若这个尺码属于"她本次确认的该款自定义行" ⇒ 允许计入**；
 *   ⇒ **不认识的款 / 没款可归 ⇒ 照旧拦住**（人话："请先扫这一款的标签"）—— **不猜款** ✗。
 *
 * 这里钉的是 `buildPlan` 这个**纯函数**（`purchaseArrivalConversationService`），零网络。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-ACL1 自定义尺码（**款在本批**）⇒ 计入：`rows` 里多一条 `actual = 她填的数量`，且
 *          **申请行一条不动**（应到 / 实际数量口径不变）。
 *  AC-ACL2 自定义尺码但**款不在本批** ⇒ `scan_not_in_batch`（不猜 ✗）。
 *  AC-ACL3 同一 (款, 尺码) 的自定义行出现两次 ⇒ `scan_duplicated`（宁可不入库）。
 *  AC-ACL4 自定义行数量为 0 / 负 / 非整数 ⇒ `actual_not_positive`（不静默写成 0 双）。
 *  AC-ACL5 回归：**报货行照旧**（扫到的行 = 实际、没扫到的行 = 0），且没有自定义行时
 *          返回的 `rows` 与改前**逐字相同**（顺序 / 字段 / 长度）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_acl_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'acl_secret';

const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');

const ROWS = [
  { request_record_id: 'pr_35', product_record_id: 'prod_1', item_no: 'YD6693-2', color: '黑色', size: 35, quantity: 1 },
  { request_record_id: 'pr_36', product_record_id: 'prod_1', item_no: 'YD6693-2', color: '黑色', size: 36, quantity: 1 },
  { request_record_id: 'pr_37', product_record_id: 'prod_2', item_no: 'XHB8095', color: '棕色', size: 37, quantity: 2 },
];

/** 只要 `buildPlan`（纯函数）⇒ 其余依赖给最小替身。 */
const serviceOf = () => new PurchaseArrivalConversationService({
  gateway: { table: () => ({ fields: {} }), get: async () => null },
  store: { get: async () => null, create: async () => undefined, update: async () => undefined },
});

// ── AC-ACL1 ───────────────────────────────────────────────────────────────
test('AC-ACL1 自定义尺码（款在本批）⇒ 计入：多一条 actual=她填的数量，申请行一条不动', () => {
  const plan = serviceOf().buildPlan(ROWS, {
    scanLines: [
      { product_record_id: 'prod_1', size: 35, quantity: 1 },
      // ⭐ 自定义：没报过的 41 码到了 2 双 —— 归到"她扫进来的那一款" prod_1
      { product_record_id: 'prod_1', size: 41, quantity: 2 },
    ],
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const extra = plan.rows.filter((row) => Number(row.size) === 41);
  assert.equal(extra.length, 1, '自定义那一行要在 plan 里');
  assert.equal(extra[0].actual, 2, '自定义行的实际数量 = 她填的');
  assert.equal(extra[0].product_record_id, 'prod_1', '归到**那一款**');
  assert.equal(extra[0].request_record_id, '', '它没有申请行（自定义）');
  // 申请行一条不动：35 扫到 1、36 没扫 = 0、37（另一款）没扫 = 0
  const bySize = new Map(plan.rows.filter((row) => row.request_record_id).map((row) => [row.size, row.actual]));
  assert.deepEqual([...bySize.entries()].sort((a, b) => a[0] - b[0]), [[35, 1], [36, 0], [37, 0]]);
});

// ── AC-ACL2 ───────────────────────────────────────────────────────────────
test('AC-ACL2 自定义尺码但**款不在本批** ⇒ scan_not_in_batch（不猜 ✗）', () => {
  const plan = serviceOf().buildPlan(ROWS, {
    scanLines: [{ product_record_id: 'prod_999', size: 41, quantity: 2 }],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'scan_not_in_batch', '不认识的款 ⇒ 照旧拦住（不许猜着入到别的款上）');
});

// ── AC-ACL3 / AC-ACL4 ─────────────────────────────────────────────────────
test('AC-ACL3 同一 (款, 尺码) 的自定义行两次 ⇒ scan_duplicated', () => {
  const plan = serviceOf().buildPlan(ROWS, {
    scanLines: [
      { product_record_id: 'prod_1', size: 41, quantity: 2 },
      { product_record_id: 'prod_1', size: 41, quantity: 1 },
    ],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'scan_duplicated');
});

test('AC-ACL4 自定义行数量 0 / 负数 / 非整数 ⇒ actual_not_positive', () => {
  for (const quantity of [0, -1, 1.5, 'x']) {
    const plan = serviceOf().buildPlan(ROWS, {
      scanLines: [{ product_record_id: 'prod_1', size: 41, quantity }],
    });
    assert.equal(plan.ok, false, `数量 ${quantity} 必须被拦`);
    assert.equal(plan.reason, 'actual_not_positive', `数量 ${quantity} 的 reason`);
  }
});

// ── AC-ACL5 回归 ──────────────────────────────────────────────────────────
test('AC-ACL5 回归：没有自定义行时，rows 与改前**逐字相同**（顺序/字段/长度）', () => {
  const plan = serviceOf().buildPlan(ROWS, {
    scanLines: [{ product_record_id: 'prod_2', size: 37, quantity: 2 }],
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.rows, [
    { ...ROWS[0], actual: 0 },
    { ...ROWS[1], actual: 0 },
    { ...ROWS[2], actual: 2 },
  ], '报货行照旧：扫到的 = 实际、没扫到的 = 0；一条也不多、顺序也不变');
  assert.deepEqual(plan.differences, []);
});
