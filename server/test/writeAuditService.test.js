'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-audit-'));
process.env.WRITE_AUDIT_DIR = dir;
process.env.WRITE_AUDIT_SALES = 'true';
process.env.WRITE_AUDIT_PURCHASE = 'false';

const { recordWrite, queryWriteAudit } = require('../src/services/writeAuditService');
const { auditDomainForCorrelation } = require('../src/config/writeAudit');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('AC-WA1 销售写入按 order_no 可查，字段值落盘', async () => {
  await recordWrite({
    domain: 'sales', tableKey: 'salesEntry', tableId: 'tbl_sales', operation: 'create',
    recordId: 'rec_entry', correlation: { order_no: 'XSD-001', task_id: 'job_1' },
    fields: { 销售单号: 'XSD-001', 实收金额: 99, 附件token: 'secret-token' },
  });
  const rows = await queryWriteAudit({ orderNo: 'XSD-001' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table_key, 'salesEntry');
  assert.equal(rows[0].fields.实收金额, '99');
  assert.equal(rows[0].fields['附件token'], '[redacted]');
  assert.equal(rows[0].correlation.order_no, 'XSD-001');
});

test('AC-WA2 未开启的域不写审计', async () => {
  const result = await recordWrite({
    domain: 'purchase', tableKey: 'purchaseOrderBatch', operation: 'update',
    correlation: { order_no: 'XSD-002' }, fields: { 到货状态: '已到货' },
  });
  assert.equal(result, null);
  assert.equal((await queryWriteAudit({ orderNo: 'XSD-002' })).length, 0);
});

test('AC-WA3 按 trace_id 查询与值截断', async () => {
  await recordWrite({
    domain: 'sales', tableKey: 'salesDetail', operation: 'createBatch', traceId: 'trace_abc',
    correlation: { order_no: 'XSD-003' }, fields: { 备注: 'x'.repeat(500) },
  });
  const rows = await queryWriteAudit({ traceId: 'trace_abc' });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].fields.备注.endsWith('…'));
});


test('AC-WA4 按关联键推断业务域：销售默认开启，采购默认关闭', () => {
  assert.equal(auditDomainForCorrelation({ order_no: 'XSD-001' }), 'sales');
  assert.equal(auditDomainForCorrelation({ batch_no: 'CGD-001' }), '');
  assert.equal(auditDomainForCorrelation({}), '');
});
