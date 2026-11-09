'use strict';

// 全局飞书写入调度器 × 网关 × 跨模块（issue #879）—— 集成 / 跨模块并发测试。
//
// 验收标准：
//   AC-WG1 **所有写**（create / createBatch / update / updateBatch / delete / deleteBatch /
//         按 table_id 回写）都经调度器；**读**（listAll / get / getBatch / listByFilter）不进调度器。
//   AC-WG2 跨模块并发（销售 + 采购 + 库存同时写）：全局同时在飞 ≤ 配置值；同表同操作严格串行。
//   AC-WG3 重试**复用同一份 payload / 关联键**：第一次 1254607 被拒 ⇒ 第二次逐字相同，
//         只落一条记录（不重复建单 / 不重复扣库存）。
//   AC-WG4 库存 stock_key 串行**原样保留**：同一 stock_key 的两次并发布写入（幂等）只扣一次；
//         不同 stock_key / 不同表之间**不会全局锁死**（并发=2 时能看到两个写入同时在飞）。
//   AC-WG5 关掉调度（注入 null 或用例环境）⇒ 网关直写，行为回到改动前（回滚开关）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createFeishuWriteScheduler } = require('../src/services/feishuWriteScheduler');
const { buildFeishuWriteSchedulerConfig } = require('../src/config/feishuWriteScheduler');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── 测试用 schema（表 ID / 字段名都自己给，不碰真实 Base）────────────────────────
const SCHEMA = {
  appToken: 'app_write_scheduler_test',
  tables: {
    behavior: {
      tableName: '行为管理', tableId: 'tbl_behavior',
      fields: { code: '行为编码', name: '行为名称', stockDirection: '库存方向', enabled: '是否启用' },
    },
    sizeManagement: {
      tableName: '尺码管理', tableId: 'tbl_size', fields: { size: '尺码' },
    },
    liveInventory: {
      tableName: '实时库存', tableId: 'tbl_live',
      fields: {
        product: '编号', size: '尺码', state: '所属状态',
        operationItemKey: '库存操作键', stockKey: '库存键',
      },
    },
    inventoryLedger: {
      tableName: '库存流水', tableId: 'tbl_ledger',
      fields: {
        product: '编号', size: '尺码', quantityChange: '变动数量', behavior: '库存行为',
        salesDetail: '关联销售', purchaseBatch: '关联采购',
      },
    },
    salesEntry: {
      tableName: '销售主表', tableId: 'tbl_sales', fields: { orderNo: '销售单号' },
    },
    salesDetail: {
      tableName: '销售明细', tableId: 'tbl_detail', fields: { product: '编号' },
    },
    paymentRecord: {
      tableName: '收款明细', tableId: 'tbl_pay', fields: { amount: '金额' },
    },
    purchaseRequest: {
      tableName: '单据信息', tableId: 'tbl_purchase', fields: { name: '名称' },
    },
    purchaseOrderBatch: {
      tableName: '报货批次', tableId: 'tbl_batch', fields: { arrivalStatus: '到货状态' },
    },
  },
};

const tableOfId = (tableId) => Object.values(SCHEMA.tables).find((table) => table.tableId === tableId);

/**
 * 假飞书 client：内存表 + 写入并发埋点。
 * ⚠️ 行为与真实网关的契约一致（返回 `{code, data}`；`code !== 0` ⇒ 网关抛带 `bitableRejected` 的错）。
 */
