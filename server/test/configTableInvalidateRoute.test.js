'use strict';

/**
 * 路由级失效：飞书 record_changed 命中配置表时，下一次 getConfigRows 必须重读。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_token_test';
const { createLarkEventHandlers } = require('../src/routes/larkEvents');
const { getConfigRows, resetConfigTableCache } = require('../src/services/configTableCache');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

test('record_changed → 配置表缓存失效，下一次读取重读', async () => {
  resetConfigTableCache();
  let reads = 0;
  const gateway = {
    listAll: async () => {
      reads += 1;
      return [{ record_id: 'rec_pay', fields: { 收款方式: '微信扫码' } }];
    },
  };
  await getConfigRows({ gateway, tableKey: 'paymentMethod' });
  assert.equal(reads, 1);

  const handlers = createLarkEventHandlers({});
  handlers['drive.file.bitable_record_changed_v1']({
    file_token: V1_BITABLE_SCHEMA.appToken,
    table_id: V1_BITABLE_SCHEMA.tables.paymentMethod.tableId,
    action_list: [{ record_id: 'rec_pay', action: 'record_edited' }],
  });
  await new Promise((resolve) => setImmediate(resolve));

  await getConfigRows({ gateway, tableKey: 'paymentMethod' });
  assert.equal(reads, 2, '路由收到 record_changed 后必须失效并重读');
});
