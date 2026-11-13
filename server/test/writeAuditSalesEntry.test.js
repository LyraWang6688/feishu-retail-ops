'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-audit-sales-'));
process.env.WRITE_AUDIT_DIR = dir;
process.env.WRITE_AUDIT_SALES = 'true';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createSalesEntryWithOrderNo } = require('../src/services/salesEntryService');
const { queryWriteAudit } = require('../src/services/writeAuditService');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('AC-WS1 销售主表首次创建在单号生成后补审计', async () => {
  const records = [];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async () => records.slice(),
    create: async (tableKey, values) => {
      const recordId = `rec_${records.length + 1}`;
      records.push({ record_id: recordId, fields: { ...values } });
      return { recordId };
    },
    update: async (tableKey, recordId, values) => {
      const row = records.find((item) => item.record_id === recordId);
      if (row) Object.assign(row.fields, values);
      return { recordId, record: row };
    },
  };
  const created = await createSalesEntryWithOrderNo({ gateway }, { task_id: 'job-audit-sales', sender_open_id: 'ou_test' });
  assert.ok(created?.recordId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const rows = await queryWriteAudit({ traceId: 'job-audit-sales' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table_key, 'salesEntry');
  assert.equal(rows[0].operation, 'create');
  assert.equal(rows[0].record_id, created.recordId);
  assert.ok(Object.keys(rows[0].fields).length >= 1);
});
