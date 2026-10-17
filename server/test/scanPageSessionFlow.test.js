'use strict';

/** ⭐ 2026-10-18（拆分第 3 刀）：`routes/scanPage/sessionFlow.js` —— 只搬不改。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createMultiItemPending, createPurchaseScheduler } = require('../src/routes/scanPage/sessionFlow');

const fakeWorld = () => {
  const sessions = {};
  const ensured = [];
  const store = {
    async get(key) { return sessions[key] || null; },
    async update(key, updater) {
      const next = updater(sessions[key] || {});
      sessions[key] = { ...(sessions[key] || {}), ...next };
      return sessions[key];
    },
  };
  return {
    sessions,
    ensured,
    writeService: {
      sessions: {
        store,
        idOf: (openId) => `session_${openId}`,
        ensure: async (openId) => { ensured.push(openId); },
      },
    },
  };
};

test('multi-item pending：读写清 + orderKey 只在拿到时覆盖', async () => {
  const world = fakeWorld();
  const { readMultiItemPending, writeMultiItemPending, clearMultiItemPending, multiItemPendingKey } =
    createMultiItemPending({ writeService: world.writeService, multiItemOrderConfig: { session: { ordersField: 'orders' } } });
  assert.deepEqual(await readMultiItemPending('ou_1', 'replenish'), { orderKey: '', items: [] });
  await writeMultiItemPending('ou_1', 'replenish', { orderKey: 'k1', items: [{ size: 38 }] });
  assert.deepEqual(world.ensured, ['ou_1'], '第一次写要先 ensure 会话');
  assert.deepEqual(await readMultiItemPending('ou_1', 'replenish'), { orderKey: 'k1', items: [{ size: 38 }] });
  await writeMultiItemPending('ou_1', 'replenish', { items: [{ size: 39 }] });
  const after = await readMultiItemPending('ou_1', 'replenish');
  assert.equal(after.orderKey, 'k1', '没给 orderKey ⇒ 不许把旧的抹掉');
  assert.deepEqual(after.items, [{ size: 39 }]);
  assert.equal(multiItemPendingKey('replenish'), 'replenish:pending');
  await clearMultiItemPending('ou_1', 'replenish');
  assert.deepEqual(await readMultiItemPending('ou_1', 'replenish'), { orderKey: '', items: [] });
});

test('没有会话夹具 ⇒ 全部静默 no-op（不抛）', async () => {
  const { readMultiItemPending, writeMultiItemPending, clearMultiItemPending } =
    createMultiItemPending({ writeService: null, multiItemOrderConfig: { session: { ordersField: 'orders' } } });
  assert.deepEqual(await readMultiItemPending('ou_1', 'x'), { orderKey: '', items: [] });
  await writeMultiItemPending('ou_1', 'x', { items: [] });
  await clearMultiItemPending('ou_1', 'x');
});

test('schedulePurchaseWrite：原样透传（不拼幂等键）', async () => {
  const calls = [];
  const { schedulePurchaseWrite } = createPurchaseScheduler({
    purchaseBackground: { async schedulePurchaseRest(args) { calls.push(args); return 'ok'; } },
  });
  const args = { chain: 'replenish', requestId: 'r1', submitKey: 'k-1', context: { openId: 'ou' }, restInput: {} };
  assert.equal(await schedulePurchaseWrite(args), 'ok');
  assert.deepEqual(calls[0], args);
});

test('源码哨兵：实现搬走，路由只保留工厂（塞回 ⇒ 红）', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.match(index, /createMultiItemPendingOf\(\{ writeService, multiItemOrderConfig \}\)/);
  assert.match(index, /createPurchaseSchedulerOf\(\{ purchaseBackground \}\)/);
  assert.equal(/const readMultiItemPending = async \(openId, chain\) => \{/.test(index), false);
  assert.equal(/const schedulePurchaseWrite = \(\{ chain, requestId/.test(index), false);
  const flow = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'sessionFlow.js'), 'utf8');
  assert.match(flow, /module\.exports = \{ createMultiItemPending, createPurchaseScheduler \}/);
});
