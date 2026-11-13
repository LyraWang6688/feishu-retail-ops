'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-audit-gw-'));
process.env.WRITE_AUDIT_DIR = dir;
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';
process.env.WRITE_AUDIT_SALES = 'true';
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { queryWriteAudit } = require('../src/services/writeAuditService');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const gateway = () => new V1BitableGateway({
  client: {
    bitable: {
      appTableRecord: {
        create: async ({ data }) => ({ code: 0, data: { record: { record_id: 'rec_new', fields: data.fields } } }),
        update: async ({ data }) => ({ code: 0, data: { record: { record_id: 'rec_new', fields: data.fields } } }),
        batchCreate: async ({ data }) => ({
          code: 0,
          data: { records: data.records.map((record, index) => ({ record_id: `rec_batch_${index + 1}`, fields: record.fields })) },
        }),
        batchUpdate: async ({ data }) => ({
          code: 0,
          data: { records: data.records.map((record) => ({ record_id: record.record_id, fields: record.fields })) },
        }),
      },
    },
  },
  writeScheduler: null,
  drive: {},
});

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

test('AC-WG1 销售主表 create 自动按 order_no 写审计', async () => {
  const table = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  await gateway().create('salesEntry', {
    [Object.keys(table).find((key) => key === 'orderNo')]: 'XSD-AUDIT-1',
    [Object.keys(table).find((key) => key === 'writeStatus')]: '成功',
  }, { correlation: { order_no: 'XSD-AUDIT-1', task_id: 'job-audit-1' } });
  await wait();
  const rows = await queryWriteAudit({ orderNo: 'XSD-AUDIT-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, 'sales');
  assert.equal(rows[0].operation, 'create');
  assert.equal(rows[0].table_key, 'salesEntry');
  assert.ok(rows[0].table_name, '审计带中文表名');
  assert.ok(Object.keys(rows[0].fields).length > 0);
});


test('AC-WG2 批量创建拆成逐条审计', async () => {
  const table = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  await gateway().createBatch('salesEntry', [
    { orderNo: 'XSD-AUDIT-B1', writeStatus: '未完成' },
    { orderNo: 'XSD-AUDIT-B1', writeStatus: '未完成' },
  ], { correlation: { order_no: 'XSD-AUDIT-B1', task_id: 'job-audit-batch' } });
  await wait();
  const rows = await queryWriteAudit({ orderNo: 'XSD-AUDIT-B1' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.operation), ['createBatch', 'createBatch']);
  assert.deepEqual(rows.map((row) => row.record_id), ['rec_batch_1', 'rec_batch_2']);
  assert.ok(rows.every((row) => row.batch_id));
  assert.ok(table);
});


test('AC-WG3 单条 update 记录审计', async () => {
  await gateway().update('salesEntry', 'rec_update_1', { writeStatus: '成功' }, {
    correlation: { order_no: 'XSD-AUDIT-U1', task_id: 'job-audit-update' },
  });
  await wait();
  const rows = await queryWriteAudit({ orderNo: 'XSD-AUDIT-U1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, 'update');
  assert.equal(rows[0].record_id, 'rec_update_1');
  assert.ok(Object.keys(rows[0].fields).length > 0);
});

test('AC-WG4 updateBatch 拆成逐条审计', async () => {
  await gateway().updateBatch('salesEntry', [
    { recordId: 'rec_u1', values: { writeStatus: '成功' } },
    { recordId: 'rec_u2', values: { writeStatus: '失败' } },
  ], { correlation: { order_no: 'XSD-AUDIT-U2', task_id: 'job-audit-update-batch' } });
  await wait();
  const rows = await queryWriteAudit({ orderNo: 'XSD-AUDIT-U2' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.operation), ['updateBatch', 'updateBatch']);
  assert.deepEqual(rows.map((row) => row.record_id), ['rec_u1', 'rec_u2']);
  assert.ok(rows.every((row) => row.batch_id));
});
