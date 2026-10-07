// 写入类日志的「能串起来」的键 ＋ 库存键两种写法并列（2026-10-07 业务负责人拍板「日志改下吧！」）。
//
// 这个文件钉住的是**日志本身**，不是业务行为：
//   ① 一条销售被劈成两半 —— 真正写库的那半（sales.status.written / bitable.record.created /
//      v1.sale.posted / inventory.change.applied）必须和 lark.sales.* 那半带同一个键，
//      按 `task_id`（或 `order_no`）一个 grep 就能串起整条链；
//   ② 「库存键」两种写法并列：`stock_key`（内部，原值不动）＋ `stock_key_label`（货号|颜色|类别|尺码）。
//
// ⚠️ 为什么用**真实的 V1BitableGateway**（只把飞书 client 换成内存假 Base）：
//    `bitable.record.created/updated` 是**网关层**打的日志，只有让真实网关跑，
//    才证明得了"业务层传下去的关联键真的到了那条日志上"。用假 gateway 测等于什么都没测。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ⚠️ 必须在 require v1BitableSchema **之前**设好：schema 是模块级对象字面量，
//    tableId 在 require 那一刻求值一次（「尺码管理」这类表没有硬编码兜底，
//    漏设就会拿到空串，然后在 tableWithId 当场抛「未配置 table_id」）。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.FEISHU_V1_SIZE_TABLE_ID = process.env.FEISHU_V1_SIZE_TABLE_ID || 'tbl_size_test';
process.env.FEISHU_V1_ACCESSORY_TABLE_ID = process.env.FEISHU_V1_ACCESSORY_TABLE_ID || 'tbl_accessory_test';

const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA: SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { CORRELATION_KEYS, correlationFields, mergeCorrelation } = require('../src/utils/correlationFields');

