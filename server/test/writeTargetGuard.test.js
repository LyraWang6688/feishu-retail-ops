const test = require('node:test');
const assert = require('node:assert/strict');
const { assertWritableBase, PRODUCTION_APP_TOKEN } = require('../src/utils/writeTargetGuard');

test('write guard refuses an unconfigured target Base', () => {
  assert.throws(() => assertWritableBase({ appToken: '', scriptName: 'demo' }), /没有配置目标 Base/);
  assert.throws(() => assertWritableBase({ appToken: '   ', scriptName: 'demo' }), /没有配置目标 Base/);
});

test('write guard refuses the production Base unless explicitly allowed', () => {
  assert.throws(
    () => assertWritableBase({ appToken: PRODUCTION_APP_TOKEN, env: {}, scriptName: 'demo' }),
    /目标是生产 Base，已拒绝写入/,
  );
  assert.throws(
    () => assertWritableBase({ appToken: PRODUCTION_APP_TOKEN, env: { FEISHU_ALLOW_PRODUCTION_WRITE: 'yes' }, scriptName: 'demo' }),
    /目标是生产 Base，已拒绝写入/,
  );
  assert.equal(
    assertWritableBase({ appToken: PRODUCTION_APP_TOKEN, env: { FEISHU_ALLOW_PRODUCTION_WRITE: 'true' } }),
    PRODUCTION_APP_TOKEN,
  );
});

test('write guard allows an explicitly configured test Base', () => {
  assert.equal(assertWritableBase({ appToken: 'test_base_token', env: {} }), 'test_base_token');
  // 大小写不敏感，避免 .env 里写成 True 时被误拒。
  assert.equal(
    assertWritableBase({ appToken: PRODUCTION_APP_TOKEN, env: { FEISHU_ALLOW_PRODUCTION_WRITE: 'TRUE' } }),
    PRODUCTION_APP_TOKEN,
  );
});
