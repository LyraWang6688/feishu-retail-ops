const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeMeta } = require('../src/utils/logger');

test('logger keeps diagnostic table keys while redacting credentials and identities', () => {
  const result = sanitizeMeta({
    table_key: 'salesEntry',
    message_id: 'om_1234567890',
    app_token: 'secret-app-token-value',
    sender_open_id: 'ou_sensitive_identity',
  });
  assert.equal(result.table_key, 'salesEntry');
  assert.equal(result.message_id, 'om_1234567890');
  assert.notEqual(result.app_token, 'secret-app-token-value');
  assert.notEqual(result.sender_open_id, 'ou_sensitive_identity');
});
