/**
 * ⭐ 「采购入库」表被**整表删除**（业务负责人 2026-10-07 深夜）之后的**守门用例**。
 *
 * 她的口径（逐字）：
 *   「甲 **不再写任何入库明细**：只更新「报货批次」（到货状态=已到货 + 验收原话 + 确认状态）
 *    + **加库存**（库存流水 / 实时库存照写）—— 也就是"**入库明细表整个不要了**"」
 *
 * 五条必须钉住的事实（brief 点名的那五条）：
 *   ① 到货确认后**没有任何**「采购入库」写入（守门：全仓不再引用 `purchaseInbound`）
 *   ② **库存增加照旧**（12 件那样的逐条增加，`inventory.change.applied`）
 *   ③ 「报货批次」三值照写（到货状态=已到货 / 验收原话 / 确认状态）→ 全链路断言在
 *      `arrivalLandingOnBatch.test.js`（那份用例已按新口径更新）；本文件补"写的是什么"这侧
 *   ④ 幂等 / 重放**不重复加库存**
 *   ⑤ 9 点推送不受影响（仍按 到货状态=未到货 筛）→ 同样在 `arrivalLandingOnBatch.test.js` ⑥
 *
 * 本文件是**删除这一侧**的硬钉子：那张表**连读都不许读**（gateway 一被碰就抛），
 * 而库存这根线**一雙都不能少**（用**真实** `InventoryService` + 真实 `JsonTaskStore` 跑）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { InventoryService, STOCK_MOVEMENTS } = require('../src/services/inventoryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  V1_SCHEMA_SCOPES, V1_SIZE_LINK_TABLES, getV1SelectOptionContracts,
} = require('../src/config/v1SchemaScopes');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const SERVER_ROOT = path.join(__dirname, '..');
// 已删除的表：**表键**与它的环境变量。守门用例扫的就是这两个 token。
const DELETED_TABLE_KEY = 'purchaseInbound';
const DELETED_TABLE_ENV = 'FEISHU_V1_PURCHASE_INBOUND_TABLE_ID';
const PURCHASE_INCREASE_CODE = 'STOCK_PURCHASE_INCREASE';
const BATCH_NO = 'CGD-20261007-0001';
const BATCH_RECORD_ID = 'batch_1';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const SIZE_RECORDS = [36, 37, 38, 39, 40].map((size) => ({
  record_id: `size_${size}`, fields: { 尺码: size },
}));
const sizeLink = (size) => [`size_${size}`];

// 「库存流水」的「库存行为」要挂的那条：**库存环节**的编码（与采购环节的 PURCHASE_IN 是两套）。
const STOCK_BEHAVIOR = {
  record_id: 'bhv_stock_in',
  fields: {
    行为编码: PURCHASE_INCREASE_CODE, 行为名称: '采购增加', 库存方向: '增加', 是否启用: true,
  },
};

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

// 去注释后再扫：注释里要留沿革（"以前有一张「采购入库」表"），那不算引用。
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

// 结构化日志的出口就是 console.log/warn/error（src/utils/logger.js）。
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => {
      console.log = originals.log; console.warn = originals.warn; console.error = originals.error;
    },
  };
};

/**
 * 记录型 gateway：写入进 `writes`；`forbiddenKeys` 里的表**连读都不许读**
 * （一碰就抛 —— 用来钉死"那张表已经不存在了"）。
 */