const createFakeClient = ({ initial = {}, writeDelayMs = 0, failOnce = null } = {}) => {
  const store = new Map();
  let seq = 0;
  const metrics = { writes: 0, reads: 0, inFlight: 0, maxInFlight: 0, perGroup: new Map(), groupMax: 0 };
  const failures = new Map(); // operation -> 剩余次数

  for (const [tableKey, rows] of Object.entries(initial)) {
    const table = SCHEMA.tables[tableKey];
    store.set(table.tableId, rows.map((row) => ({
      record_id: row.record_id || `seed_${++seq}`,
      fields: { ...(row.fields || {}) },
    })));
  }
  const rowsOf = (tableId) => {
    if (!store.has(tableId)) store.set(tableId, []);
    return store.get(tableId);
  };
  const maybeFail = (operation) => {
    if (!failOnce || failOnce.operation !== operation) return null;
    const left = failures.get(operation) ?? failOnce.times ?? 1;
    if (left <= 0) return null;
    failures.set(operation, left - 1);
    return { code: failOnce.code ?? 1254607, msg: failOnce.msg ?? 'Data not ready, please try again later' };
  };
  const trackWrite = async (tableId, operation, work) => {
    metrics.writes += 1;
    metrics.inFlight += 1;
    metrics.maxInFlight = Math.max(metrics.maxInFlight, metrics.inFlight);
    const group = `${tableId}:${operation}`;
    const inGroup = (metrics.perGroup.get(group) || 0) + 1;
    metrics.perGroup.set(group, inGroup);
    metrics.groupMax = Math.max(metrics.groupMax, inGroup);
    try {
      if (writeDelayMs) await sleep(writeDelayMs);
      return await work();
    } finally {
      metrics.perGroup.set(group, metrics.perGroup.get(group) - 1);
      metrics.inFlight -= 1;
    }
  };
  const recordOf = (tableId, values) => ({
    record_id: `rec_${++seq}`,
    fields: Object.fromEntries(Object.entries(values || {}).map(([name, value]) => [name, value])),
  });

  const client = {
    bitable: {
      appTableField: {
        list: async ({ path: p }) => {
          const table = tableOfId(p.table_id);
          // 尺码管理.尺码 = 数字（type=2）；流水 / 实时库存的尺码 = 单选关联「尺码管理」（type=18）；
          // 其余按文本字段（type=1）—— 与真实 Base 的契约一致（SizeReferenceService 会校验）。
          const items = Object.entries(table.fields).map(([semantic, field_name]) => {
            if (semantic === 'size' && table.tableId === 'tbl_size') return { field_name, type: 2 };
            if (semantic === 'size') {
              return { field_name, type: 18, property: { table_id: 'tbl_size', multiple: false } };
            }
            return { field_name, type: 1 };
          });
          return { code: 0, data: { items, has_more: false } };
        },
      },
      appTableRecord: {
        list: async ({ path: p, params }) => {
          metrics.reads += 1;
          const all = rowsOf(p.table_id);
          const size = Number(params?.page_size) || 500;
          const start = Number(params?.page_token) || 0;
          const items = all.slice(start, start + size);
          const hasMore = start + size < all.length;
          return { code: 0, data: { items, has_more: hasMore, page_token: hasMore ? start + size : undefined } };
        },
        get: async ({ path: p }) => {
          metrics.reads += 1;
          const row = rowsOf(p.table_id).find((item) => item.record_id === p.record_id);
          if (!row) return { code: 1254043, msg: 'RecordIdNotFound' };
          return { code: 0, data: { record: row } };
        },
        batchGet: async ({ path: p, data }) => {
          metrics.reads += 1;
          const wanted = new Set(data?.record_ids || []);
          return { code: 0, data: { records: rowsOf(p.table_id).filter((row) => wanted.has(row.record_id)) } };
        },
        create: async ({ path: p, data }) => trackWrite(p.table_id, 'create', async () => {
          const failure = maybeFail('create');
          if (failure) return failure;
          const row = recordOf(p.table_id, data?.fields);
          rowsOf(p.table_id).push(row);
          return { code: 0, data: { record: row } };
        }),
        batchCreate: async ({ path: p, data }) => trackWrite(p.table_id, 'create', async () => {
          const failure = maybeFail('batchCreate');
          if (failure) return failure;
          const rows = (data?.records || []).map((record) => recordOf(p.table_id, record.fields));
          rowsOf(p.table_id).push(...rows);
          return { code: 0, data: { records: rows } };
        }),
        update: async ({ path: p, data }) => trackWrite(p.table_id, 'update', async () => {
          const failure = maybeFail('update');
          if (failure) return failure;
          const row = rowsOf(p.table_id).find((item) => item.record_id === p.record_id);
          if (!row) return { code: 1254043, msg: 'RecordIdNotFound' };
          Object.assign(row.fields, data?.fields || {});
          return { code: 0, data: { record: row } };
        }),
        batchUpdate: async ({ path: p, data }) => trackWrite(p.table_id, 'update', async () => {
          const failure = maybeFail('batchUpdate');
          if (failure) return failure;
          const rows = (data?.records || []).map((record) => {
            const row = rowsOf(p.table_id).find((item) => item.record_id === record.record_id);
            if (row) Object.assign(row.fields, record.fields || {});
            return row || { record_id: record.record_id, fields: record.fields };
          });
          return { code: 0, data: { records: rows } };
        }),
        delete: async ({ path: p }) => trackWrite(p.table_id, 'delete', async () => {
          const failure = maybeFail('delete');
          if (failure) return failure;
          const rows = rowsOf(p.table_id);
          const index = rows.findIndex((item) => item.record_id === p.record_id);
          if (index < 0) return { code: 1254043, msg: 'RecordIdNotFound' };
          rows.splice(index, 1);
          return { code: 0, data: { deleted: true } };
        }),
        batchDelete: async ({ path: p, data }) => trackWrite(p.table_id, 'delete', async () => {
          const failure = maybeFail('batchDelete');
          if (failure) return failure;
          const ids = data?.records || [];
          const rows = rowsOf(p.table_id);
          const records = ids.map((recordId) => {
            const index = rows.findIndex((item) => item.record_id === recordId);
            if (index >= 0) rows.splice(index, 1);
            return { record_id: recordId, deleted: index >= 0 };
          });
          return { code: 0, data: { records } };
        }),
      },
    },
  };
  return { client, store, metrics, rowsOf };
};

