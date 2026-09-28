const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA, readAppToken } = require('../src/config/v1BitableSchema');

test('target Base must be configured explicitly instead of falling back to a default', () => {
  assert.throws(() => readAppToken({}), /缺少环境变量 FEISHU_V1_BITABLE_APP_TOKEN/);
  assert.throws(() => readAppToken({ FEISHU_V1_BITABLE_APP_TOKEN: '   ' }),
    /缺少环境变量 FEISHU_V1_BITABLE_APP_TOKEN/);
  assert.equal(readAppToken({ FEISHU_V1_BITABLE_APP_TOKEN: ' base_x ' }), 'base_x');
});

test('schema reads the target Base from the environment at access time', () => {
  const saved = process.env.FEISHU_V1_BITABLE_APP_TOKEN;
  try {
    delete process.env.FEISHU_V1_BITABLE_APP_TOKEN;
    assert.throws(() => V1_BITABLE_SCHEMA.appToken, /缺少环境变量 FEISHU_V1_BITABLE_APP_TOKEN/);
    process.env.FEISHU_V1_BITABLE_APP_TOKEN = 'base_from_env';
    assert.equal(V1_BITABLE_SCHEMA.appToken, 'base_from_env');
  } finally {
    if (saved === undefined) delete process.env.FEISHU_V1_BITABLE_APP_TOKEN;
    else process.env.FEISHU_V1_BITABLE_APP_TOKEN = saved;
  }
});

test('importing the schema module never throws even without a configured Base', () => {
  // 模块加载阶段不取值，只有真正访问多维表格时才报错，
  // 否则任何 import 到它的单元测试都会在 CI（无 .env）里直接失败。
  assert.equal(typeof V1_BITABLE_SCHEMA.tables.product.tableId, 'string');
});
