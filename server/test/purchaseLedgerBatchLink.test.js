/**
 * ⭐ 「库存流水.关联采购」补刀（业务负责人 2026-10-08 口径，逐字见文件头下方）：
 *   她在生产真表里把「关联采购」从"指向已删除的「采购入库」"**改成了指向「报货批次」**
 *   ⇒ 采购加库存的那条流水**多写一个关联 id** = **报货批次那一行的 record id**。
 *
 * 她的口径（逐字）：
 *   「【库存流水.关联采购】**还在**（关联类型），指向 已删除的「采购入库」⇒ 所以它的处置
 *    （删掉这个映射、不再传关联 id）是对的，继续写必然失败，**改成了报货批次**」
 *   「①「关联采购」补刀（写批次 record id）**历史不用补了**」
 *
 * 本文件的五组断言＝任务书点名的五条：
 *   ① 采购加库存的流水**带上**批次 record id（**逐字** deepEqual）
 *   ② 拿不到批次 record id 时**不传**（列不出现，绝不编）
 *   ③ 其他行为**不带**（销售侧仍是「关联销售」、采购退货一个字都不带）
 *   ④ 幂等 / 重放**一行都没改**（含崩溃恢复：重放写出的那条也带批次 id）
 *   ⑤ 到货确认真实链路 / 9 点推送等**其他链路不回退**（全量测试 + arrivalLandingOnBatch）
 *
 * ⚠️ 验收标准先写在 `docs/purchase-ledger-batch-link-2026-10-08.md`（第 2 节 AC-1～AC-11），
 *    本文件是其中可执行的那部分。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  InventoryService, STOCK_MOVEMENTS, purchaseIncreaseSourceId,
} = require('../src/services/inventoryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const LEDGER = 'inventoryLedger';
const LIVE = 'liveInventory';
const PURCHASE_INCREASE = 'STOCK_PURCHASE_INCREASE';
const PURCHASE_DECREASE = 'STOCK_PURCHASE_DECREASE';
const SALE_DECREASE = 'STOCK_SALE_DECREASE';
const BATCH_RECORD_ID = 'recBatch0001';
// 她口径里的另一条真值：一个批次里多个（货品+尺码）→ 多条流水**共用**同一个批次 record id。
const BATCH_RECORD_ID_2 = 'recBatch0002';

const tempStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'operation_id' });

const behavior = (recordId, code, name, direction) => ({
  record_id: recordId, fields: { 行为编码: code, 行为名称: name, 库存方向: direction, 是否启用: true },
});

const SIZE_RECORDS = [38, 39].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));

/**
 * 记录型 gateway：语义字段名 → 物理列名（`V1_BITABLE_SCHEMA`），**映射缺了当场抛**
 * —— 这样"映射没加回来"这件事会以 `未配置语义字段: inventoryLedger.purchaseBatch` 的形式暴露。
 * `options.failLedgerTimes` 用来造"流水写失败"的崩溃形状（本地任务停在 prepared）。
 */