// ── 日志抓取（与 salesMvp.test.js 同一个写法：抓的是 logger 真正打出去的那一行 JSON）──
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    logs: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)).map((line) => JSON.parse(line)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

// ── 内存假 Base：字段名仍然走 v1BitableSchema 的**真实中文列名** ────────────────────
// 假的是"网络"，不是"字段映射"：写错列名这里也会当场抛（与线上同形）。
const tableKeyById = () => {
  const map = new Map();
  for (const [key, table] of Object.entries(SCHEMA.tables)) {
    if (table.tableId) map.set(table.tableId, key);
  }
  return map;
};

// 字段元数据：只给三个有类型要求的列真类型（尺码数字 / 尺码单选关联 / 其余文本），
// 其余一律 type=1。尺码的类型是 sizeReferenceService.validateSchema 的硬要求。
const fieldMetaOf = (tableKey) => Object.entries(SCHEMA.tables[tableKey].fields).map(([key, fieldName]) => {
  if (key === 'size') {
    return tableKey === 'sizeManagement'
      ? { field_name: fieldName, type: 2 }
      : { field_name: fieldName, type: 18,
        property: { table_id: SCHEMA.tables.sizeManagement.tableId, multiple: false } };
  }
  return { field_name: fieldName, type: 1 };
});

const fakeLarkClient = (records) => {
  const byId = tableKeyById();
  let seq = 0;
  const listOf = (tableId, { create = false } = {}) => {
    const key = byId.get(tableId);
    if (!records.has(key)) {
      if (!create) return [];
      records.set(key, []);
    }
    return records.get(key);
  };
  const find = (tableId, recordId) => listOf(tableId).find((row) => row.record_id === recordId);
  return {
    bitable: {
      appTableField: {
        list: async ({ path }) => ({
          code: 0,
          data: { items: fieldMetaOf(byId.get(path.table_id)), has_more: false },
        }),
      },
      appTableRecord: {
        create: async ({ path, data }) => {
          const record = { record_id: `rec_${++seq}`, fields: { ...data.fields } };
          listOf(path.table_id, { create: true }).push(record);
          return { code: 0, data: { record } };
        },
        update: async ({ path, data }) => {
          const record = find(path.table_id, path.record_id);
          if (!record) return { code: 1254043, msg: 'RecordIdNotFound' };
          Object.assign(record.fields, data.fields);
          return { code: 0, data: { record } };
        },
        get: async ({ path }) => {
          const record = find(path.table_id, path.record_id);
          if (!record) return { code: 1254043, msg: 'RecordIdNotFound' };
          return { code: 0, data: { record } };
        },
        delete: async ({ path }) => {
          const list = listOf(path.table_id);
          const index = list.findIndex((row) => row.record_id === path.record_id);
          if (index >= 0) list.splice(index, 1);
          return { code: 0, data: {} };
        },
        list: async ({ path }) => ({
          code: 0,
          data: { items: listOf(path.table_id).slice(), has_more: false },
        }),
      },
    },
  };
};

const SHOE = { itemNo: '8088-26', size: 40, quantity: 1, actualAmount: 220 };
const LABEL = '5801-38|灰色|B|38';

const makeWorld = ({ withStockKeyLabel = true } = {}) => {
  const records = new Map([
    ['salesEntry', [{ record_id: 'rec_sale', fields: { 销售单号: 'XSD-20261007-0004' } }]],
    ['sizeManagement', [{ record_id: 'size_40', fields: { 尺码: 40 } }]],
    ['behavior', [{ record_id: 'behavior_sale', fields: {
      行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
    } }]],
    ['liveInventory', [{ record_id: 'live_1', fields: {
      ...(withStockKeyLabel ? { 库存键: LABEL } : {}),
      所属状态: '门盒', 编号: ['product_rec'], 尺码: ['size_40'],
    } }]],
  ]);
  const gateway = new V1BitableGateway({ client: fakeLarkClient(records) });
  // 「货品信息」这张表**一次都不该被读**：人类可读那串是抄实时库存上飞书算好的「库存键」，
  // 不是拿货号/颜色重新拼出来的（拼就得多读一次表）。这个计数就是这条边界的证明。
  let productReads = 0;
  for (const method of ['get', 'listAll', 'create', 'update']) {
    const original = gateway[method].bind(gateway);
    gateway[method] = async (...args) => {
      if (args[0] === 'product') productReads += 1;
      return original(...args);
    };
  }
  const references = {
    resolveProduct: async () => ({ recordId: 'product_rec' }),
    resolvePaymentMethod: async () => ({ recordId: 'method_wechat' }),
  };
  const store = () => new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'log-correlation-')), idField: 'operation_id',
  });
  return { gateway, references, records, store, productReads: () => productReads };
};

const CORRELATION = { task_id: 'sale_om_test', sales_entry_record_id: 'rec_sale' };

// 走完整条链：确认入账（明细 + 收款 + 状态）→ 交付（扣库存 + 写库存状态）。
const postAndDeliver = async (world, correlation = CORRELATION, input = {}) => {
  const sale = new SalesOrderService({ gateway: world.gateway, references: world.references });
  const posted = await sale.confirm({
    salesEntryRecordId: 'rec_sale',
    items: [SHOE],
    payments: [{ method: '微信', amount: 220 }],
    ...input,
  }, { correlation });
  const delivery = new SalesDeliveryService({
    gateway: world.gateway, inventory: new InventoryService({ gateway: world.gateway, store: world.store() }),
  });
  const result = await delivery.deliver({
    salesEntryRecordId: 'rec_sale', detailRecordIds: posted.detailRecordIds,
    paymentRecordIds: posted.paymentRecordIds,
  }, { correlation });
  return { posted, result };
};

