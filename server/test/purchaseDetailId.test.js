/**
 * ⭐⭐ 2026-10-12（业务负责人，逐字）：
 *   「**采购明细的话，也是说我在同一个报货批次号里面，这是我的第几双鞋，也是需要明细 ID 的**」
 *   Lead 转述的格式：**采购明细ID = `{报货批次号}-{两位序号}`**（`CGD-…-01` = 同一批次第 1 双、第 2 双…）
 *   「**明细 ID 都是写在明细表里面的**」「主表存的是**报货批次号**」。
 *
 * 口径（按 Lead 的 brief）：
 *   · 写在**采购明细**行上（语义键 `purchaseRequest.detailId` → 「采购明细ID」）；
 *   · 序号 = **同一个报货批次号内、按明细创建顺序** 01/02…：
 *     **不重排已有行**、**后补的行接着排**、**幂等重放不重复占号**；
 *   · **两条链路都要写**：扫码报货报单（`purchaseWebhookService`）+ 扫码采购退货（`purchaseReturnService`）；
 *   · 主表那一行**照旧只存报货批次号**（本次不动它的字段）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-ID1 **格式逐字**：`{报货批次号}-{两位序号}`（例 `CGD-20261012-0001-01`）；
 *          序号补零到两位，**超过 99 不截断**（第 100 条 = `-100`）。
 *  AC-ID2 **同一批次内 01/02 递增且唯一**（报货一次报两双 ⇒ `-01`、`-02`）。
 *  AC-ID3 ⭐ **后补一行 ⇒ 接着排、不重排已有行**（先 01/02，再补 1 条 ⇒ `-03`；
 *          原来那两行的 `采购明细ID` **一字未变**）。
 *  AC-ID4 **幂等重放不重复占号**（同一次提交重放 ⇒ 条数不变、每行 id 不变）。
 *  AC-ID5 **两条链路都写**（扫码采购退货那条同样 `-01`/`-02`）。
 *  AC-ID6 **回归**：明细其余字段（报货批次号 / 编号 / 尺码 / 数量 / 幂等键）与
 *          主表那行（报货批次号 + **采购行为**）**一字未变**。
 *  AC-ID7 **schema 映射**仍是「采购明细ID」（她 2026-10-12 改过的列名）。
 *  AC-ID8 纯函数边界：别的批次的号 / 非数字后缀**不参与**排号（不误判、不跳号）。
 */
const { purchaseToast } = require('../src/config/purchaseWebhookTexts.js'); // 联动断言用（上面那条）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_purchase_detail_id';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'purchase_detail_id_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const {
  formatPurchaseDetailId, nextPurchaseDetailSequence, createPurchaseDetailIdAllocator,
} = require('../src/services/purchaseDetailId');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { createPurchaseReturnService } = require('../src/services/purchaseReturnService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const BATCH_FIELD = '报货批次号';
const DETAIL_ID_FIELD = '采购明细ID';

const liveUnit = (id, size, state = '门盒') => ({
  record_id: id, fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: state },
});