const captureLogger = () => {
  const logs = [];
  const push = (level) => (event, fields) => logs.push({ level, event, fields: fields || {} });
  return { logs, logger: { logInfo: push('info'), logWarn: push('warn'), logError: push('error') } };
};

const schedulerWith = ({ maxConcurrency = 2, retry = {}, logger } = {}) => createFeishuWriteScheduler({
  config: {
    ...buildFeishuWriteSchedulerConfig({}),
    maxConcurrency,
    retry: {
      ...buildFeishuWriteSchedulerConfig({}).retry,
      maxAttempts: 3, baseMs: 0, maxDelayMs: 0, ...retry,
    },
  },
  logger,
  sleep: async () => {},
});

// ── AC-WG1：写经调度器，读不经过 ─────────────────────────────────────────────
test('AC-WG1 写请求全部经调度器；读请求不进调度器（不被写队列挡住）', async () => {
  const { client } = createFakeClient({
    initial: {
      salesEntry: [
        { record_id: 'sale_1', fields: { 销售单号: 'XSD-1' } },
        { record_id: 'rec_3', fields: { 销售单号: 'XSD-3' } },
      ],
    },
  });
  const captured = captureLogger();
  let scheduler = schedulerWith({ logger: captured.logger, maxConcurrency: 2 });
  const gateway = new V1BitableGateway({ schema: SCHEMA, client, writeScheduler: scheduler });

  const createdDetail = await gateway.createBatch('salesDetail', [{ product: 'p1' }, { product: 'p2' }]);
  await gateway.create('salesEntry', { orderNo: 'XSD-2' });
  await gateway.update('salesEntry', 'sale_1', { orderNo: 'XSD-1-改' });
  await gateway.updateBatch('salesDetail', [{ recordId: createdDetail[0].recordId, values: { product: 'p9' } }]);
  await gateway.delete('salesEntry', 'sale_1');
  await gateway.deleteBatch('salesDetail', [createdDetail[1].recordId]);
  await gateway.updateByTableId({ tableId: 'tbl_sales', recordId: 'rec_3', fields: { 销售单号: 'X' } });
  await gateway.listAll('salesDetail');
  await gateway.get('salesDetail', createdDetail[0].recordId);
  await gateway.getBatch('salesDetail', [createdDetail[0].recordId]);

  const writes = captured.logs.filter((item) => item.event === 'feishu.write.applied');
  assert.ok(writes.length >= 7, `每个写请求都要有调度日志（实际 ${writes.length}）`);
  for (const log of writes) {
    assert.equal(typeof log.fields.queue_wait_ms, 'number');
    assert.equal(log.fields.concurrency_limit, 2);
    assert.ok(log.fields.attempts >= 1);
  }
  // 读不进调度器：把两个写额度占住后，读请求仍然立刻返回
  const { client: client2 } = createFakeClient({
    initial: { salesEntry: [{ record_id: 'sale_1', fields: { 销售单号: 'XSD-1' } }] },
    writeDelayMs: 30,
  });
  const busyScheduler = schedulerWith({ logger: captured.logger, maxConcurrency: 2 });
  const busyGateway = new V1BitableGateway({ schema: SCHEMA, client: client2, writeScheduler: busyScheduler });
  const blockedWrites = [
    busyGateway.create('salesEntry', { orderNo: 'XSD-A' }),
    busyGateway.create('salesEntry', { orderNo: 'XSD-B' }),
  ];
  // 两个额度都被占着：读仍必须立即返回（不是排在写队列后面）
  const readStartedAt = Date.now();
  const rows = await busyGateway.listAll('salesEntry');
  assert.ok(rows.length >= 1);
  assert.ok(Date.now() - readStartedAt < 30, '读不该等写队列');
  await Promise.all(blockedWrites);
  assert.equal(captured.logs.filter((item) => item.event === 'feishu.write.failed').length, 0);
});