// ── ① 关联键的取用口：白名单 / 去空 / 不认的对象 ────────────────────────────────
test('correlationFields：只放行白名单里的业务键，其余（含疑似密钥）一个都不进日志', () => {
  // ⚠️ 这条断言**2026-10-07 下半场改过一次**（接了采购链路）：白名单**只增不改**，
  //    仍然是**逐字** deepEqual（没有放宽成 includes —— 多一个键就必须有人来这里改一次）。
  assert.deepEqual([...CORRELATION_KEYS], [
    // 销售链路
    'task_id', 'order_no', 'sales_entry_record_id',
    // 采购链路
    'batch_no', 'purchase_report_record_id', 'purchase_arrival_record_id',
  ]);

  const picked = correlationFields({
    task_id: 'sale_om_1',
    order_no: 'XSD-20261007-0004',
    sales_entry_record_id: 'rec_sale',
    batch_no: '202610071',
    purchase_report_record_id: 'rec_purchase_report',
    purchase_arrival_record_id: 'rec_purchase_arrival',
    // 下面这些**故意**混进来：白名单是"以后谁顺手塞了密钥"的唯一一道闸门。
    app_secret: 'cli_secret_should_never_be_logged',
    authorization: 'Bearer xyz',
    随便一个键: 'v',
    // 「看起来很像但不在白名单里」的也一律拒掉（**别为了省事把前缀放进白名单**）：
    purchase_batch_no: '202610071',
    stock_key: 'rec28ecYW0lkvL|38|门盒',
  });
  assert.deepEqual(picked, {
    task_id: 'sale_om_1', order_no: 'XSD-20261007-0004', sales_entry_record_id: 'rec_sale',
    batch_no: '202610071', purchase_report_record_id: 'rec_purchase_report',
    purchase_arrival_record_id: 'rec_purchase_arrival',
  });
  assert.equal(JSON.stringify(picked).includes('secret'), false, '密钥不许出现在日志字段里');
  assert.equal(JSON.stringify(picked).includes('stock_key'), false, '非白名单键一个都不许进');
});

test('correlationFields：没有的键【不出现】（不是写空串），非对象/空对象返回 {}', () => {
  assert.deepEqual(correlationFields({ task_id: '  ', order_no: '', sales_entry_record_id: null }), {});
  assert.deepEqual(correlationFields({ task_id: 42 }), { task_id: '42' });
  assert.deepEqual(correlationFields(undefined), {});
  assert.deepEqual(correlationFields(null), {});
  assert.deepEqual(correlationFields('sale_om_1'), {}, '字符串不是关联键的来源');
  assert.deepEqual(mergeCorrelation({ task_id: 'a' }, undefined, { order_no: 'b' }),
    { task_id: 'a', order_no: 'b' });
  // 采购那几个键同样"空值就是不出现"（`batch_no: ''` 不许写成 `"batch_no":""`）。
  assert.deepEqual(correlationFields({
    batch_no: '', purchase_report_record_id: '  ', purchase_arrival_record_id: null,
  }), {});
  assert.deepEqual(mergeCorrelation({ task_id: 'purchase_supplier-report_x' }, { batch_no: '202610071' }), {
    task_id: 'purchase_supplier-report_x', batch_no: '202610071',
  });
});

