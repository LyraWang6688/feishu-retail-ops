const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const tempStore = () => new JsonTaskStore({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'json-task-store-')),
  idField: 'task_id',
});

test('concurrent readers never observe a partially written record', async () => {
  const store = tempStore();
  const payload = 'x'.repeat(4000);
  await store.create({ task_id: 'task_1', status: 'queued', payload });

  let reads = 0;
  const reader = (async () => {
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      const record = await store.get('task_1');
      // 关键断言：任何一次读取都必须是一个完整、可解析的记录。
      assert.equal(typeof record.status, 'string');
      reads += 1;
    }
  })();
  const writer = (async () => {
    for (let index = 0; index < 400; index += 1) {
      await store.update('task_1', { seq: index, payload: `${payload}${index}` });
    }
  })();

  await Promise.all([reader, writer]);
  assert.ok(reads > 0, '并发读至少发生一次');
  assert.equal((await store.get('task_1')).status, 'queued');
});

test('list and get ignore leftover temp files from interrupted writes', async () => {
  const store = tempStore();
  await store.create({ task_id: 'task_1', status: 'queued' });
  await fs.promises.writeFile(path.join(store.dir, 'task_1.json.999.abcd.tmp'), '{"task_id":"ta', 'utf8');

  assert.equal((await store.list()).length, 1);
  assert.equal((await store.get('task_1')).status, 'queued');
});

test('create and update leave no temp files behind', async () => {
  const store = tempStore();
  await store.create({ task_id: 'task_1', status: 'queued' });
  await store.update('task_1', { status: 'posted' });

  const files = (await fs.promises.readdir(store.dir)).sort();
  assert.deepEqual(files, ['task_1.json']);
  assert.equal((await store.get('task_1')).status, 'posted');
});