const seedTables = (overrides = {}) => ({
  product: [{
    record_id: 'prod_1',
    fields: {
      编号: 'YD6693-2|黑色|A', 货号: 'YD6693-2', 颜色: { text: '黑色' }, 类别: 'A', 单价: 399, 供应商: ['sup_1'],
    },
  }],
  sizeManagement: [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
  behavior: [
    { record_id: 'bh_request', fields: { 行为名称: '采购申请', 行为编码: 'STOCK_PURCHASE_INCREASE', 库存方向: '增加', 是否启用: true } },
    { record_id: 'bh_return', fields: { 行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true } },
  ],
  supplier: [{ record_id: 'sup_1', fields: { 供应商名称: '大发鞋厂' } }],
  purchaseOrderBatch: [],
  purchaseRequest: [],
  // 41 码三种状态各一双（退货 consumes = 门盒 + 样品 + 仓库 ⇒ 三双都能退）；42 码一双门盒
  liveInventory: [
    liveUnit('live_41_box', 41, '门盒'),
    liveUnit('live_41_sample', 41, '样品'),
    liveUnit('live_41_store', 41, '仓库'),
    liveUnit('live_42_box', 42, '门盒'),
  ],
  inventoryLedger: [],
  ...overrides,
});

/** 内存假网关（语义键 → 物理列名走真 schema；写错语义键当场抛）。 */
const createFakeGateway = (tables = seedTables()) => {
  let sequence = 0;
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find((record) => String(record.fields?.[name] ?? '').trim() === target) || null;
    },
    create: async (key, values) => {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      Object.assign(record.fields, physical(key, values));
      return record;
    },
    delete: async (key, id) => {
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `purchase-detail-id-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 报货链路：真 `PurchaseWebhookService.publishPurchaseRequest`（免确认那条现役路径）。 */
const reportHarness = (options = {}) => {
  const gateway = createFakeGateway(seedTables(options.tables || {}));
  const service = new PurchaseWebhookService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('report'), idField: 'task_id' }),
    references: {
      resolveProduct: async () => ({
        recordId: 'prod_1',
        record: { record_id: 'prod_1', fields: { 编号: 'YD6693-2|黑色|A', 货号: 'YD6693-2', 颜色: { text: '黑色' }, 供应商: ['sup_1'] } },
      }),
      resolveSupplier: async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '大发鞋厂' } } }),
      resolveBehavior: async () => ({ recordId: 'bh_request', record: { record_id: 'bh_request', fields: { 行为编码: 'STOCK_PURCHASE_INCREASE' } } }),
    },
    inventory: { applyPurchase: async () => ({}) },
    client: {
      im: {
        image: { create: async () => ({ image_key: 'k' }) },
        message: { create: async () => ({ code: 0 }), reply: async () => ({ code: 0 }) },
      },
    },
    images: { render: async () => Buffer.from('png') },
  });
  return { gateway, service, tables: gateway._tables };
};

const reportTask = (overrides = {}) => ({
  is_batch: true,
  operator_open_id: 'ou_1',
  supplier_record_id: 'sup_1',
  behavior_record_id: 'bh_request',
  items: [
    { product_record_id: 'prod_1', item_no: 'YD6693-2', color: '黑色', size: 40, quantity: 2, behavior_record_id: 'bh_request' },
    { product_record_id: 'prod_1', item_no: 'YD6693-2', color: '黑色', size: 41, quantity: 1, behavior_record_id: 'bh_request' },
  ],
  ...overrides,
});

/** 退货链路：真 `createPurchaseReturnService.submit`。 */
const returnHarness = (options = {}) => {
  const gateway = createFakeGateway(seedTables(options.tables || {}));
  let calls = 0;
  const service = createPurchaseReturnService({
    gateway,
    config: SCAN_WRITE.purchaseReturn,
    inventory: { applyPurchaseReturn: async () => ({ ledgerRecordId: 'led_1', liveRecordIds: [] }) },
    orderBatches: new PurchaseOrderBatchService({ gateway }),
    webhooks: { deliverSupplierImages: async () => ({ sent: [], failed: [] }) },
    batchNoGenerator: {
      runExclusive: async (work) => work(),
      next: async () => { calls += 1; return { batchNo: `CGD-20261012-010${calls}` }; },
    },
    store: new JsonTaskStore({ dir: tempDir('return'), idField: 'task_id' }),
  });
  return { gateway, service, tables: gateway._tables };
};

const returnDraft = () => ({
  product_record_id: 'prod_1',
  product_number: 'YD6693-2',
  item_no: 'YD6693-2',
  color: '黑色',
  supplier_record_id: 'sup_1',
  behavior_record_id: 'bh_return',
  operator_open_id: 'ou_1',
  items: [
    { size: 41, quantity: 2, product_record_id: 'prod_1' },
    { size: 42, quantity: 1, product_record_id: 'prod_1' },
  ],
});

const detailIds = (tables) => (tables.purchaseRequest || []).map((record) => record.fields[DETAIL_ID_FIELD]);

// ═══════════════════════════════════════════════════════════════════════════
// AC-ID1 / AC-ID7 / AC-ID8 格式与纯函数
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID1 格式逐字：`{报货批次号}-{两位序号}`（两位补零；第 100 条不截断）', () => {
  assert.equal(formatPurchaseDetailId('CGD-20261012-0001', 1), 'CGD-20261012-0001-01');
  assert.equal(formatPurchaseDetailId('CGD-20261012-0001', 9), 'CGD-20261012-0001-09');
  assert.equal(formatPurchaseDetailId('CGD-20261012-0001', 10), 'CGD-20261012-0001-10');
  assert.equal(formatPurchaseDetailId('CGD-20261012-0001', 100), 'CGD-20261012-0001-100', '超过两位不截断');
});

test('AC-ID7 schema 映射：「采购明细ID」就是 detailId（写入点接的是它）', () => {
  const fields = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
  assert.equal(fields.detailId, DETAIL_ID_FIELD);
  assert.equal(fields.batchNo, BATCH_FIELD);
});

test('AC-ID8 纯函数边界：别的批次 / 非数字后缀不参与排号', () => {
  const batchNo = 'CGD-20261012-0001';
  // 本批已有 01、02 ⇒ 下一条 03
  assert.equal(nextPurchaseDetailSequence(batchNo, {
    existingIds: [`${batchNo}-01`, `${batchNo}-02`], rowCount: 2,
  }), 3);
  // 别的批次的号、非数字后缀、空值 ⇒ 全部忽略
  assert.equal(nextPurchaseDetailSequence(batchNo, {
    existingIds: ['CGD-20261012-9999-07', `${batchNo}-xx`, '', null, undefined], rowCount: 0,
  }), 1);
  // 有历史行但**没有号**（迁移前的老数据）⇒ 按行数接着排，不撞号
  assert.equal(nextPurchaseDetailSequence(batchNo, {
    existingIds: ['', ''], rowCount: 2,
  }), 3);
  // 号有缺口（例：02 被删了）⇒ 取**最大号**+1，绝不重号
  assert.equal(nextPurchaseDetailSequence(batchNo, {
    existingIds: [`${batchNo}-01`, `${batchNo}-05`], rowCount: 2,
  }), 6);
  // 分配器：同一个网关读既有行，逐条给号
  const gateway = createFakeGateway(seedTables({
    purchaseRequest: [{ record_id: 'r1', fields: { [BATCH_FIELD]: ['bat_1'], [DETAIL_ID_FIELD]: 'CGD-20261012-0001-01' } }],
  }));
  const allocator = createPurchaseDetailIdAllocator({ gateway });
  return allocator.open({ batchRecordId: 'bat_1', batchNo: 'CGD-20261012-0001' }).then((cursor) => {
    assert.equal(cursor.next(), 'CGD-20261012-0001-02');
    assert.equal(cursor.next(), 'CGD-20261012-0001-03');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ID2 / AC-ID3 / AC-ID4 / AC-ID6 报货链路
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID2 报货一次两双 ⇒ `-01` / `-02`（同一批次内递增且唯一）', async () => {
  const h = reportHarness();
  const task = await h.service.store.create({
    task_id: 't1', kind: 'scan_replenish', status: 'posting', draft: reportTask(),
  });
  const result = await h.service.publishPurchaseRequest('t1', task);
  assert.ok(result.batch_no, '照常出号');
  // ⭐⭐ 与技术债批次《文案抽 config》的**联动断言**（2026-10-12）：抽文案**不许**把这条链弄坏。
  //    期望值取 config 的常量（不手抄字符串），参数取**真实 result**（批次号 / 明细条数）——
  //    上次的真 bug 正是这里：填参函数的入参名和服务传的不一致 ⇒ 这条链直接 ReferenceError。
  if (result.toast) {
    assert.equal(result.toast.content, purchaseToast.m1({ plan: { batch_no: result.batch_no }, requestIds: result.request_ids || [] }),
      '报货建单真的跑通后，产出的那句文案必须与 config 逐字对上');
  }
  const ids = detailIds(h.tables).sort();
  assert.deepEqual(ids, [`${result.batch_no}-01`, `${result.batch_no}-02`]);
  assert.equal(new Set(ids).size, ids.length, '同一批次内不重号');
  // AC-ID6 回归：其余字段一字未变（数量 / 尺码 / 幂等键）+ 主表两列
  const rows = h.tables.purchaseRequest;
  const bySize = new Map(rows.map((record) => [String(record.fields['尺码']), record]));
  assert.deepEqual(bySize.get('size_40').fields['数量'], 2);
  assert.deepEqual(bySize.get('size_41').fields['数量'], 1);
  for (const record of rows) {
    assert.deepEqual(record.fields['编号'], ['prod_1']);
    assert.ok(record.fields['幂等键'], '幂等键照旧');
    assert.deepEqual(record.fields[BATCH_FIELD], [h.tables.purchaseOrderBatch[0].record_id]);
    assert.equal('采购行为' in record.fields, false, '明细那列是 Lookup：仍然不许写');
  }
  // ⭐ 2026-10-17 成对迁移（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`fields['采购行为']`；改后逐字：`fields['发生行为']`；
  //   依据 = 她逐字「采购主表里面的采购行为，目前字段名称改为了发生行为」（真表已改名，只读核过）。
  assert.deepEqual(h.tables.purchaseOrderBatch[0].fields['发生行为'], ['bh_request'], '主表行为照旧');
});

test('AC-ID3 ⭐ 后补一行 ⇒ 接着排（03），已有两行一字未变', async () => {
  const h = reportHarness();
  const first = await h.service.store.create({
    task_id: 't1', kind: 'scan_replenish', status: 'posting', draft: reportTask(),
  });
  const published = await h.service.publishPurchaseRequest('t1', first);
  const before = h.tables.purchaseRequest.map((record) => ({ ...record.fields }));
  assert.equal(before.length, 2);

  // 「后补一行」= 同一个批次号的第二次提交（计划里冻结同一个批次号 + 同一个批次幂等键）
  const second = await h.service.store.create({
    task_id: 't2', kind: 'scan_replenish', status: 'posting',
    draft: reportTask({
      items: [{
        product_record_id: 'prod_1', item_no: 'YD6693-2', color: '黑色', size: 42, quantity: 3, behavior_record_id: 'bh_request',
      }],
    }),
    posting_plan: {
      version: 1, // ⚠️ `ensurePostingPlan` 只在 `version === 1` 时复用冻结计划
      batch_no: published.batch_no,
      batch_key: `purchase_batch:t1`,
      items: [{
        item_key: 't2:0', request_key: 'purchase_request:t2:0',
        product_record_id: 'prod_1', item_no: 'YD6693-2', color: '黑色', size: 42, quantity: 3,
        behavior_record_id: 'bh_request',
      }],
    },
  });
  await h.service.publishPurchaseRequest('t2', second);

  const after = h.tables.purchaseRequest;
  assert.equal(after.length, 3, '只多了一行');
  assert.equal(after[2].fields[DETAIL_ID_FIELD], `${published.batch_no}-03`, '后补的行接着排 03');
  // ⭐ 不重排已有行：前两行的字段逐字未变（含它们的明细 ID）
  assert.deepEqual(after[0].fields, before[0], '第 1 行一字未变');
  assert.deepEqual(after[1].fields, before[1], '第 2 行一字未变');
  assert.equal(h.tables.purchaseOrderBatch.length, 1, '同一个批次只建一行主表');
});

test('AC-ID4 幂等重放 ⇒ 不重复占号（条数与每行 id 都不变）', async () => {
  const h = reportHarness();
  const task = await h.service.store.create({
    task_id: 't1', kind: 'scan_replenish', status: 'posting', draft: reportTask(),
  });
  await h.service.publishPurchaseRequest('t1', task);
  const snapshot = h.tables.purchaseRequest.map((record) => ({ ...record.fields }));
  // 重放同一次提交（同一个 task / 同一份计划）
  const again = await h.service.store.get('t1');
  await h.service.publishPurchaseRequest('t1', again);
  assert.equal(h.tables.purchaseRequest.length, snapshot.length, '不新增行');
  assert.deepEqual(h.tables.purchaseRequest.map((record) => ({ ...record.fields })), snapshot,
    '每行的「采购明细ID」与其余字段一字未变（没有重复占号）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ID5 退货链路也写
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ID5 扫码采购退货那条链路同样写：同一批次内 01/02', async () => {
  const h = returnHarness();
  const result = await h.service.submit('task_1', returnDraft());
  // ⚠️ `purchaseReturnService.submit` 返回的是**服务层结果**（没有 `ok`；`ok` 是扫码写服务那层的壳）
  assert.equal(result.skipped, '', JSON.stringify(result));
  assert.equal(result.request_ids.length, 2, '两条退货明细都写了');
  const batchNo = result.batch_no;
  assert.ok(batchNo, '照常出号');
  const ids = detailIds(h.tables).sort();
  assert.equal(ids.length, 2, '两条退货明细');
  assert.deepEqual(ids, [`${batchNo}-01`, `${batchNo}-02`]);
  // 回归：退货明细其余字段 + 主表那两列（批次号 + 采购行为）
  for (const record of h.tables.purchaseRequest) {
    assert.deepEqual(record.fields['编号'], ['prod_1']);
    assert.ok(record.fields['幂等键']);
    assert.equal('采购行为' in record.fields, false, '明细那列是 Lookup：不许写');
  }
  assert.equal(h.tables.purchaseOrderBatch[0].fields[BATCH_FIELD], batchNo);
  // ⭐ 2026-10-17 同上迁移：主表行为列真表已改名「发生行为」
  assert.deepEqual(h.tables.purchaseOrderBatch[0].fields['发生行为'], ['bh_return'], '主表行为照旧');
  // 重放：不重复占号
  const replay = await h.service.submit('task_1', returnDraft());
  assert.equal(replay.skipped, '');
  assert.deepEqual(detailIds(h.tables).sort(), ids, '重放后号不变');
  assert.equal(h.tables.purchaseRequest.length, 2, '重放不新增行');
});
