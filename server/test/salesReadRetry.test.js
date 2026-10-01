const test = require('node:test');
const assert = require('node:assert/strict');
const { isDataNotReady, withSalesReadRetry } = require('../src/services/salesReadRetry');

test('sales read retry recognizes Feishu code even when SDK exposes only generic HTTP 400', async () => {
  let attempts = 0;
  const result = await withSalesReadRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('Request failed with status code 400');
      error.response = { data: { code: 1254607, msg: 'Data not ready, please try again later' } };
      throw error;
    }
    return 'ready';
  }, 'test_read', { delays: [0, 0, 0] });
  assert.equal(result, 'ready');
  assert.equal(attempts, 3);
});

test('sales read retry does not repeat unrelated HTTP 400 or exceed its bound', async () => {
  let attempts = 0;
  const invalid = new Error('Request failed with status code 400');
  invalid.response = { data: { code: 1254064, msg: 'Invalid field' } };
  assert.equal(isDataNotReady(invalid), false);
  await assert.rejects(withSalesReadRetry(async () => { attempts += 1; throw invalid; },
    'invalid_read', { delays: [0, 0, 0] }), /status code 400/);
  assert.equal(attempts, 1);

  const pending = new Error('Data not ready');
  await assert.rejects(withSalesReadRetry(async () => { attempts += 1; throw pending; },
    'pending_read', { delays: [0, 0, 0] }), /Data not ready/);
  assert.equal(attempts, 4);
});
