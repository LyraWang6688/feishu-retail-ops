'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { warmConfigCaches, WARM_TABLES } = require('../src/services/configCacheWarmup');
const { resetConfigTableCache } = require('../src/services/configTableCache');

const gatewayOf = (calls) => ({
  listAll: async (key) => { calls.push(key); return [{ record_id: 'r1', fields: { name: 'x' } }]; },
});

test('AC-CW1 启动预热按配置表逐一读一次并写入缓存；第二次命中缓存', async () => {
  resetConfigTableCache();
  const calls = [];
  const gateway = gatewayOf(calls);
  await warmConfigCaches({ gateway, tables: ['paymentMethod', 'sizeManagement', 'product'] });
  assert.deepEqual(calls, ['paymentMethod', 'sizeManagement', 'product']);
  await warmConfigCaches({ gateway, tables: ['paymentMethod', 'sizeManagement', 'product'] });
  assert.deepEqual(calls, ['paymentMethod', 'sizeManagement', 'product'], '第二次全部命中缓存');
});

test('AC-CW2 某张表失败不阻断后面表的预热', async () => {
  resetConfigTableCache();
  const calls = [];
  const gateway = {
    listAll: async (key) => {
      calls.push(key);
      if (key === 'behavior') throw new Error('1254607');
      return [{ record_id: 'r1', fields: { name: 'x' } }];
    },
  };
  await warmConfigCaches({ gateway, tables: ['behavior', 'category'] });
  assert.deepEqual(calls, ['behavior', 'category']);
});

test('AC-CW3 预热清单覆盖配置表，但不把虚拟赠品缓存当物理表预热', () => {
  assert.ok(WARM_TABLES.includes('product'));
  assert.ok(WARM_TABLES.includes('liveInventory'));
  assert.equal(WARM_TABLES.includes('giftAccessory'), false);
});
