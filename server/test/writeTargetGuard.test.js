const test = require('node:test');
const assert = require('node:assert/strict');
const { assertWritableBase } = require('../src/utils/writeTargetGuard');

test('write guard refuses an unconfigured target Base', () => {
  assert.throws(() => assertWritableBase({ appToken: '', scriptName: 'demo' }), /没有配置目标 Base/);
  assert.throws(() => assertWritableBase({ appToken: '   ', scriptName: 'demo' }), /没有配置目标 Base/);
});

test('write guard refuses to write when the target environment is not declared', () => {
  assert.throws(
    () => assertWritableBase({ appToken: 'base_token', env: {}, scriptName: 'demo' }),
    /未声明目标环境，已拒绝写入/,
  );
  assert.throws(
    () => assertWritableBase({ appToken: 'base_token', env: { FEISHU_TARGET_ENV: 'production' }, scriptName: 'demo' }),
    /未声明目标环境，已拒绝写入/,
  );
  assert.throws(
    () => assertWritableBase({ appToken: 'base_token', env: { FEISHU_TARGET_ENV: 'staging' }, scriptName: 'demo' }),
    /未声明目标环境，已拒绝写入/,
  );
  assert.throws(
    () => assertWritableBase({ appToken: 'base_token', env: { FEISHU_ALLOW_PRODUCTION_WRITE: 'yes' }, scriptName: 'demo' }),
    /未声明目标环境，已拒绝写入/,
  );
});

test('write guard allows a declared test environment', () => {
  assert.equal(assertWritableBase({ appToken: 'base_token', env: { FEISHU_TARGET_ENV: 'test' } }), 'base_token');
  // 大小写不敏感，避免 .env 里写成 TEST 时被误拒。
  assert.equal(assertWritableBase({ appToken: 'base_token', env: { FEISHU_TARGET_ENV: ' TEST ' } }), 'base_token');
});

test('write guard allows production only with an explicit override', () => {
  assert.equal(
    assertWritableBase({
      appToken: 'base_token',
      env: { FEISHU_TARGET_ENV: 'production', FEISHU_ALLOW_PRODUCTION_WRITE: 'true' },
    }),
    'base_token',
  );
  assert.equal(
    assertWritableBase({ appToken: 'base_token', env: { FEISHU_ALLOW_PRODUCTION_WRITE: 'TRUE' } }),
    'base_token',
  );
});
