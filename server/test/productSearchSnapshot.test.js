'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getProductSearchSnapshot, warmProductSearchSnapshot, resetProductSearchSnapshot,
} = require('../src/services/productSearchSnapshot');

test('快照 TTL 内命中；过期时先返回旧数据，后台刷新失败也不影响', async () => {
  resetProductSearchSnapshot();
  let now = 1_000;
  let fail = false;
  const gateway = {
    schema: { appToken: 'app_snapshot_test' },
    table: () => ({ tableId: 'tbl_product' }),
    listAll: async () => {
      if (fail) throw new Error('1254607');
      return [{ record_id: 'r1' }];
    },
  };
  await warmProductSearchSnapshot({ gateway, now: () => now });
  assert.equal((await getProductSearchSnapshot({ gateway, now: () => now, ttlMs: 60_000 })).length, 1);

  now += 61_000; // 过期
  fail = true;
  const rows = await getProductSearchSnapshot({ gateway, now: () => now, ttlMs: 60_000 });
  assert.equal(rows.length, 1, '过期但刷新失败 ⇒ 继续用旧快照');
  await new Promise((resolve) => setImmediate(resolve));
});

test('从未成功读过且刷新失败 ⇒ 抛错，不假装空结果', async () => {
  resetProductSearchSnapshot();
  const gateway = {
    schema: { appToken: 'app_snapshot_test_2' },
    table: () => ({ tableId: 'tbl_product' }),
    listAll: async () => { throw new Error('1254607'); },
  };
  await assert.rejects(
    () => getProductSearchSnapshot({ gateway, ttlMs: 60_000 }),
    /1254607/,
  );
});
