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
  assert.ok(Object.keys(rows[0].fields).length > 0);
});