test('AC-WG5 注入 null（关掉调度）⇒ 网关直写，无调度日志（回滚开关）', async () => {
  const { client, rowsOf } = createFakeClient({});
  const captured = captureLogger();
  const gateway = new V1BitableGateway({ schema: SCHEMA, client, writeScheduler: null });
  await gateway.create('salesEntry', { orderNo: 'XSD-DIRECT' });
  assert.equal(rowsOf('tbl_sales').length, 1);
  assert.equal(captured.logs.filter((item) => item.event.startsWith('feishu.write.')).length, 0);
});

// ── AC-WG2 / AC-WG3：跨模块并发 + 重试复用同一份 payload ──────────────────────
test('AC-WG2 跨模块并发（销售 + 采购 + 库存同时写）：全局并发 ≤ 配置；同表同操作串行', async () => {
  const { client, metrics, rowsOf } = createFakeClient({
    initial: {
      behavior: [
        { record_id: 'bhv_sale', fields: { 行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true } },
        { record_id: 'bhv_buy', fields: { 行为编码: 'STOCK_PURCHASE_INCREASE', 行为名称: '采购增加', 库存方向: '增加', 是否启用: true } },
      ],
      sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
      liveInventory: [
        { record_id: 'door_1', fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: '门盒' } },
        { record_id: 'door_2', fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: '门盒' } },
      ],
      purchaseOrderBatch: [{ record_id: 'batch_1', fields: { 到货状态: '未到货' } }],
    },
    writeDelayMs: 8,
  });
  const captured = captureLogger();
  const scheduler = schedulerWith({ logger: captured.logger, maxConcurrency: 2 });
  const gateway = new V1BitableGateway({ schema: SCHEMA, client, writeScheduler: scheduler });
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-write-scheduler-')), idField: 'operation_id',
  });
  const inventory = new InventoryService({ gateway, store });

  // 三个"模块"的写序列**同时**发起（销售 worker / 采购入库 / 库存调整的真实表组合）
  const salesWrite = (async () => {
    await gateway.create('salesEntry', { orderNo: 'XSD-9001' });
    await gateway.createBatch('salesDetail', [{ product: 'product_1' }, { product: 'product_1' }]);
    await gateway.createBatch('paymentRecord', [{ amount: 199 }, { amount: 0 }]);
  })();
  const purchaseWrite = (async () => {
    await gateway.create('purchaseRequest', { name: '补货单' });
    await gateway.update('purchaseOrderBatch', 'batch_1', { arrivalStatus: '已到货' });
  })();
  const inventoryWrite = inventory.applyPurchase({
    purchaseBatchRecordId: 'batch_1', productRecordId: 'product_2', size: 38, quantity: 1, state: '门盒',
  });

  await Promise.all([salesWrite, purchaseWrite, inventoryWrite]);

  assert.ok(metrics.writes > 0);
  assert.ok(metrics.maxInFlight <= 2, `全局同时在飞不得超过配置值（实际 ${metrics.maxInFlight}）`);
  assert.equal(metrics.groupMax, 1, '同表同操作必须串行（组内只有 1 个在飞）');
  // 确实用到了并发（不是全局锁死成一个）
  assert.equal(metrics.maxInFlight, 2, `并发=2 时应当能看到 2 个写入同时在飞（实际 ${metrics.maxInFlight}）`);
  // 库存写入仍然正确（采购增加：流水 1 条 + 实时库存 1 条）
  assert.equal(rowsOf('tbl_ledger').length, 1, '采购入库流水 1 条');
  assert.equal(rowsOf('tbl_live').length, 3, '原 2 双门盒 + 新增 1 双');
  assert.equal(rowsOf('tbl_sales').length, 1);
  assert.equal(rowsOf('tbl_detail').length, 2);
  assert.equal(rowsOf('tbl_pay').length, 2);
  assert.equal(rowsOf('tbl_purchase').length, 1);
  assert.equal(rowsOf('tbl_batch')[0].fields['到货状态'], '已到货');
  // 调度器清空（不残留组 / 等额度）
  assert.deepEqual(scheduler.stats(), { limit: 2, active: 0, queued: 0, groups: 0 });
});

