'use strict';

/** 网关读请求统一瞬时重试：默认 1 次；确定性错误 / 显式 retry:false 不重试。 */
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_test';
const { V1BitableGateway } = require('../src/services/v1BitableGateway');

const transientError = () => Object.assign(new Error('Data not ready'), { code: 1254607 });
const forbiddenError = () => Object.assign(new Error('forbidden'), { code: 1254303 });

const gatewayWith = (getImpl) => new V1BitableGateway({
  client: { bitable: { appTableRecord: { get: getImpl } } },
  writeScheduler: null,
  drive: {},
});

test('AC-GR1 读记录遇到 1254607 自动重试后成功', async () => {
  let calls = 0;
  const gateway = gatewayWith(async () => {
    calls += 1;
    if (calls === 1) throw transientError();
    return { code: 0, data: { record: { record_id: 'rec1', fields: { 编号: 'A' } } } };
  });
  const record = await gateway.get('product', 'rec1', { retry: { maxRetries: 1, baseDelayMs: 0 } });
  assert.equal(record.record_id, 'rec1');
  assert.equal(calls, 2);
});

test('AC-GR2 确定性错误不重试', async () => {
  let calls = 0;
  const gateway = gatewayWith(async () => { calls += 1; throw forbiddenError(); });
  await assert.rejects(
    () => gateway.get('product', 'rec1', { retry: { maxRetries: 2, baseDelayMs: 0 } }),
    /forbidden/,
  );
  assert.equal(calls, 1);
});

test('AC-GR3 旧链路显式 retry:false 时不重试（避免双层重试）', async () => {
  let calls = 0;
  const gateway = gatewayWith(async () => { calls += 1; throw transientError(); });
  await assert.rejects(() => gateway.get('product', 'rec1', { retry: false }), /Data not ready/);
  assert.equal(calls, 1);
});
