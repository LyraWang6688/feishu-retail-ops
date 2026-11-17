'use strict';

/**
 * ⭐ 2026-11-17：打印请求 → 飞书「标签打印」表（**只记录请求 / 申请次数**）。
 *
 * 口径：
 *   · 匹配键 = 打印货号 + 来源；搜到 ⇒ 申请次数 +1；搜不到 ⇒ 新建、次数 = 1；
 *   · 扫码 / 库存调整 / 销售录单 / 验收录单都记；批量打印表单不参与；
 *   · 申请次数 = **打印任务创建次数**，不是物理出纸成功次数；
 *   · 写失败只记日志，**绝不抛错/阻塞打印**；
 *   · 来源不明 / 没有货品记录 ID ⇒ 跳过（不猜、不写半条）。
 */
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SOURCES } = require('../src/config/labelPrintQueue');
const { createLabelPrintRequestLogService } = require('../src/services/labelPrintRequestLogService');

const silent = { logInfo() {}, logWarn() {} };
const TABLE = V1_BITABLE_SCHEMA.tables.labelPrintRequest;
const physical = (key) => TABLE.fields[key];

const job = (overrides = {}) => ({
  job_id: 'job_1',
  source: SOURCES.scan,
  total_labels: 1,
  request: { mode: 'single', recordId: 'rec_product' },
  ...overrides,
});

/** 假网关：语义键入参 → 物理列存；listAll / create / update 都留痕。 */
const fakeGateway = (initialRecords = []) => {
  const records = initialRecords.map((record) => ({
    record_id: record.record_id,
    fields: { ...record.fields },
  }));
  const calls = [];
  let nextId = records.length + 1;
  return {
    records,
    calls,
    async listAll(tableKey) {
      calls.push({ op: 'list', tableKey });
      return records.map((record) => ({ ...record, fields: { ...record.fields } }));
    },
    async create(tableKey, values) {
      calls.push({ op: 'create', tableKey, values });
      const fields = {};
      for (const [key, value] of Object.entries(values)) fields[physical(key)] = value;
      const record = { record_id: 'rec_log_' + nextId, fields };
      nextId += 1;
      records.push(record);
      return { recordId: record.record_id };
    },
    async update(tableKey, recordId, values) {
      calls.push({ op: 'update', tableKey, recordId, values });
      const record = records.find((item) => item.record_id === recordId);
      if (!record) throw new Error('record not found');
      for (const [key, value] of Object.entries(values)) record.fields[physical(key)] = value;
      return record;
    },
  };
};

const existingRow = ({ recordId = 'rec_existing', product = 'rec_product', source = '扫码打印', count = 1 } = {}) => ({
  record_id: recordId,
  fields: {
    [physical('product')]: [{ record_ids: [product] }],
    [physical('source')]: source,
    [physical('count')]: count,
  },
});

test('AC-RL1 第一次扫码打印 ⇒ 新建一行：打印货号 + 来源 + 申请次数=1', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  const result = await service.record(job());
  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(gateway.records.length, 1);
  assert.deepEqual(gateway.records[0].fields[physical('product')], ['rec_product']);
  assert.equal(gateway.records[0].fields[physical('source')], '扫码打印');
  assert.equal(gateway.records[0].fields[physical('count')], 1);
});

test('AC-RL2 同一货品 + 同一来源再请求 ⇒ 只给原行申请次数 +1，不新建', async () => {
  const gateway = fakeGateway([existingRow({ count: 1 })]);
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  const result = await service.record(job({ job_id: 'job_2' }));
  assert.equal(result.ok, true);
  assert.equal(result.action, 'incremented');
  assert.equal(result.count, 2);
  assert.equal(gateway.records.length, 1, '不新增第二行');
  assert.equal(gateway.records[0].fields[physical('count')], 2);
  assert.equal(gateway.calls.filter((call) => call.op === 'create').length, 0);
});

test('AC-RL3 不同来源 ⇒ 同一货品各记各的（扫码 1 次、库存调整 1 次）', async () => {
  const gateway = fakeGateway([existingRow({ source: '扫码打印', count: 1 })]);
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  const result = await service.record(job({
    source: SOURCES.inventory, request: { mode: 'single', recordId: 'rec_product' },
  }));
  assert.equal(result.action, 'created');
  assert.equal(gateway.records.length, 2);
  assert.equal(gateway.records[1].fields[physical('source')], '库存调整打印');
  assert.equal(gateway.records[1].fields[physical('count')], 1);
});

test('AC-RL4 销售录单 / 验收录单来源文案与表选项一致', async () => {
  const saleGateway = fakeGateway();
  const sale = createLabelPrintRequestLogService({ gateway: saleGateway, logger: silent });
  await sale.record(job({ source: SOURCES.sale }));
  assert.equal(saleGateway.records[0].fields[physical('source')], '销售录单打印');

  const acceptGateway = fakeGateway();
  const accept = createLabelPrintRequestLogService({ gateway: acceptGateway, logger: silent });
  await accept.record(job({ source: SOURCES.acceptance }));
  assert.equal(acceptGateway.records[0].fields[physical('source')], '验收录单打印');
});

test('AC-RL5 批量打印（source=form）⇒ 跳过，不参与申请次数', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  const result = await service.record(job({ source: SOURCES.form }));
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'form_has_own_record');
  assert.equal(gateway.calls.length, 0);
});

test('AC-RL6 没有货品记录 ID / 来源不认识 ⇒ 跳过（不写半条、不猜）', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  const noProduct = await service.record(job({ request: { mode: 'single', number: 'X|黑|男' } }));
  assert.equal(noProduct.skipped, true);
  assert.equal(noProduct.reason, 'missing_product_record_id');
  const unknown = await service.record(job({ source: 'nope' }));
  assert.equal(unknown.skipped, true);
  assert.equal(unknown.reason, 'unknown_source');
  assert.equal(gateway.calls.length, 0);
});

test('AC-RL7 建行失败 / 搜索失败 ⇒ 只返回 ok:false，绝不抛错（不阻塞打印）', async () => {
  const createFail = {
    async listAll() { return []; },
    async create() { throw new Error('bitable down'); },
  };
  const createService = createLabelPrintRequestLogService({ gateway: createFail, logger: silent });
  const created = await createService.record(job());
  assert.equal(created.ok, false);
  assert.equal(created.reason, 'create_failed');
  assert.match(created.error, /bitable down/);

  const listFail = { async listAll() { throw new Error('list down'); } };
  const listService = createLabelPrintRequestLogService({ gateway: listFail, logger: silent });
  const listed = await listService.record(job());
  assert.equal(listed.ok, false);
  assert.equal(listed.reason, 'search_failed');
  assert.match(listed.error, /list down/);
});

test('AC-RL8 开关关掉 ⇒ 一次飞书都不打', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({
    gateway, logger: silent, config: { ...require('../src/config/labelPrintRequestLog').LABEL_PRINT_REQUEST_LOG, enabled: false },
  });
  const result = await service.record(job());
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(gateway.calls.length, 0);
});
