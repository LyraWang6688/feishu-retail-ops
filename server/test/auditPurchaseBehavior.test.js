/**
 * `scripts/audit-purchase-behavior.mjs`（只读审计）的验收标准 —— **先写后做**。
 *
 * 背景：2026-10-12 真机 bug —— 采购单的「采购行为」被写成了**库存环节**的行为
 *   （「采购增加」/「采购减少」）✗；配置已修（新单自动写对），
 *   但**历史批次**那一列已经错了 ⇒ 这份只读清单让她自己改。
 *
 *   AC-AB1 **只读**：整段执行体只调 `listAll`（假网关**没有** create/update/delete ⇒ 一写就抛）
 *   AC-AB2 分类正确：「采购增加」⇒ 应改「报货」(PURCHASE_ORDER)；「采购减少」⇒ 应改「退货」(PURCHASE_RETURN)
 *   AC-AB3 已经对的（`PURCHASE_ORDER` / `PURCHASE_RETURN`）**不许**再列进"需要改"
 *   AC-AB4 **认不出/为空的行为 ⇒ 不猜**（如实标"认不出，需人工看"）✗ 不许自动填一个目标
 *   AC-AB5 汇总行逐字（`共 N 行 · 需要改 M 行（其中"采购增加→报货" a 行、"采购减少→退货" b 行）`）
 *   AC-AB6 五列 + 目标 id 来自「行为管理」里那两条记录的 record_id（脚本自己查）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = pathToFileURL(path.join(__dirname, '../scripts/audit-purchase-behavior.mjs')).href;
const SCHEMA = {
  tables: {
    purchaseOrderBatch: { fields: { batchNo: '报货批次号', behavior: '发生行为' } },
    behavior: { fields: { code: '行为编码', name: '行为名称' } },
  },
};

/**
 * 🔴🔴 **夹具必须与真表形状一致**（本件的教训：上一版用字符串 `'bh_order'` ⇒ 测试绿、现实红 ✗）。
 * 真表（业务负责人 2026-10-12 在服务器上读出的，逐字）：
 *   `发生行为: [{ record_ids: ["recvwcl7trmDGz"], text: "采购增加", type: "text" }]`
 */
const link = (recordId, text) => ([{ record_ids: [recordId], text, text_arr: [text], type: 'text' }]);

const BEHAVIORS = [
  { record_id: 'bh_order', fields: { 行为编码: 'PURCHASE_ORDER', 行为名称: '报货' } },
  { record_id: 'bh_return', fields: { 行为编码: 'PURCHASE_RETURN', 行为名称: '退货' } },
  { record_id: 'bh_stock_in', fields: { 行为编码: 'STOCK_PURCHASE_INCREASE', 行为名称: '采购增加' } },
  { record_id: 'bh_stock_out', fields: { 行为编码: 'STOCK_PURCHASE_DECREASE', 行为名称: '采购减少' } },
];

/** ⚠️ 假网关**故意没有** create/update/delete ⇒ 脚本一旦想写就抛（这就是"只读"的哨兵）。 */
const readOnlyGateway = (batches) => {
  const calls = [];
  return {
    calls,
    listAll: async (tableKey) => {
      calls.push(tableKey);
      return tableKey === 'behavior' ? BEHAVIORS : batches;
    },
  };
};

const load = () => import(SCRIPT);

test('AC-AB1 **只读**：执行体只调 `listAll`（写方法根本不存在）', async () => {
  const { runAudit } = await load();
  const gateway = readOnlyGateway([
    { record_id: 'rec_1', fields: { 报货批次号: 'CGD-1', 发生行为: link('bh_stock_in', '采购增加') } },
  ]);
  await runAudit({ gateway, schema: SCHEMA });
  assert.deepEqual(gateway.calls.sort(), ['behavior', 'purchaseOrderBatch'], '只读这两张表');
  assert.equal(typeof gateway.create, 'undefined');
  assert.equal(typeof gateway.update, 'undefined');
  assert.equal(typeof gateway.delete, 'undefined');
});

test('AC-AB2/AB6 分类正确 + 目标 id 来自行为表（采购增加⇒报货 · 采购减少⇒退货）', async () => {
  const { classifyBatches } = await load();
  const batches = [
    { record_id: 'rec_1', fields: { 报货批次号: 'CGD-20261012-0001', 发生行为: link('bh_stock_in', '采购增加') } },
    { record_id: 'rec_2', fields: { 报货批次号: 'CGD-20261012-0002', 发生行为: link('bh_stock_out', '采购减少') } },
  ];
  const { rows } = classifyBatches({ batchRecords: batches, behaviorRecords: BEHAVIORS, schema: SCHEMA });
  assert.equal(rows[0].currentName, '采购增加');
  assert.equal(rows[0].should, '报货');
  assert.equal(rows[0].targetId, 'bh_order');
  assert.equal(rows[0].verdict, 'fix');
  assert.equal(rows[1].currentName, '采购减少');
  assert.equal(rows[1].should, '退货');
  assert.equal(rows[1].targetId, 'bh_return');
});