const makeGateway = (records = {}, options = {}) => {
  const writes = [];
  const forbidden = new Set(options.forbiddenKeys || []);
  const guard = (key) => {
    if (forbidden.has(key)) throw new Error(`已删除的表不许再被访问：${key}`);
  };
  const mapFields = (tableKey, semanticValues) => {
    const schema = table(tableKey);
    const out = {};
    Object.entries(semanticValues || {}).forEach(([key, value]) => {
      const fieldName = schema?.fields?.[key];
      if (!fieldName) throw new Error(`未配置语义字段: ${tableKey}.${key}`);
      if (value !== undefined) out[fieldName] = value;
    });
    return out;
  };
  return {
    writes,
    records,
    table: (key) => { guard(key); return table(key); },
    validateTables: async () => [],
    get: async (key, recordId) => {
      guard(key);
      return (records[key] || []).find((item) => item.record_id === recordId) || null;
    },
    listAll: async (key) => {
      guard(key);
      if (key === 'sizeManagement') return SIZE_RECORDS;
      if (key === 'behavior' && !records.behavior) return [STOCK_BEHAVIOR];
      return records[key] || [];
    },
    create: async (key, semanticValues) => {
      guard(key);
      const fields = mapFields(key, semanticValues);
      writes.push({ op: 'create', tableKey: key, values: fields });
      const recordId = `new_${key}_${(records[key] || []).length + 1}`;
      const record = { record_id: recordId, fields };
      (records[key] ||= []).push(record);
      return { recordId, record };
    },
    update: async (key, recordId, semanticValues) => {
      guard(key);
      const patch = mapFields(key, semanticValues);
      writes.push({ op: 'update', tableKey: key, recordId, values: patch });
      const record = (records[key] || []).find((item) => item.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    delete: async (key, recordId) => {
      guard(key);
      writes.push({ op: 'delete', tableKey: key, recordId });
      return true;
    },
  };
};

const writesTo = (gateway, tableKey) => gateway.writes.filter((item) => item.tableKey === tableKey);

/** 种一条"她已经说完到货、等点确认"的任务（形状与生产上对话链路落盘的草稿一致）。 */
const seedArrivalTask = async (store, {
  taskId, batchRecordId = BATCH_RECORD_ID, batchNo = BATCH_NO,
  acceptanceText = '都到了', actual = [], requests = [],
  // ⭐ 2026-10-09：到货确认写进批次行的**结构化验收** = 「实际数量」「实际金额」
  //   （「验收原话 / 确认状态」两列已随生产表删列退场）。
  //   生产上这两个值由到货核对那一步算好放在草稿上；这里按 actual 逐行求和。
  actualQuantity = (actual || []).reduce((sum, item) => sum + Number(item?.quantity || 0), 0),
  actualAmount = 1200,
} = {}) => {
  await store.create({
    task_id: taskId, kind: 'arrival', record_id: batchRecordId, status: 'awaiting_confirmation',
  });
  await store.update(taskId, {
    recognized: [],
    draft: {
      batch_record_id: batchRecordId,
      batch_no: batchNo,
      acceptance_text: acceptanceText,
      actual_quantity: actualQuantity,
      actual_amount: actualAmount,
      direct_arrival: true,
      operator_open_id: 'ou_1',
      requests,
      actual,
      unrecognized: [],
      pending_creation: [],
      created_products: [],
      created_colors: [],
      creation_state: 'done',
      creation_error: '',
    },
  });
  return store.get(taskId);
};

/** 3 个货号 × 4 个尺码 = 12 行（brief 里"12 件那种"的形状），各申请 1 双。 */
const twelveRows = () => {
  const products = ['p1', 'p2', 'p3'];
  return products.flatMap((productId, index) => [37, 38, 39, 40].map((size) => ({
    product_record_id: productId,
    item_no: `XHB809${index}`,
    color: ['黑', '棕', '白'][index],
    size,
    quantity: 1,
  })));
};

const twelveRecords = () => {
  const products = ['p1', 'p2', 'p3'];
  return {
    purchaseOrderBatch: [{
      record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH_NO, 到货状态: '未到货' },
    }],
    product: products.map((id, index) => ({
      record_id: id, fields: { 货号: `XHB809${index}`, 颜色: ['黑', '棕', '白'][index] },
    })),
    purchaseRequest: twelveRows().map((row) => ({
      record_id: `req_${row.product_record_id}_${row.size}`,
      fields: {
        报货批次号: [BATCH_RECORD_ID], 编号: [row.product_record_id],
        尺码: sizeLink(row.size), 数量: 1,
      },
    })),
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// ① 守门：全仓不再引用「采购入库」表
// ═══════════════════════════════════════════════════════════════════════════

test('① 守门：全仓（src/public/scripts/test）不再引用已删除的「采购入库」表', () => {
  const roots = ['src', 'public', 'scripts', 'test'].map((dir) => path.join(SERVER_ROOT, dir));
  const guardFile = path.basename(__filename);
  const offenders = [];
  for (const file of roots.flatMap((root) => walk(root))) {
    if (!/\.(js|mjs|cjs|html)$/.test(file)) continue;
    // ⚠️ 跳过**本文件自己** —— 它就是"抓这个词"的那把尺子，不能把自己也当成违规。
    if (path.basename(file) === guardFile) continue;
    const codeOnly = stripComments(fs.readFileSync(file, 'utf8'));
    const hits = [];
    if (new RegExp(`['"]${DELETED_TABLE_KEY}['"]`).test(codeOnly)) hits.push('表键');
    if (new RegExp(DELETED_TABLE_ENV).test(codeOnly)) hits.push('表 ID 环境变量');
    if (new RegExp(`tables\\.${DELETED_TABLE_KEY}\\b`).test(codeOnly)) hits.push('schema 取表');
    if (new RegExp(`fields\\.${DELETED_TABLE_KEY}\\b`).test(codeOnly)) hits.push('读/写它的字段映射');
    if (hits.length) offenders.push(`${path.relative(SERVER_ROOT, file)}（${hits.join('、')}）`);
  }
  assert.deepEqual(offenders, [], `已删除的表不许再被引用：\n${offenders.join('\n')}`);
});

test('①-补 schema / 范围 / 尺码关联清单里都没有它了；「关联采购」映射指向的是**报货批次**', () => {
  assert.equal(V1_BITABLE_SCHEMA.tables[DELETED_TABLE_KEY], undefined,
    '「采购入库」表已被业务负责人整个删除 ⇒ schema 里不许再有这一段');
  const ledgerFields = V1_BITABLE_SCHEMA.tables.inventoryLedger.fields;
  assert.equal(Object.prototype.hasOwnProperty.call(ledgerFields, DELETED_TABLE_KEY), false,
    '「库存流水.关联采购」原来指向的就是那张被删的表 ⇒ 那个**语义键名**不许回来');
  // ⭐ 2026-10-08 补刀：业务负责人在真表里把「关联采购」**改成了指向「报货批次」**
  //    ⇒ 映射**加回来**（新的语义键名 `purchaseBatch`），写的是批次那一行的 record id。
  //    详见 `purchaseLedgerBatchLink.test.js` 与 docs/purchase-ledger-batch-link-2026-10-08.md。
  assert.equal(ledgerFields.purchaseBatch, '关联采购',
    '「关联采购」这一列还在（她已改成指向报货批次）⇒ 映射必须指向它');
  // 它自己的来源字段（ledgerSource）仍必须是 null：`ledgerSource` 是**参与幂等/恢复**的
  // "按来源回查"字段，而一个批次对应多条流水（值还带 |货品|尺码）⇒ 不能拿它顶上。
  assert.equal(STOCK_MOVEMENTS[PURCHASE_INCREASE_CODE].ledgerSource, null,
    'ledgerSource 必须仍为 null（补的是"只写不查"的关联列，不是把按来源回查接回来）');

  for (const scope of ['purchase', 'inventory', 'all']) {
    assert.equal(V1_SCHEMA_SCOPES[scope].includes(DELETED_TABLE_KEY), false,
      `范围 ${scope} 里不许再有这张表（否则部署闸门会去问一张不存在的表）`);
    assert.equal(V1_SIZE_LINK_TABLES[scope].includes(DELETED_TABLE_KEY), false,
      `范围 ${scope} 的尺码关联清单里不许再有它`);
  }
});

test('①-补2 「采购入库」行的「采购行为」配置随入库行一起退场（不再有读取点）', () => {
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'src/config/purchaseBehaviors.js')), false,
    '那个配置模块的唯一消费者是入库行的「采购行为」⇒ 随之退场');
  const files = walk(path.join(SERVER_ROOT, 'src')).filter((file) => file.endsWith('.js'));
  const offenders = files.filter((file) =>
    /PURCHASE_BEHAVIORS/.test(stripComments(fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(offenders.map((file) => path.relative(SERVER_ROOT, file)), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// ①/② 到货确认：那张表**连读都不读**，但库存照加
// ═══════════════════════════════════════════════════════════════════════════

test('① 到货确认真实链路：一碰「采购入库」表就抛 —— 全程零访问、零写入；库存照加 12 次', async () => {
  const gateway = makeGateway(twelveRecords(), { forbiddenKeys: [DELETED_TABLE_KEY] });
  const inventoryCalls = [];
  const inventory = {
    async applyPurchase(input) {
      inventoryCalls.push(input);
      return { ledgerRecordId: `led_${inventoryCalls.length}`, liveRecordIds: [`live_${inventoryCalls.length}`] };
    },
  };
  const store = new JsonTaskStore({ dir: tempDir('inbound-removal-'), idField: 'task_id' });
  const webhook = new PurchaseWebhookService({
    client: {}, gateway, store, inventory, images: { render: async () => Buffer.from('png') },
  });
  const rows = twelveRows();
  const task = await seedArrivalTask(store, {
    taskId: 'arrival_no_inbound',
    actual: rows,
    requests: gateway.records.purchaseRequest,
  });

  const result = await webhook.confirmArrival(task.task_id, task, 'ou_1');

  assert.equal(result.toast.type, 'success');
  assert.deepEqual(writesTo(gateway, DELETED_TABLE_KEY), [], '那张表一个字都不许写');
  assert.equal(inventoryCalls.length, 12, '12 行 → 12 次加库存（一行都不能少）');
  // 「报货批次」那一行照旧写上**结构化验收**（2026-10-09 起只有实际数量 / 实际金额；
  // 「验收原话」「确认状态」两列已随生产表删列一起退场 ⇒ 一个字都不写）。
  const batchWrites = writesTo(gateway, 'purchaseOrderBatch');
  assert.ok(batchWrites.some((item) => item.values['实际数量'] === 12), '「实际数量」要写到批次行');
  for (const write of batchWrites) {
    assert.equal('验收原话' in (write.values || {}), false, '「验收原话」已退场，不许再写');
    assert.equal('确认状态' in (write.values || {}), false, '「确认状态」已退场，不许再写');
  }
  // ⚠️ 飞书自动字段一个字都不写（到货日 = 更新时间、验收人 = 创建人）。
  for (const write of gateway.writes) {
    assert.equal('到货日' in (write.values || {}), false);
    assert.equal('验收人' in (write.values || {}), false);
  }
});

test('② 真实库存引擎：12 行 → 9 条流水 / 9 双实时库存；`inventory.change.applied` 9 条', async () => {
  // 12 行里 3 行是"实际 0 双"（她在话题里说"这三行没到"）——那 3 行连库存都不该动。
  const gateway = makeGateway(twelveRecords(), { forbiddenKeys: [DELETED_TABLE_KEY] });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: tempDir('inventory-'), idField: 'operation_id' }),
  });
  const store = new JsonTaskStore({ dir: tempDir('inbound-removal-'), idField: 'task_id' });
  const webhook = new PurchaseWebhookService({
    client: {}, gateway, store, inventory, images: { render: async () => Buffer.from('png') },
  });
  const rows = twelveRows().filter((row) => !(row.product_record_id === 'p3' && row.size !== 40));
  const task = await seedArrivalTask(store, {
    taskId: 'arrival_inventory', actual: rows, requests: gateway.records.purchaseRequest,
  });

  const logs = captureLogs();
  let result;
  try {
    result = await webhook.confirmArrival(task.task_id, task, 'ou_1');
  } finally {
    logs.restore();
  }

  assert.equal(result.toast.type, 'success');
  const ledger = gateway.records.inventoryLedger || [];
  const live = gateway.records.liveInventory || [];
  assert.equal(rows.length, 9);
  assert.equal(ledger.length, 9, '一个（货品+尺码）一条「库存流水」');
  assert.equal(live.length, 9, '每一行按**实际数**（1 双）加库存 —— 一雙都不能少');
  assert.equal(logs.events('inventory.change.applied').length, 9, '正向证据：9 条「库存已加」日志');
  // ⭐ 2026-10-08 补刀：业务负责人把「关联采购」改成指向**「报货批次」**
  //    ⇒ 采购加库存的流水**带上**批次那一行的 record id（真实链路端到端，AC-10）。
  for (const row of ledger) {
    assert.deepEqual(row.fields['关联采购'], [BATCH_RECORD_ID],
      '「关联采购」= 报货批次那一行的 record id（她 2026-10-08 的口径）');
    assert.equal('关联销售' in row.fields, false, '采购加库存不该挂销售来源');
    assert.deepEqual(row.fields['库存行为'], ['bhv_stock_in'], '「库存行为」仍是库存环节那条编码');
    assert.equal(row.fields['变动数量'], 1);
  }
  // 「所属状态」仍按她的老口径：该货号还没有样品 → 样品；有了 → 门盒。
  const states = live.map((row) => row.fields['所属状态']);
  assert.equal(states.filter((state) => state === '样品').length, 3, '每个货号第一雙先入样品');
  assert.equal(states.filter((state) => state === '门盒').length, 6);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 幂等 / 重放不重复加库存
// ═══════════════════════════════════════════════════════════════════════════

test('④ 幂等：草稿里的进度丢了（崩溃恢复）→ 重放用**同一个来源标识**，流水仍 9 条、库存仍 9 双', async () => {
  const gateway = makeGateway(twelveRecords(), { forbiddenKeys: [DELETED_TABLE_KEY] });
  const inventoryStore = new JsonTaskStore({ dir: tempDir('inventory-replay-'), idField: 'operation_id' });
  const inventory = new InventoryService({ gateway, store: inventoryStore });
  const store = new JsonTaskStore({ dir: tempDir('inbound-removal-'), idField: 'task_id' });
  const webhook = new PurchaseWebhookService({
    client: {}, gateway, store, inventory, images: { render: async () => Buffer.from('png') },
  });
  const rows = twelveRows().filter((row) => !(row.product_record_id === 'p3' && row.size !== 40));
  const task = await seedArrivalTask(store, {
    taskId: 'arrival_replay', actual: rows, requests: gateway.records.purchaseRequest,
  });

  await webhook.confirmArrival(task.task_id, task, 'ou_1');
  const firstOperations = await inventoryStore.list();
  assert.equal(firstOperations.length, 9, '9 个（货品+尺码）→ 9 条本地库存任务');
  assert.equal(gateway.records.inventoryLedger.length, 9);

  // 模拟"写完远端、本地草稿没落盘"：把进度抹掉、状态退回 posting（崩溃恢复的形状）。
  const after = await store.get(task.task_id);
  await store.update(task.task_id, {
    status: 'posting',
    draft: { ...after.draft, inventory_applied: {}, inbound_created: {} },
  });
  const again = await webhook.confirmArrival(task.task_id, await store.get(task.task_id), 'ou_1');
  assert.equal(again.toast.type, 'success');

  assert.equal(gateway.records.inventoryLedger.length, 9, '重放不得再写一条流水');
  assert.equal(gateway.records.liveInventory.length, 9, '重放不得把库存变成 18 双');
  assert.equal((await inventoryStore.list()).length, 9,
    '重放必须命中**同一个来源标识**（否则会出现第 10…18 条库存任务）');
  // 批次行的写入本身也是幂等的（写的是同一个值）。
  assert.equal(gateway.records.purchaseOrderBatch.length, 1);
  assert.deepEqual(writesTo(gateway, DELETED_TABLE_KEY), []);
});

test('④-补 来源标识由**真实三元组**（批次记录 id | 货品 | 尺码）决定，一个都不是编的', async () => {
  const gateway = makeGateway(twelveRecords(), { forbiddenKeys: [DELETED_TABLE_KEY] });
  const inventoryStore = new JsonTaskStore({ dir: tempDir('inventory-source-'), idField: 'operation_id' });
  const inventory = new InventoryService({ gateway, store: inventoryStore });
  const store = new JsonTaskStore({ dir: tempDir('inbound-removal-'), idField: 'task_id' });
  const webhook = new PurchaseWebhookService({
    client: {}, gateway, store, inventory, images: { render: async () => Buffer.from('png') },
  });
  const rows = twelveRows().filter((row) => row.product_record_id === 'p1');
  const task = await seedArrivalTask(store, {
    taskId: 'arrival_source', actual: rows, requests: gateway.records.purchaseRequest,
  });
  await webhook.confirmArrival(task.task_id, task, 'ou_1');

  const operations = await inventoryStore.list();
  assert.equal(operations.length, 4);
  // 本地任务上记着 `source_record_id`：它必须把**真实标识**串起来，便于按批次排查。
  for (const operation of operations) {
    assert.match(operation.source_record_id, new RegExp(`^[^|]*${BATCH_RECORD_ID}[^|]*\\|p1\\|(3[789]|40)$`),
      `来源标识要带上真实的批次记录 id / 货品 / 尺码：${operation.source_record_id}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// F 表名同步：具体信息 → 报货信息（tableId 不变）
// G 单选「确认状态」纳入部署闸门契约
// ═══════════════════════════════════════════════════════════════════════════

test('F 「具体信息」已改名「报货信息」：tableName 同步、tableId 与语义键一个都没动', () => {
  const request = V1_BITABLE_SCHEMA.tables.purchaseRequest;
  assert.equal(request.tableName, '报货信息', '她的口径：这张表现在叫「报货信息」');
  assert.equal(request.tableId, 'tbli1ygPtss5CWCH', 'tableId 不变（闸门按 tableId 校验，改了就全红）');
  // ⚠️ 语义键名 `purchaseRequest` **可以不动**（brief 明确）——只改 tableName 与用户可见文案。
  assert.equal(V1_BITABLE_SCHEMA.tables.purchaseRequest, request);
  for (const semanticKey of ['detailId', 'batchNo', 'behavior', 'product', 'size', 'quantity', 'idempotencyKey']) {
    assert.ok(request.fields[semanticKey], `语义键 ${semanticKey} 必须还在（这次不动映射）`);
  }
});

test('F-补 工作台采购页的用户可见文案里没有「具体信息」了', () => {
  const rel = 'public/workbench/features/purchase/index.js';
  const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
  const codeOnly = stripComments(source);
  assert.equal(codeOnly.includes('具体信息'), false, `${rel} 里还有「具体信息」文案`);
  assert.ok(codeOnly.includes('报货信息'), `${rel} 要改成「报货信息」`);
});

test('G ⛔ 「报货批次.确认状态」整条退场 ⇒ 它的单选取值契约也删掉（契约只剩到货状态）', () => {
  // 2026-10-09 只读核对生产真表：报货批次 12 列里**没有**「确认状态」⇒
  // 契约留着 = 部署闸门去问一列不存在的字段、直接判红，所以它与
  // `config/purchaseAcceptance.js` 一起退场。
  const contracts = getV1SelectOptionContracts('purchase');
  assert.equal(contracts.some((item) => item.fieldKey === 'confirmStatus'), false,
    '确认状态那一列不存在了 ⇒ 契约里不许再有它');
  const arrival = contracts.find((item) => item.fieldKey === 'arrivalStatus');
  assert.deepEqual(arrival.requiredOptions, ['未到货', '已到货']);
  // inventory 范围不该被带上「报货批次」的任何契约。
  assert.deepEqual(getV1SelectOptionContracts('inventory'), []);
});
