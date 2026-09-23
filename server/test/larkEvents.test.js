const test = require('node:test');
const assert = require('node:assert/strict');
const { sameToken } = require('../src/routes/larkEvents');

test('Feishu callback token comparison rejects missing and mismatched values', () => {
  assert.equal(sameToken('token-1', 'token-1'), true);
  assert.equal(sameToken('token-1', 'token-2'), false);
  assert.equal(sameToken('', ''), false);
});
