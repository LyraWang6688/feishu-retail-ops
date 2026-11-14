'use strict';

/** #1210 接线哨兵：路由/客户端/启动恢复三处必须存在，且客户端不再自己轮询。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const PUBLIC = path.join(__dirname, '..', 'public', 'workbench');
const read = (file) => fs.readFileSync(file, 'utf8');

test('AC-PIW1 路由：保存时带 productRecordId、有 print-intent 端点、成功时 flush', () => {
  const route = read(path.join(SRC, 'routes/workbenchInventoryAdjustment.js'));
  assert.match(route, /payload: \{ productRecordId/);
  assert.match(route, /router\.post\('\/pairs\/:jobId\/print-intent'/);
  assert.match(route, /getInventoryPrintIntentService\(\)\.flush/);
});

test('AC-PIW2 启动恢复：app 启动后补做打印意图', () => {
  const app = read(path.join(SRC, 'app.js'));
  assert.match(app, /recoverInventoryPrintIntents/);
});

test('AC-PIW3 客户端：点打印只发一次意图请求，不再自己轮询 job', () => {
  const page = read(path.join(PUBLIC, 'features/inventory/adjustment.js'));
  assert.match(page, /\/print-intent/);
  assert.equal(page.includes('waitForInventoryJob'), false, '旧轮询必须删掉');
  assert.equal(page.includes("'/api/workbench/label-print/jobs'"), false, '打印任务由后端建');
});