test('AC-WG3 重试复用同一份 payload / 关联键：第一次被 1254607 拒 ⇒ 第二次逐字相同，只落一条', async () => {
  const { client, metrics, rowsOf } = createFakeClient({
    writeDelayMs: 0,
    failOnce: { operation: 'batchCreate', times: 1, code: 1254607, msg: 'Data not ready, please try again later' },
  });
  const captured = captureLogger();
  const scheduler = schedulerWith({ logger: captured.logger, maxConcurrency: 1, retry: { maxAttempts: 3 } });
  const gateway = new V1BitableGateway({ schema: SCHEMA, client, writeScheduler: scheduler });

  const created = await gateway.createBatch('liveInventory', [
    { product: 'product_9', size: 'size_38', state: '门盒', operationItemKey: 'op-key:1' },
  ], { correlation: { task_id: 'job-retry-1', tap_id: 'tap-retry-1' } });

  assert.equal(created.length, 1);
  assert.equal(metrics.writes, 2, '第一次被拒 + 第二次成功 = 两次请求');
  assert.equal(rowsOf('tbl_live').length, 1, '**只落一条**（重试没有写重）');
  const retryLogs = captured.logs.filter((item) => item.event === 'feishu.write.retry');
  assert.equal(retryLogs.length, 1);
  assert.equal(retryLogs[0].fields.code, 1254607);
  assert.equal(retryLogs[0].fields.task_id, 'job-retry-1');
  const applied = captured.logs.filter((item) => item.event === 'feishu.write.applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].fields.attempts, 2);
  assert.equal(applied[0].fields.tap_id, 'tap-retry-1', '重试后关联键仍逐字相同');
});

test('AC-WG3 永久错误（字段名/权限）不重试：一次请求就抛，不落任何记录', async () => {
  const { client, metrics, rowsOf } = createFakeClient({
    failOnce: { operation: 'batchCreate', times: 5, code: 1254066, msg: 'UserFieldConvFail' },
  });
  const captured = captureLogger();
  const scheduler = schedulerWith({ logger: captured.logger, maxConcurrency: 1 });
  const gateway = new V1BitableGateway({ schema: SCHEMA, client, writeScheduler: scheduler });
  await assert.rejects(
    () => gateway.createBatch('liveInventory', [{ product: 'p1', size: 'size_38' }]),
    /新增“实时库存”记录失败/,
  );
  assert.equal(metrics.writes, 1, '永久错误一次都不重试');
  assert.equal(rowsOf('tbl_live').length, 0);
  assert.equal(captured.logs.filter((item) => item.event === 'feishu.write.failed').length, 1);
});

// ── AC-WG4：库存 stock_key 串行原样保留（不被全局锁死）───────────────────────
test('AC-WG4 同一 stock_key 的两次并发扣减（幂等）：只扣一次、只写一条流水', async () => {
  const { client, rowsOf } = createFakeClient({
    initial: {
      behavior: [
        { record_id: 'bhv_sale', fields: { 行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true } },
      ],
      sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
      liveInventory: [
        { record_id: 'door_1', fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: '门盒' } },
        { record_id: 'door_2', fields: { 编号: ['product_1'], 尺码: ['size_38'], 所属状态: '门盒' } },
      ],
    },
    writeDelayMs: 5,
  });
  const scheduler = schedulerWith({ maxConcurrency: 2 });
  const gateway = new V1BitableGateway({ schema: SCHEMA, client, writeScheduler: scheduler });
  const inventory = new InventoryService({
    gateway,
    store: new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-write-scheduler-stock-')), idField: 'operation_id' }),
  });
  const request = { salesDetailRecordId: 'detail_dup', productRecordId: 'product_1', size: 38, quantity: 1 };
  // 同一个 stock_key 并发两次（模拟"重复点提交"）：库存侧 runForStock 串行 + 幂等
  await Promise.all([inventory.applySale(request), inventory.applySale(request)]);
  assert.equal(rowsOf('tbl_live').length, 1, '只扣掉一双（第二次命中幂等任务，不再扣）');
  assert.equal(rowsOf('tbl_ledger').length, 1, '流水只写一条');
  assert.deepEqual(scheduler.stats(), { limit: 2, active: 0, queued: 0, groups: 0 });
});

