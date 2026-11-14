'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('AC-PF1 库存调整保存后：点打印只记**后端意图**并回工作台（#1210）', () => {
  const page = read('public/workbench/features/inventory/adjustment.js');
  assert.match(page, /state\.inventoryJobId = String\(result\?\.job_id/);
  assert.match(page, /\/print-intent/);
  assert.equal(page.includes('waitForInventoryJob'), false, '旧的前端轮询必须删掉');
  assert.equal(page.includes("api.post('/api/workbench/label-print/jobs'"), false, '打印任务由后端建');
  assert.match(page, /window\.location\.assign\(`\/workbench\/\?toast=/);
  assert.match(page, /printQueuedToast/);
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
