'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-audit-route-'));
process.env.WRITE_AUDIT_DIR = dir;
process.env.WRITE_AUDIT_SALES = 'true';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';

const { createWorkbenchWriteAuditRoutes } = require('../src/routes/workbench/writeAudit');
const { recordWrite } = require('../src/services/writeAuditService');

test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});

test('AC-WR1 不带参数返回最近 24 小时写入', async () => {
  await recordWrite({
    domain: 'sales', tableKey: 'salesEntry', operation: 'create', recordId: 'rec1',
    correlation: { order_no: 'XSD-ROUTE-1' }, fields: { 销售单号: 'XSD-ROUTE-1' },
  });
  const app = express();
  app.use('/api/workbench', createWorkbenchWriteAuditRoutes());
  const { server, port } = await listen(app);
  try {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/workbench/write-audit`)).json();
    assert.equal(body.success, true);
    assert.equal(body.mode, 'recent');
    assert.equal(body.total, 1);
    assert.equal(body.rows[0].table_key, 'salesEntry');
  } finally { server.close(); }
});