// ── ② 网关层：日志字段从哪来、既有字段一个不少 ────────────────────────────────
test('网关层：给了关联键就带上；没给就一个都不出现（既有字段一个不少）', async () => {
  const records = new Map([['sample', []]]);
  const gateway = new V1BitableGateway({
    schema: { appToken: 'app_v1', tables: {
      sample: { tableName: '测试表', tableId: 'tbl_sample', fields: { name: '名称' } },
    } },
    client: fakeLarkClient(records),
  });

  const logs = captureLogs();
  let created;
  let plain;
  try {
    created = await gateway.create('sample', { name: 'A' }, { correlation: CORRELATION });
    plain = await gateway.create('sample', { name: 'B' });
    await gateway.update('sample', created.recordId, { name: 'C' }, { correlation: CORRELATION });
    await gateway.update('sample', plain.recordId, { name: 'D' });
  } finally {
    logs.restore();
  }

  const createdLogs = logs.logs('bitable.record.created');
  assert.equal(createdLogs.length, 2);
  // a. 新字段真的在（三条都进）
  assert.equal(createdLogs[0].task_id, 'sale_om_test');
  assert.equal(createdLogs[0].order_no, undefined, '没给 order_no 就不该凭空冒出来');
  assert.equal(createdLogs[0].sales_entry_record_id, 'rec_sale');
  // b. 既有字段一个都不少（这条日志原来的样子）
  assert.equal(createdLogs[0].table_key, 'sample');
  assert.equal(createdLogs[0].table_id, 'tbl_sample');
  assert.equal(createdLogs[0].record_id, created.recordId);
  assert.equal(typeof createdLogs[0].duration_ms, 'number');
  // c. 不传关联键 = 三个键一个都不出现（不是空串）
  for (const key of CORRELATION_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(createdLogs[1], key), false, `未传时不该有 ${key}`);
  }

  const updatedLogs = logs.logs('bitable.record.updated');
  assert.equal(updatedLogs.length, 2);
  assert.equal(updatedLogs[0].task_id, 'sale_om_test');
  assert.equal(updatedLogs[0].sales_entry_record_id, 'rec_sale');
  assert.equal(updatedLogs[0].record_id, created.recordId);
  assert.equal(updatedLogs[0].table_key, 'sample');
  for (const key of CORRELATION_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(updatedLogs[1], key), false);
  }
});

