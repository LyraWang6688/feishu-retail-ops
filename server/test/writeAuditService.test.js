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
process.env.WRITE_AUDIT_INVENTORY_MANUAL = 'true';

const { recordWrite, queryWriteAudit, queryRecentWriteAudit } = require('../src/services/writeAuditService');
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
  assert.equal(auditDomainForCorrelation({ audit_domain: 'inventoryManual' }), 'inventoryManual');
  assert.equal(auditDomainForCorrelation({}), '');
});


test('AC-WA5 最近写入按时间由近及远', async () => {
  // ⚠️ 用独立子目录：本文件其它用例写的是真实当前时间，同一目录里会排到这两条之前
  //   （2026-11-14 实测：测试跑过 05:00Z 后本条开始假红）。
  const { fs: _fs, os: _os, path: _path } = { fs: require('node:fs'), os: require('node:os'), path: require('node:path') };
  const localDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'write-audit-recent-'));
  await recordWrite({ dir: localDir, domain: 'sales', tableKey: 'salesEntry', operation: 'create', recordId: 'rec_old', correlation: { order_no: 'XSD-OLD' }, fields: { x: 1 }, now: new Date('2026-11-14T04:00:00Z') });
  await recordWrite({ dir: localDir, domain: 'sales', tableKey: 'salesEntry', operation: 'update', recordId: 'rec_new', correlation: { order_no: 'XSD-NEW' }, fields: { x: 2 }, now: new Date('2026-11-14T04:01:00Z') });
  const rows = await queryRecentWriteAudit({ dir: localDir, limit: 10, now: new Date('2026-11-14T05:00:00Z') });
  assert.equal(rows[0].correlation.order_no, 'XSD-NEW');
  assert.equal(rows[1].correlation.order_no, 'XSD-OLD');
  _fs.rmSync(localDir, { recursive: true, force: true });
});
