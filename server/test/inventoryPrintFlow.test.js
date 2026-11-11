'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('AC-PF1 库存调整保存后：等库存 job 成功才提交打印；不打印回工作台', () => {
  const page = read('public/workbench/features/inventory/adjustment.js');
  assert.match(page, /state\.inventoryJobId = String\(result\?\.job_id/);
  assert.match(page, /waitForInventoryJob\(state\.inventoryJobId\)/);
  assert.match(page, /await waitForInventoryJob\(state\.inventoryJobId\);\n      const result = await api\.post\('\/api\/workbench\/label-print\/jobs'/);
  assert.match(page, /label-print\.html\?scan=1&print_job=/);
  assert.match(page, /window\.location\.assign\(`\/workbench\/\?toast=/);
});

test('AC-PF2 打印页 ?print_job= 显示任务状态并轮询只读接口', () => {
  const index = read('public/workbench/features/labels/index.js');
  assert.match(index, /print_job/);
  assert.match(index, /mountPrintJobStatus/);
  const status = read('public/workbench/features/labels/printJobStatus.js');
  assert.match(status, /\/api\/workbench\/label-print\/jobs\//);
  assert.match(status, /setTimeout\(poll, 2000\)/);
  const route = read('src/routes/labelPrintQueue.js');
  assert.match(route, /router\.get\('\/jobs\/:jobId'/);
});