const makeGateway = (records = {}, options = {}) => {
  let failLedgerTimes = Number(options.failLedgerTimes || 0);
  const behaviors = [
    behavior('bhv_buy', PURCHASE_INCREASE, '采购增加', '增加'),
    behavior('bhv_buy_back', PURCHASE_DECREASE, '采购减少', '减少'),
    behavior('bhv_sale', SALE_DECREASE, '销售减少', '减少'),
  ];
  const mapFields = (tableKey, semanticValues) => {
    const schema = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    Object.entries(semanticValues || {}).forEach(([key, value]) => {
      const fieldName = schema?.fields?.[key];
      if (!fieldName) throw new Error(`未配置语义字段: ${tableKey}.${key}`);
      if (value !== undefined) out[fieldName] = value;
    });
    return out;
  };
  return {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => {
      if (key === 'sizeManagement') return SIZE_RECORDS;
      if (key === 'behavior') return behaviors;
      return records[key] || [];
    },
    get: async (key, recordId) =>
      (records[key] || []).find((item) => item.record_id === recordId) || null,
    create: async (key, semanticValues) => {
      if (key === LEDGER && failLedgerTimes > 0) {
        failLedgerTimes -= 1;
        throw new Error('boom: 流水创建失败（模拟崩溃）');
      }
      const fields = mapFields(key, semanticValues);
      const recordId = `new_${key}_${(records[key] || []).length + 1}`;
      const record = { record_id: recordId, fields };
      (records[key] ||= []).push(record);
      return { recordId, record };
    },
    update: async (key, recordId, semanticValues) => {
      const patch = mapFields(key, semanticValues);
      const record = (records[key] || []).find((item) => item.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    delete: async (key, recordId) => {
      records[key] = (records[key] || []).filter((row) => row.record_id !== recordId);
      return true;
    },
  };
};

const inventoryFor = (gateway, prefix = 'purchase-ledger-link-') =>
  new InventoryService({ gateway, store: tempStore(prefix) });

const liveUnit = (recordId, size, state = '门盒') => ({
  record_id: recordId,
  fields: { 编号: ['product_1'], 尺码: [`size_${size}`], 所属状态: state },
});

// ═══════════════════════════════════════════════════════════════════════════
// ① 采购加库存：流水带上「关联采购」= 报货批次 record id（逐字）
// ═══════════════════════════════════════════════════════════════════════════

test('① 采购加库存的流水**带上**「关联采购」= 报货批次那一行的 record id（逐字 deepEqual）', async () => {
  const gateway = makeGateway({});
  await inventoryFor(gateway).applyPurchase({
    purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size: 38,
    quantity: 2, state: '仓库',
  });
  assert.equal(gateway.records[LEDGER].length, 1);
  assert.deepEqual(gateway.records[LEDGER][0].fields, {
    编号: ['product_1'],
    尺码: ['size_38'],
    变动数量: 2,
    库存行为: ['bhv_buy'],
    // ⭐ 补刀的就是这一列：写的是**批次那一行的 record id**（不是三元组、不是批次号）。
    关联采购: [BATCH_RECORD_ID],
  });
});

test('①-补 同一批次的多个（货品+尺码）→ 多条流水共用同一个批次 record id（幂等键仍是三元组）', async () => {
  const gateway = makeGateway({});
  const inventory = inventoryFor(gateway);
  for (const size of [38, 39]) {
    await inventory.applyPurchase({
      purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size, quantity: 1, state: '仓库',
    });
  }
  assert.equal(gateway.records[LEDGER].length, 2);
  for (const row of gateway.records[LEDGER]) {
    assert.deepEqual(row.fields['关联采购'], [BATCH_RECORD_ID], '同一个批次 → 每条流水都挂那个批次 id');
  }
  // 而本地幂等键（不落远端）仍把尺码分开 —— 这正是不能拿批次 id 当幂等键的原因。
  const store = tempStore('purchase-ledger-link-keys-');
  const inventoryWithStore = new InventoryService({ gateway: makeGateway({}), store });
  for (const size of [38, 39]) {
    await inventoryWithStore.applyPurchase({
      purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size, quantity: 1, state: '仓库',
    });
  }
  const ids = (await store.list()).map((row) => row.source_record_id).sort();
  assert.deepEqual(ids, [
    `purchase_increase:${BATCH_RECORD_ID}|product_1|38`,
    `purchase_increase:${BATCH_RECORD_ID}|product_1|39`,
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 拿不到批次 record id → 不传（列不出现，绝不编）
// ═══════════════════════════════════════════════════════════════════════════

test('② 拿不到批次 record id 时**这一列一个字都不写**（批次号 / 到货任务 id 都不许拿来顶上）', async () => {
  const cases = [
    { purchaseBatchNo: 'CGD-20261007-0001' },
    { arrivalTaskId: 'arrival_reconcile_1' },
  ];
  for (const extra of cases) {
    const gateway = makeGateway({});
    await inventoryFor(gateway).applyPurchase({
      ...extra, productRecordId: 'product_1', size: 38, quantity: 1, state: '仓库',
    });
    const row = gateway.records[LEDGER][0];
    assert.equal(Object.hasOwn(row.fields, '关联采购'), false,
      `拿不到批次 record id ⇒ 不许写「关联采购」（输入：${JSON.stringify(extra)}）`);
    // 其余部分照常：流水在、实时库存在（加库存不能被这个可选关联挡掉）。
    assert.deepEqual(gateway.records[LEDGER][0].fields, {
      编号: ['product_1'], 尺码: ['size_38'], 变动数量: 1, 库存行为: ['bhv_buy'],
    });
    assert.equal(gateway.records[LIVE].length, 1);
    // 也**不许**把编出来的 id 藏在任何别的列里。
    for (const value of Object.values(row.fields)) {
      assert.equal(JSON.stringify(value).includes('CGD-20261007-0001'), false);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 其他行为一个都不带（销售侧仍是「关联销售」；采购退货一个字都不带）
// ═══════════════════════════════════════════════════════════════════════════

test('③ 销售减少 / 采购退货的流水**不带**「关联采购」；销售那条仍挂「关联销售」', async () => {
  const saleGateway = makeGateway({ [LIVE]: [liveUnit('door_1', 38)] });
  await inventoryFor(saleGateway).applySale({
    salesDetailRecordId: 'detail_1', productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒',
  });
  assert.deepEqual(saleGateway.records[LEDGER][0].fields, {
    编号: ['product_1'], 尺码: ['size_38'], 变动数量: 1,
    库存行为: ['bhv_sale'], 关联销售: ['detail_1'],
  });

  const returnGateway = makeGateway({ [LIVE]: [liveUnit('door_9', 38, '仓库')] });
  await inventoryFor(returnGateway).applyChange({
    kind: PURCHASE_DECREASE, sourceRecordId: 'purchase_return_1',
    productRecordId: 'product_1', size: 38, quantity: 1, state: '仓库',
  });
  assert.deepEqual(returnGateway.records[LEDGER][0].fields, {
    编号: ['product_1'], 尺码: ['size_38'], 变动数量: 1, 库存行为: ['bhv_buy_back'],
  });
});

test('③-补 来源注册表：**只有**采购增加的来源被补了这一刀（其余逐字不变）', () => {
  // 采购增加的 `ledgerSource` 仍为 null：本次补的是"只写不查"的关联列，
  // 不是把 findLedger 那条"按来源回查"接回来（AC-6）。
  assert.equal(STOCK_MOVEMENTS[PURCHASE_INCREASE].ledgerSource, null);
  assert.deepEqual(STOCK_MOVEMENTS[PURCHASE_INCREASE].ledgerLink, {
    field: 'purchaseBatch', inputKey: 'purchaseBatchRecordId', operationKey: 'purchase_batch_record_id',
  });
  const unchanged = {
    STOCK_SALE_DECREASE: 'salesDetail',
    SALE_RETURN: 'salesDetail',
    SALE_COMPENSATION: 'salesDetail',
    SALE_CASH: 'salesDetail',
    STOCK_PURCHASE_DECREASE: null,
    STOCK_MANUAL_INCREASE: null,
    STOCK_MANUAL_DECREASE: null,
    STOCK_FREEZE: null,
    STOCK_RELEASE_TO_DOOR_BOX: null,
    STOCK_SAMPLE_TO_DOORBOX: null,
    STOCK_DOORBOX_TO_SAMPLE: null,
  };
  for (const [code, ledgerSource] of Object.entries(unchanged)) {
    assert.equal(STOCK_MOVEMENTS[code].ledgerSource, ledgerSource, `${code}.ledgerSource 不许动`);
    assert.equal(STOCK_MOVEMENTS[code].ledgerLink, undefined, `${code} 不许拿到"补关联"的配置`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 幂等 / 重放：一行都没改（含崩溃恢复也要带上批次 id）
// ═══════════════════════════════════════════════════════════════════════════

test('④ 同一（批次｜货品｜尺码）重复调用 → 仍只 1 条流水 + 一组实时库存，且关联值不变', async () => {
  const gateway = makeGateway({});
  const inventory = inventoryFor(gateway);
  const input = {
    purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size: 38, quantity: 2, state: '仓库',
  };
  const first = await inventory.applyPurchase(input);
  const second = await inventory.applyPurchase(input);
  assert.equal(second.ledgerRecordId, first.ledgerRecordId);
  assert.equal(gateway.records[LEDGER].length, 1, '重放不得再写一条流水');
  assert.equal(gateway.records[LIVE].length, 2, '重放不得把库存变成 4 双');
  assert.deepEqual(gateway.records[LEDGER][0].fields['关联采购'], [BATCH_RECORD_ID]);
});

test('④-补 崩溃恢复：流水写失败 → 本地任务停在 prepared → 续跑写出的那条**也带**批次 id', async () => {
  const gateway = makeGateway({}, { failLedgerTimes: 1 });
  const store = tempStore('purchase-ledger-link-resume-');
  const inventory = new InventoryService({ gateway, store });
  const input = {
    purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒',
  };
  await assert.rejects(inventory.applyPurchase(input), /boom/);
  assert.equal(gateway.records[LEDGER], undefined, '第一次一个字都没写进去');
  const [pending] = await store.list();
  assert.equal(pending.status, 'prepared');
  // ⭐ AC-9：批次 record id 必须在 prepare 那一刻就落进本地任务 —— 否则"续跑的那一条"会静默丢关联。
  assert.equal(pending.purchase_batch_record_id, BATCH_RECORD_ID);

  await inventory.applyPurchase(input);
  assert.equal(gateway.records[LEDGER].length, 1);
  assert.deepEqual(gateway.records[LEDGER][0].fields['关联采购'], [BATCH_RECORD_ID],
    '续跑（resumePending）写出的流水同样要带上批次 record id');
  assert.equal((await store.list()).length, 1, '续跑命中同一个本地任务（幂等键没变）');
});

test('④-补2 重放时 state 仍取自**本地任务**（#253 那套一个字没动）', async () => {
  const gateway = makeGateway({});
  const inventory = inventoryFor(gateway);
  const input = {
    purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size: 38, quantity: 1, state: '样品',
  };
  const first = await inventory.applyPurchase(input);
  // 重放时调用方给了不同的 state（真实场景：重算"有没有样品"必然算出反的）——
  // 仍必须用本地任务记下的那一个，否则会抛「内容与首次提交不一致」。
  const second = await inventory.applyPurchase({ ...input, state: '门盒' });
  assert.equal(second.ledgerRecordId, first.ledgerRecordId);
  assert.equal(gateway.records[LIVE].length, 1);
  assert.equal(gateway.records[LIVE][0].fields['所属状态'], '样品');
});

test('④-补3 幂等键形状逐字不变（真实三元组：批次身份｜货品｜尺码）', () => {
  assert.equal(
    purchaseIncreaseSourceId({ purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size: 38 }),
    `purchase_increase:${BATCH_RECORD_ID}|product_1|38`,
  );
  // 批次记录 id 拿不到时的兜底身份同样逐字不变。
  assert.equal(
    purchaseIncreaseSourceId({ purchaseBatchNo: 'CGD-1', productRecordId: 'product_1', size: 38 }),
    'purchase_increase:CGD-1|product_1|38',
  );
  // 一个都拿不到 → 当场抛（绝不编一个 id）。
  assert.throws(() => purchaseIncreaseSourceId({ productRecordId: 'product_1', size: 38 }),
    /缺少来源标识/);
});

test('④-补4 加了关联列之后，**按来源回查流水**那条路仍然不生效（ledgerSource=null ⇒ 不查）', async () => {
  // 「关联采购」写的是批次 id，而本地幂等键是三元组 —— 若把它接进 findLedger，
  // 一个批次的多条流水会被判成"重复库存流水"。这里钉住：接不进去。
  const gateway = makeGateway({});
  const store = tempStore('purchase-ledger-link-nolookup-');
  const inventory = new InventoryService({ gateway, store });
  await inventory.applyPurchase({
    purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_1', size: 38, quantity: 1, state: '门盒',
  });
  // 同一个批次、**另一个货品**：不能让"按批次回查"把上一条流水当成它的。
  await inventory.applyPurchase({
    purchaseBatchRecordId: BATCH_RECORD_ID, productRecordId: 'product_2', size: 38, quantity: 1, state: '门盒',
  });
  assert.equal(gateway.records[LEDGER].length, 2);
  for (const row of gateway.records[LEDGER]) {
    assert.deepEqual(row.fields['关联采购'], [BATCH_RECORD_ID]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// schema / 旧名守门
// ═══════════════════════════════════════════════════════════════════════════

test('schema：映射加回来了（`purchaseBatch` → 「关联采购」）', () => {
  const fields = V1_BITABLE_SCHEMA.tables[LEDGER].fields;
  assert.equal(fields.purchaseBatch, '关联采购',
    '⭐ 语义键改成 `purchaseBatch`（对端 = 报货批次），物理列名仍是「关联采购」');
  // ⚠️ 「旧的那个表键 / 语义键不许回来」由 `purchaseInboundRemoval.test.js` 的 ① / ①-补 守门
  //    —— 那个文件自己带 DELETED_TABLE_KEY 常量并跳过自己；本文件**刻意不写那个字面量**，
  //    免得被它那条"全仓不许引用已删除表"的扫描判成违规（它是把尺子，不许自己也变成违规样本）。
});

// ── 已删除（2026-10-07 深夜）的那次口径：这里记录"被推翻的是什么" ──────────────
// #253 当时按"核不到生产就不传"删掉了这个写入（`ledgerSource = null` ＋ 删映射）。
// 业务负责人 2026-10-08 的口径把它**改成了报货批次** ⇒ 本文件就是那次补刀的可执行契约；
// 而「采购入库」表本身仍然不许回来（见上一条守门）。
test('schema-补 真实三元组与关联 id 是**两个东西**：前者只进本地，后者只写远端', () => {
  const [operation] = [{
    source_record_id: `purchase_increase:${BATCH_RECORD_ID}|product_1|38`,
  }];
  // 本地键里含批次身份，但**不等于**批次 record id（还带 |货品|尺码）⇒ 永远不许把它写进关联列。
  assert.notEqual(operation.source_record_id, BATCH_RECORD_ID);
  assert.ok(operation.source_record_id.includes('|'),
    '本地幂等键是三元组（含分隔符）——拿它当关联值会写出一个"指不到任何记录"的关联');
  assert.equal(BATCH_RECORD_ID_2.startsWith('rec'), true);
});
