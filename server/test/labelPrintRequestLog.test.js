'use strict';

/**
 * ⭐ 2026-11-20：打印请求 → 飞书「标签打印」表（**一个打印任务一行**）。
 *
 * 口径：
 *   · 每次新建打印任务直接新增一行，只写「打印货号 + 来源」；
 *   · 不查历史、不合并、不累加申请次数；
 *   · 补打也是新任务 ⇒ 再新增一行；
 *   · 批量打印表单不参与；
 *   · 写失败只记日志，绝不抛错/阻塞打印；
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

/** 假网关：只允许 create；listAll/update 一旦被调用就报错，钉住“不查历史、不累加”。 */
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
    async listAll() {
      calls.push({ op: 'list' });
      throw new Error('不应查询历史记录');
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
    async update() {
      calls.push({ op: 'update' });
      throw new Error('不应更新申请次数');
    },
  };
};

test('AC-RL1 第一次扫码打印 ⇒ 新建一行：打印货号 + 来源，不写申请次数', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  const result = await service.record(job());
  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(gateway.records.length, 1);
  assert.deepEqual(gateway.records[0].fields[physical('product')], ['rec_product']);
  assert.equal(gateway.records[0].fields[physical('source')], '扫码打印');
  assert.deepEqual(Object.keys(gateway.records[0].fields).sort(), [physical('product'), physical('source')].sort());
  assert.deepEqual(gateway.calls.map((call) => call.op), ['create']);
});

test('AC-RL2 同一货品 + 同一来源再请求 ⇒ 再新增一行，不查历史、不累加', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  await service.record(job({ job_id: 'job_1' }));
  const result = await service.record(job({ job_id: 'job_2' }));
  assert.equal(result.action, 'created');
  assert.equal(gateway.records.length, 2, '一个任务一行');
  assert.deepEqual(gateway.calls.map((call) => call.op), ['create', 'create']);
  assert.equal(gateway.calls.some((call) => call.op === 'list' || call.op === 'update'), false);
});

test('AC-RL3 不同来源 ⇒ 同一货品各记各的', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  await service.record(job({ source: SOURCES.scan }));
  await service.record(job({ job_id: 'job_2', source: SOURCES.inventory }));
  assert.equal(gateway.records.length, 2);
  assert.deepEqual(gateway.records.map((row) => row.fields[physical('source')]), ['扫码打印', '库存调整打印']);
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

test('AC-RL5 批量打印（source=form）⇒ 跳过，不参与', async () => {
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

test('AC-RL7 建行失败 ⇒ 只返回 ok:false，绝不抛错（不阻塞打印）', async () => {
  const gateway = {
    async create() { throw new Error('bitable down'); },
  };
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  const result = await service.record(job());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'create_failed');
  assert.match(result.error, /bitable down/);
});

test('AC-RL9 服务端打印任务带真实操作人 ⇒ 写打印者；应用号不写', async () => {
  const gateway = fakeGateway();
  const service = createLabelPrintRequestLogService({ gateway, logger: silent });
  await service.record(job({ requested_by: 'ou_printer' }));
  assert.deepEqual(gateway.records[0].fields[physical('printedBy')], [{ id: 'ou_printer' }]);

  const botGateway = fakeGateway();
  const botService = createLabelPrintRequestLogService({ gateway: botGateway, logger: silent });
  await botService.record(job({ job_id: 'job_bot', requested_by: 'ou_dc362967efb60353902b7d7f43756c84' }));
  assert.equal(botGateway.records[0].fields[physical('printedBy')], undefined);
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
