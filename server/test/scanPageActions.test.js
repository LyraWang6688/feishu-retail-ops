'use strict';

/**
 * ⭐ 2026-10-18（拆分第 1 刀）：`routes/scanPage/actions.js` —— **只搬不改**。
 * 纯逻辑：动作→领域、整单金额三判据、记住最近领域。路由里只剩薄包装。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_WRITE } = require('../src/config/scanWrite');
const {
  realmOfAction, purchaseAmountRequiredFor, purchaseAmountMissing, purchaseAmountInvalid, markRealmUsed,
} = require('../src/routes/scanPage/actions');

const fakeWriteConfig = (over = {}) => ({
  actions: SCAN_WRITE.actions,
  fields: SCAN_WRITE.fields,
  purchaseAmount: { required: true, requiredByRealm: {} },
  ...over,
});

test('realmOfAction：三个提交动作各回自己的领域，其余空串', () => {
  assert.equal(realmOfAction(SCAN_WRITE.actions.submitOrder), 'sales');
  assert.equal(realmOfAction(SCAN_WRITE.actions.replenish), 'replenish');
  assert.equal(realmOfAction(SCAN_WRITE.actions.purchaseReturn), 'purchase_return');
  assert.equal(realmOfAction('unknown_action'), '');
  assert.equal(realmOfAction(''), '');
});

test('整单金额三道闸门：按链路开关 + 空/非数字', () => {
  const cfg = fakeWriteConfig();
  assert.equal(purchaseAmountRequiredFor('replenish', cfg), true);
  assert.equal(purchaseAmountRequiredFor('replenish', fakeWriteConfig({ purchaseAmount: { required: false } })), false);
  assert.equal(purchaseAmountRequiredFor('replenish', fakeWriteConfig({ purchaseAmount: { required: true, requiredByRealm: { replenish: false } } })), false);
  const field = SCAN_WRITE.fields.purchaseAmount;
  assert.equal(purchaseAmountMissing({ [field]: '' }, 'purchase_return', cfg), true);
  assert.equal(purchaseAmountMissing({ [field]: '   ' }, 'purchase_return', cfg), true);
  assert.equal(purchaseAmountMissing({ [field]: '100' }, 'purchase_return', cfg), false);
  assert.equal(purchaseAmountInvalid({ [field]: 'abc' }, 'purchase_return', cfg), true);
  assert.equal(purchaseAmountInvalid({ [field]: '' }, 'purchase_return', cfg), false, '空归 missing 管');
  assert.equal(purchaseAmountInvalid({ [field]: '12.5' }, 'purchase_return', cfg), false);
  // 不需要判的链路 ⇒ 两道都放行
  const off = fakeWriteConfig({ purchaseAmount: { required: true, requiredByRealm: { replenish: false } } });
  assert.equal(purchaseAmountMissing({ [field]: '' }, 'replenish', off), false);
  assert.equal(purchaseAmountInvalid({ [field]: 'abc' }, 'replenish', off), false);
});

test('markRealmUsed：没有会话/没有 openId ⇒ 静默；成功调用；失败只 warn', async () => {
  markRealmUsed({ writeService: null, openId: 'ou_1', realm: 'sales' });
  markRealmUsed({ writeService: { sessions: null }, openId: 'ou_1', realm: 'sales' });
  const calls = [];
  markRealmUsed({
    writeService: { sessions: { setLastRealm: async (openId, realm) => calls.push([openId, realm]) } },
    openId: 'ou_1', realm: 'replenish',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['ou_1', 'replenish']]);
  const warns = [];
  markRealmUsed({
    writeService: { sessions: { setLastRealm: async () => { throw new Error('boom'); } } },
    openId: 'ou_2', realm: 'sales', event: 'scan.failed', logWarn: (event, meta) => warns.push({ event, meta }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warns.length, 1);
  assert.equal(warns[0].event, 'scan.failed');
  assert.equal(warns[0].meta.reason, 'last_realm_write_failed');
});

test('路由里只剩薄包装（源码哨兵：把实现塞回 index.js ⇒ 红）', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.match(index, /require\('\.\/actions'\)/, 'index 必须引用 actions.js');
  assert.equal(/const realmOfAction = \(action\) => \{/.test(index), false, '实现不许留在 index.js');
  assert.match(index, /const realmOfAction = \(action\) => realmOfActionOf\(action, writeConfig\)/);
  assert.equal(/const purchaseAmountRequiredFor = \(realm\) => \{/.test(index), false);
  const actions = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'actions.js'), 'utf8');
  assert.match(actions, /module\.exports = \{/);
  assert.equal(/[^\x00-\x7F]/.test(actions.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), false,
    'actions.js 的**代码**必须 ASCII（中文只在注释里）');
});