// ── ③ 整条链：一个键串起「卡片那半」和「写库那半」 ──────────────────────────────
test('端到端：确认入账 → 交付，写库的每一条日志都带同一个 task_id / 单号', async () => {
  const world = makeWorld();
  const logs = captureLogs();
  try {
    await postAndDeliver(world);
  } finally {
    logs.restore();
  }

  // 这五条以前**一个键都没有**（正是"一条销售被劈成两半"里看不见的那半）。
  // `always` = 每一行都必须有的；`existing` = 这一条日志改动前就有的字段，一个都不许少。
  const expectations = [
    ['sales.status.written', { dimensions: ['sales', 'funds'] },
      { sales_entry_record_id: 'rec_sale', dimensions: ['sales', 'funds'] }],
    ['v1.sale.posted', {}, { sales_entry_record_id: 'rec_sale', detail_count: 1, payment_count: 1,
      step: 'posting', inventory_applied_by_this_step: false }],
    ['sales.inventory.applied', {}, { sales_entry_record_id: 'rec_sale', stock_status: '已写入' }],
    ['inventory.change.applied', {}, { kind: 'STOCK_SALE_DECREASE' }],
    ['sales.delivery.completed', {}, { sales_entry_record_id: 'rec_sale', detail_count: 1 }],
  ];
  for (const [event, onlyFor, existing] of expectations) {
    const rows = logs.logs(event).filter((row) => Object.entries(onlyFor)
      .every(([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value)));
    assert.ok(rows.length >= 1, `${event} 必须记下来`);
    for (const row of rows) {
      // a. task_id / sales_entry_record_id 每一行都在（这两个键在这一层永远知道）
      assert.equal(row.task_id, 'sale_om_test', `${event}.task_id`);
      assert.equal(row.sales_entry_record_id, 'rec_sale', `${event}.sales_entry_record_id`);
      // b. 既有字段一个都不少
      for (const [key, value] of Object.entries(existing)) {
        assert.deepEqual(row[key], value, `${event}.${key} 既有字段必须原样在`);
      }
    }
  }

  // ⚠️ `order_no` 不是每一行都有，这是**有意**的、有原因的：
  //    `v1.sale.posted` 之前那两次「入账中」状态写入发生在**读销售主表之前**
  //    （原顺序：先写状态 → 再读主表拿交易类型），而单号只在那条主表记录上。
  //    为了补一个日志字段去把写入顺序调过来 —— 明确不做。
  //    从读主表那一刻起的每一条都必须有单号。
  const withOrderNo = [
    'v1.sale.posted', 'sales.inventory.applied', 'sales.delivery.completed', 'inventory.change.applied',
  ];
  for (const event of withOrderNo) {
    for (const row of logs.logs(event)) {
      assert.equal(row.order_no, 'XSD-20261007-0004', `${event}.order_no`);
    }
  }
  // 网关层那几条写入也必须有单号（同一段链路，读主表之后）。
  for (const row of logs.logs('bitable.record.created')) {
    assert.equal(row.order_no, 'XSD-20261007-0004', `bitable.record.created(${row.table_key}).order_no`);
  }
  // 状态写入：读过主表之后的那几次（sales / funds / stock）必须有单号。
  for (const row of logs.logs('sales.status.written')) {
    if (row.dimensions.length === 1) {
      assert.equal(row.order_no, 'XSD-20261007-0004', `sales.status.written(${row.dimensions}).order_no`);
    }
  }

  // 网关层那三条：销售明细 / 收款明细 / 库存流水 —— 以前只能靠时间窗口去接。
  const createdByTable = new Map(logs.logs('bitable.record.created').map((row) => [row.table_key, row]));
  for (const tableKey of ['salesDetail', 'paymentRecord', 'inventoryLedger']) {
    const row = createdByTable.get(tableKey);
    assert.ok(row, `必须真的写过 ${tableKey}（否则这条用例测不到东西）`);
    assert.equal(row.task_id, 'sale_om_test', `bitable.record.created(${tableKey}).task_id`);
    assert.equal(row.order_no, 'XSD-20261007-0004');
    assert.equal(row.sales_entry_record_id, 'rec_sale');
    assert.equal(typeof row.record_id, 'string');
    assert.equal(typeof row.duration_ms, 'number');
  }
  // 销售主表的两次状态/履约更新走的是 updated 那条，同样带键。
  const updatedEntry = logs.logs('bitable.record.updated').filter((row) => row.table_key === 'salesEntry');
  assert.ok(updatedEntry.length >= 1);
  for (const row of updatedEntry) assert.equal(row.task_id, 'sale_om_test');

  // 一句话验收：**一个 grep 就能串起来** —— 上面所有事件里都出现同一个 task_id。
  const chained = logs.lines.filter((line) => line.includes('"task_id":"sale_om_test"'));
  for (const event of expectations.map(([name]) => name)) {
    assert.ok(chained.some((line) => line.includes(`"event":"${event}"`)),
      `${event} 必须能被 task_id 一把 grep 到`);
  }
});

// ── ④ 库存键两种写法并列，且**不额外请求** ────────────────────────────────────
test('inventory.change.applied：stock_key 原值不动 ＋ stock_key_label 抄飞书算好的那串，零额外请求', async () => {
  const world = makeWorld();
  const logs = captureLogs();
  try {
    await postAndDeliver(world);
  } finally {
    logs.restore();
  }

  const applied = logs.logs('inventory.change.applied');
  assert.equal(applied.length, 1);
  // a. 内部键**原值不动**（既有排查脚本 / 断言依赖它）
  assert.equal(applied[0].stock_key, 'product_rec|40|门盒');
  // b. 人类可读那串逐字就是飞书算出来的（不是代码重新拼的）
  assert.equal(applied[0].stock_key_label, LABEL);
  assert.equal(applied[0].stock_key_label_source, 'live_inventory');
  // c. 既有字段一个不少
  assert.equal(applied[0].kind, 'STOCK_SALE_DECREASE');
  assert.equal(applied[0].movement_quantity, 1);
  assert.equal(applied[0].direction, '减少');
  assert.equal(applied[0].target_quantity, 0);
  assert.equal(typeof applied[0].ledger_record_id, 'string');
  assert.deepEqual(applied[0].live_record_ids, ['live_1']);
  // d. ⭐ 零额外请求：为了拼那串**一次都没读「货品信息」**
  assert.equal(world.productReads(), 0, 'human-readable 那串是抄来的，不该为了它去读货品表');
});

test('拿不到人类可读那串时如实说 unavailable，绝不猜一个（stock_key 照旧在）', async () => {
  const world = makeWorld({ withStockKeyLabel: false });
  const logs = captureLogs();
  try {
    await postAndDeliver(world);
  } finally {
    logs.restore();
  }

  const applied = logs.logs('inventory.change.applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].stock_key, 'product_rec|40|门盒');
  assert.equal(applied[0].stock_key_label, undefined, '抄不到就不写这个字段，不猜');
  assert.equal(applied[0].stock_key_label_source, 'unavailable');
  assert.equal(world.productReads(), 0);
});

// ── ⑤ 关联键是"每次调用显式传的"，不是实例状态（跨请求不串台） ─────────────────
test('同一个 service 实例连跑两笔单：各自的日志带各自的键，不互相串台', async () => {
  const world = makeWorld();
  const sale = new SalesOrderService({ gateway: world.gateway, references: world.references });
  world.records.get('salesEntry').push({ record_id: 'rec_sale_2', fields: { 销售单号: 'XSD-20261007-0005' } });

  const logs = captureLogs();
  try {
    await Promise.all([
      sale.confirm({ salesEntryRecordId: 'rec_sale', items: [SHOE],
        payments: [{ method: '微信', amount: 220 }] },
      { correlation: { task_id: 'sale_om_A', sales_entry_record_id: 'rec_sale' } }),
      sale.confirm({ salesEntryRecordId: 'rec_sale_2', items: [SHOE],
        payments: [{ method: '微信', amount: 220 }] },
      { correlation: { task_id: 'sale_om_B', sales_entry_record_id: 'rec_sale_2' } }),
    ]);
  } finally {
    logs.restore();
  }

  const rows = logs.logs('v1.sale.posted');
  assert.equal(rows.length, 2);
  const ofA = rows.find((row) => row.sales_entry_record_id === 'rec_sale');
  const ofB = rows.find((row) => row.sales_entry_record_id === 'rec_sale_2');
  assert.equal(ofA.task_id, 'sale_om_A');
  assert.equal(ofA.order_no, 'XSD-20261007-0004');
  assert.equal(ofB.task_id, 'sale_om_B');
  assert.equal(ofB.order_no, 'XSD-20261007-0005');
  // 反面：A 的那笔里绝不该出现 B 的 task_id（服务是单例，关联键只能走参数）
  assert.equal(ofA.task_id === ofB.task_id, false);
});

// ── ⑦ 相关库存日志也两种键都给（状态变更 / 补样品） ───────────────────────────
test('inventory.state.transitioned：stock_key 与 stock_key_label 并列，且带关联键', async () => {
  const world = makeWorld();
  world.records.get('behavior').push({ record_id: 'behavior_freeze', fields: {
    行为编码: 'STOCK_FREEZE', 行为名称: '转冻结', 库存方向: '不影响', 是否启用: true,
  } });
  const inventory = new InventoryService({ gateway: world.gateway, store: world.store() });

  const logs = captureLogs();
  try {
    await inventory.transitionState({
      kind: 'STOCK_FREEZE', productRecordId: 'product_rec', size: 40, fromState: '门盒',
      quantity: 1, sourceRecordId: 'freeze_req_1',
    }, { correlation: CORRELATION });
  } finally {
    logs.restore();
  }

  const rows = logs.logs('inventory.state.transitioned');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stock_key, 'product_rec|40|门盒');
  assert.equal(rows[0].stock_key_label, LABEL);
  assert.equal(rows[0].stock_key_label_source, 'live_inventory');
  // 既有字段一个不少
  assert.equal(rows[0].kind, 'STOCK_FREEZE');
  assert.equal(rows[0].from_state, '门盒');
  assert.equal(rows[0].to_state, '仓库');
  assert.equal(rows[0].quantity, 1);
  assert.deepEqual(rows[0].live_record_ids, ['live_1']);
  assert.equal(typeof rows[0].ledger_record_id, 'string');
  // 新增关联键
  assert.equal(rows[0].task_id, 'sale_om_test');
  assert.equal(rows[0].sales_entry_record_id, 'rec_sale');
  assert.equal(world.productReads(), 0);
});

test('inventory.sample.promoted：stock_key 与 stock_key_label 并列，且带关联键', async () => {
  const world = makeWorld();
  world.records.get('behavior').push({ record_id: 'behavior_sample', fields: {
    行为编码: 'STOCK_DOORBOX_TO_SAMPLE', 行为名称: '门盒转样品', 库存方向: '不影响', 是否启用: true,
  } });
  const inventory = new InventoryService({ gateway: world.gateway, store: world.store() });

  const logs = captureLogs();
  try {
    await inventory.promoteToSample({
      salesDetailRecordId: 'detail_1', productRecordId: 'product_rec', size: 40,
    }, { correlation: CORRELATION });
  } finally {
    logs.restore();
  }

  const rows = logs.logs('inventory.sample.promoted');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stock_key, 'product_rec|40|门盒');
  assert.equal(rows[0].stock_key_label, LABEL);
  assert.equal(rows[0].stock_key_label_source, 'live_inventory');
  // 既有字段一个不少
  assert.equal(rows[0].live_record_id, 'live_1');
  assert.equal(typeof rows[0].ledger_record_id, 'string');
  assert.equal(rows[0].size, 40);
  // 新增关联键
  assert.equal(rows[0].task_id, 'sale_om_test');
  assert.equal(rows[0].sales_entry_record_id, 'rec_sale');
  assert.equal(world.productReads(), 0);
});

