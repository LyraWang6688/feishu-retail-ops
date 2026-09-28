const test = require('node:test');
const assert = require('node:assert/strict');
const { until, isDataNotReady } = require('../scripts/test_inventory_e2e');

test('inventory E2E readback retries Feishu 1254607 and then succeeds', async () => {
  let reads = 0;
  let pauses = 0;
  const result = await until(async () => {
    reads += 1;
    if (reads < 3) throw Object.assign(new Error('Request failed with status code 400'),
      { response: { data: { code: 1254607, msg: 'Data not ready' } } });
    return { record_id: 'ready' };
  }, '测试读回', { attempts: 3, pause: async () => { pauses += 1; } });
  assert.deepEqual(result, { record_id: 'ready' });
  assert.equal(reads, 3);
  assert.equal(pauses, 2);
  assert.equal(isDataNotReady(new Error('读取失败 (Code: 1254607)')), true);
});

test('inventory E2E readback does not retry unrelated Feishu errors', async () => {
  let reads = 0;
  await assert.rejects(until(async () => {
    reads += 1;
    throw Object.assign(new Error('Forbidden'), { response: { data: { code: 99991672 } } });
  }, '测试读回', { pause: async () => {} }), /Forbidden/);
  assert.equal(reads, 1);
});

test('inventory E2E readback stops after bounded transient retries', async () => {
  let reads = 0;
  await assert.rejects(until(async () => {
    reads += 1;
    throw Object.assign(new Error('not ready'), { response: { data: { code: 1254607 } } });
  }, '测试读回', { attempts: 3, pause: async () => {} }), /3 次尝试后未能读回/);
  assert.equal(reads, 3);
});