test('AC-WG4 不同 stock_key 同时写：不同表写入可以并行（不全局锁死），且全局上限不被越过', async () => {
  const { client, metrics } = createFakeClient({
    initial: {
      behavior: [
        { record_id: 'bhv_sale', fields: { 行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true } },
      ],
      sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
      liveInventory: [
        { record_id: 'door_a1', fields: { 编号: ['product_a'], 尺码: ['size_38'], 所属状态: '门盒' } },
        { record_id: 'door_a2', fields: { 编号: ['product_a'], 尺码: ['size_38'], 所属状态: '门盒' } },
        { record_id: 'door_b1', fields: { 编号: ['product_b'], 尺码: ['size_38'], 所属状态: '门盒' } },
        { record_id: 'door_b2', fields: { 编号: ['product_b'], 尺码: ['size_38'], 所属状态: '门盒' } },
      ],
    },
    writeDelayMs: 40,
  });
  const scheduler = schedulerWith({ maxConcurrency: 2 });
  const gateway = new V1BitableGateway({ schema: SCHEMA, client, writeScheduler: scheduler });
  const inventory = new InventoryService({
    gateway,
    store: new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-write-scheduler-multi-')), idField: 'operation_id' }),
  });
  await Promise.all([
    inventory.applySale({ salesDetailRecordId: 'detail_a', productRecordId: 'product_a', size: 38, quantity: 1 }),
    inventory.applySale({ salesDetailRecordId: 'detail_b', productRecordId: 'product_b', size: 38, quantity: 1 }),
  ]);
  assert.equal(metrics.maxInFlight, 2, '不同 stock_key 之间的写不应被锁成一条（并发=2 时两个在飞）');
  assert.ok(metrics.maxInFlight <= 2, '全局上限不被越过');
  assert.equal(metrics.groupMax, 1, '同表同操作仍严格串行');
});