// ── ⑥ 「成交」（第二次交付）那条链：收款明细的写入日志也要能串 ────────────────
test('成交链路：收款明细的写入日志带 sales_entry_record_id ＋ order_no（单号零额外请求）', async () => {
  const world = makeWorld();
  world.records.set('salesDetail', [{ record_id: 'detail_1', fields: {
    销售单号: ['rec_sale'], 编号: ['product_rec'], 尺码: ['size_40'],
    成交金额: 220, 履约状态: '已交付', 赠品: '',
  } }]);
  world.records.set('paymentRecord', [{ record_id: 'receipt_1', fields: {
    关联销售单: ['rec_sale'], 收款金额: 220, 收款状态: '未收款',
  } }]);
  // 「成交」要求订单已入账（读「资金状态」）。
  world.records.get('salesEntry')[0].fields.资金状态 = '已写入';

  const service = new SecondDeliveryService({
    gateway: world.gateway, payments: undefined,
    store: new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'log-correlation-2d-')),
      idField: 'task_id' }),
  });
  service.payments.references = world.references;

  const logs = captureLogs();
  let result;
  try {
    result = await service.confirm({ salesEntryRecordId: 'rec_sale', method: '微信' },
      { correlation: { task_id: 'sale_om_test' } });
  } finally {
    logs.restore();
  }
  assert.equal(result.collectedAmount, 220);

  const updated = logs.logs('bitable.record.updated')
    .find((row) => row.table_key === 'paymentRecord');
  assert.ok(updated, '「未收款 → 已收款」必须真的写下去');
  assert.equal(updated.sales_entry_record_id, 'rec_sale');
  assert.equal(updated.order_no, 'XSD-20261007-0004');
  assert.equal(updated.task_id, 'sale_om_test');
  assert.equal(typeof updated.record_id, 'string');

  const completed = logs.logs('sales.second_delivery.completed');
  assert.equal(completed.length, 1);
  // 既有字段一个不少
  assert.equal(completed[0].sales_entry_record_id, 'rec_sale');
  assert.equal(completed[0].collected_amount, 220);
  assert.deepEqual(completed[0].collected_payment_ids, ['receipt_1']);
  // 新字段
  assert.equal(completed[0].task_id, 'sale_om_test');
  assert.equal(completed[0].order_no, 'XSD-20261007-0004');
});