test('AC-AB3 已经对的**不许**再列进"需要改"', async () => {
  const { classifyBatches } = await load();
  const batches = [
    { record_id: 'rec_ok1', fields: { 报货批次号: 'CGD-A', 发生行为: link('bh_order', '报货') } },
    { record_id: 'rec_ok2', fields: { 报货批次号: 'CGD-B', 发生行为: link('bh_return', '退货') } },
  ];
  const { rows, summary } = classifyBatches({ batchRecords: batches, behaviorRecords: BEHAVIORS, schema: SCHEMA });
  assert.equal(summary.needFix, 0);
  assert.equal(rows.every((row) => row.verdict === 'ok'), true);
  assert.equal(rows[0].should, '报货（已对）');
  assert.equal(rows[1].should, '退货（已对）');
});

test('AC-AB4 认不出 / 为空的行为 ⇒ **不猜**（如实标"需人工看"）', async () => {
  const { classifyBatches } = await load();
  const batches = [
    { record_id: 'rec_x', fields: { 报货批次号: 'CGD-X', 发生行为: [] } },
    { record_id: 'rec_y', fields: { 报货批次号: 'CGD-Y', 发生行为: link('bh_unknown', '（认不出的行为）') } },
  ];
  const { rows, summary } = classifyBatches({ batchRecords: batches, behaviorRecords: BEHAVIORS, schema: SCHEMA });
  assert.equal(summary.needFix, 0, '认不出的不许算进"需要改"（不猜目标）');
  assert.equal(summary.unknown, 2);
  for (const row of rows) {
    assert.equal(row.should, '(认不出，需人工看)');
    assert.equal(row.targetId, '—');
  }
  assert.equal(rows[0].currentName, '(空)');
});

test('AC-AB5 汇总行逐字 + 五列表头逐字', async () => {
  const { classifyBatches, renderReport } = await load();
  const batches = [
    { record_id: 'rec_1', fields: { 报货批次号: 'CGD-1', 发生行为: link('bh_stock_in', '采购增加') } },
    { record_id: 'rec_2', fields: { 报货批次号: 'CGD-2', 发生行为: link('bh_stock_out', '采购减少') } },
    { record_id: 'rec_3', fields: { 报货批次号: 'CGD-3', 发生行为: link('bh_order', '报货') } },
  ];
  const result = classifyBatches({ batchRecords: batches, behaviorRecords: BEHAVIORS, schema: SCHEMA });
  const text = renderReport(result);
  assert.ok(text.startsWith('批次号\t那条记录 record_id\t现在写的（行为名称）\t应该写的\t目标行为记录 id'));
  assert.ok(text.includes('共 3 行 · 需要改 2 行（其中"采购增加→报货" 1 行、"采购减少→退货" 1 行）'), text);
});

test('AC-AB7 ⭐ **真表形状**（数组包对象）⇒ 正确分类；**空数组 ⇒ 才算"(空)"**', async () => {
  const { classifyBatches } = await load();
  const batches = [
    // 真表现场那两行的形状（业务负责人 2026-10-12 跑出来的）
    { record_id: 'reczz28KVvjZuU0p', fields: { 报货批次号: '202610071', 发生行为: link('bh_stock_in', '采购增加') } },
    { record_id: 'reczz28MVt92mBNi', fields: { 报货批次号: 'CGD-20261012-0002', 发生行为: link('bh_order', '报货') } },
    { record_id: 'rec_empty', fields: { 报货批次号: 'CGD-EMPTY', 发生行为: [] } },
  ];
  const { rows, summary } = classifyBatches({ batchRecords: batches, behaviorRecords: BEHAVIORS, schema: SCHEMA });
  // ⭐ 判据（业务负责人给的）：真表那两行**不许**显示"(空)"
  assert.equal(rows[0].currentName, '采购增加', '真表形状 ⇒ 要读出名字「采购增加」（不是"(空)" ✗）');
  assert.equal(rows[0].should, '报货');
  assert.equal(rows[0].targetId, 'bh_order');
  assert.equal(rows[1].currentName, '报货');
  assert.equal(rows[1].should, '报货（已对）');
  assert.equal(rows[1].verdict, 'ok');
  // 空数组才是真的"(空)"
  assert.equal(rows[2].currentName, '(空)');
  assert.equal(rows[2].should, '(认不出，需人工看)');
  assert.equal(summary.needFix, 1, '只有第一条要改');
});

test('AC-AB8 有 record_ids 但没 text ⇒ 说"（有值但没名字）"，**不许**误报"(空)"', async () => {
  const { classifyBatches } = await load();
  const batches = [
    { record_id: 'rec_noname', fields: { 报货批次号: 'CGD-NONAME', 发生行为: [{ record_ids: ['bh_stock_in'], type: 'text' }] } },
  ];
  const { rows } = classifyBatches({ batchRecords: batches, behaviorRecords: BEHAVIORS, schema: SCHEMA });
  // 名字能从「行为管理」查到（bh_stock_in ⇒ 采购增加）⇒ 照样给准话
  assert.equal(rows[0].currentName, '采购增加');
  assert.equal(rows[0].should, '报货');
  // 行为表里也没有这条 ⇒ 才说"有值但没名字"
  const unknown = classifyBatches({
    batchRecords: [{ record_id: 'rec_x', fields: { 报货批次号: 'CGD-X', 发生行为: [{ record_ids: ['bh_nope'], type: 'text' }] } }],
    behaviorRecords: BEHAVIORS,
    schema: SCHEMA,
  });
  assert.equal(unknown.rows[0].currentName, '（有值但没名字）');
  assert.equal(unknown.rows[0].should, '(认不出，需人工看)');
});
