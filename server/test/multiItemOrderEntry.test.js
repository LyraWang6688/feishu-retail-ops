/**
 * task-46（第 2 步 · **她要求直接走新逻辑、不要影子**）：
 *   「**直接走新逻辑（一单多货品），不需要影子**」「好的，**按照（20 货品 / 50 行）**」
 *
 * ⇒ 本步：**默认 `enabled=true`（真实写入）** + **多货品入口载荷** + （N=1 逐字等价不变 ✓）。
 * ⚠️ 引擎 / 校验 / 幂等 / 轮换的**逐条**判据在 `test/multiItemOrderStep1.test.js`（AC-MI1…MI9，
 *    本步**继续钉着** ✓ —— 其中 MI2 = N=1 逐字等价、MI4 = 重复拦、MI7 = 超限拦、MI5/MI6 = 轮换/并发）。
 *    本文件只钉本步**新增的那几件**（AC-ENT1…ENT7），两处**不重复**、也不互相替代 ✓
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_entry';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_entry_secret';

const { resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/services/multiItemOrderService.js'), 'utf8');

const makeSessions = () => {
  const records = new Map();
  const idOf = (openId) => `scan_session_${String(openId).replace(/[^a-zA-Z0-9]/g, '')}`;
  const store = {
    async get(id) { return records.has(id) ? JSON.parse(JSON.stringify(records.get(id))) : null; },
    async create(task) { records.set(task.session_id, JSON.parse(JSON.stringify(task))); return { ...task }; },
    async update(id, patchOrMutator) {
      const current = records.has(id) ? JSON.parse(JSON.stringify(records.get(id))) : null;
      const patch = typeof patchOrMutator === 'function' ? patchOrMutator(current) : patchOrMutator;
      const next = { ...(current || {}), ...(patch || {}) };
      records.set(id, next);
      return { ...next };
    },
  };
  return {
    store,
    idOf,
    async ensure(openId) {
      const id = idOf(openId);
      if (!records.has(id)) await store.create({ session_id: id, open_id: String(openId || '') });
      return store.get(id);
    },
  };
};

const build = ({ env = {} } = {}) => {
  const config = resolveMultiItemOrderConfig(env); // ⚠️ 不传 ENABLED ⇒ 走**默认值**
  const sessions = makeSessions();
  const writes = [];
  const service = createMultiItemOrderService({
    sessions, config,
    writers: service0({ writes }), // 见下：真写入件的假替身（**只记调用**）
    logger: { logInfo: () => {}, logWarn: () => {}, logError: () => {} },
  });
  return { config, sessions, writes, service };
};

/** 假"既有写入件"：**只记调用**（真实现是 publishPurchaseRequest / purchaseReturnService.submit）。 */
const service0 = ({ writes }) => ({
  purchase: async (taskId, payload) => { writes.push({ writer: 'purchase', taskId, payload }); return { batch_no: 'CGD-9' }; },
  purchaseReturn: async (taskId, payload) => { writes.push({ writer: 'purchaseReturn', taskId, payload }); return { batch_no: 'CGTH-9' }; },
});

const group = (id, entries) => ({
  productRecordId: `rec_${id}`, number: `${id}|黑色|A`, itemNo: id, color: '黑色', supplierRecordId: `sup_${id}`, entries,
});

const flow = async (h, { chain = 'replenish', groups, stockView = null, amount = '' }) => {
  const opened = await h.service.openDraft({ openId: 'ou_me', chain });
  const grouped = h.service.groupPayload({ groups });
  for (const item of grouped.items) {
    await h.service.addItem({ openId: 'ou_me', chain, orderKey: opened.orderKey, item });
  }
  // ⚠️ 退货那条链**整单金额必填**（沿用既有 `SCAN_PURCHASE_AMOUNT_REQUIRED` ✓）⇒ 用例要给它
  if (amount) {
    await h.sessions.store.update(h.sessions.idOf('ou_me'), (session) => ({
      orders: {
        ...(session.orders || {}),
        [opened.orderKey]: { ...session.orders[opened.orderKey], order_amount: String(amount) },
      },
    }));
  }
  const result = await h.service.submitDraft({
    openId: 'ou_me', chain, orderKey: opened.orderKey, submitKey: opened.orderKey,
    stockView, behavior: { recordId: 'rec_behavior', kind: 'purchase_request' },
  });
  return { opened, grouped, result };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-ENT1 一单 2 个货品 ⇒ 1 批次 + 2 组明细（**真实写入**）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ENT1 ⭐⭐ 一单加 **2 个货品** ⇒ **1 批次 + 2 组明细**（写入件只被调一次 ✓）', async () => {
  const h = build();
  assert.equal(h.config.enabled, true, '她改口径了 ⇒ **默认就是真实写入**（不再影子）✓');
  const { result } = await flow(h, {
    groups: [group('K1', [{ size: '40', quantity: '2' }]), group('K2', [{ size: '41', quantity: '1' }, { size: '42', quantity: '3' }])],
  });
  assert.equal(result.ok, true, '真实写入成功 ✓');
  assert.equal(result.shadow, false, '**不是影子**（她要求直接走新逻辑 ✓）');
  assert.equal(h.writes.length, 1, '🔴 N 货品 ⇒ **只建 1 个批次**（写入件只被调一次 ✓）');
  const written = h.writes[0];
  assert.equal(written.writer, 'purchase', '补货落到既有「采购申请」写入件 ✓');
  assert.equal(written.payload.items.length, 3, '2 组明细 = 3 行（2 个货品：1 + 2）✓');
  assert.deepEqual([...new Set(written.payload.items.map((line) => line.product_record_id))].sort(), ['rec_K1', 'rec_K2']);
  assert.equal(result.summary.product_count, 2);
  assert.equal(result.summary.detail_count, 3);
  assert.equal(new Set(result.plan.details.map((detail) => detail.idempotency_key)).size, 3,
    '每行一把幂等键（含货品+尺码 ✓）—— 两个货品同尺码也不会撞 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ENT2 N=1 与旧路径逐字等价（默认开关下再钉一次）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ENT2 ⭐⭐ N=1（默认开关下真实写入）⇒ 载荷与旧路径**逐字等价**', async () => {
  const h = build();
  const { result } = await flow(h, { groups: [group('K1', [{ size: '40', quantity: '2' }])] });
  assert.equal(h.writes.length, 1);
  // 逐字抄自 `services/scanWriteService.js:1449-1461`（补货那条老路径的 `draft`）
  assert.deepEqual(h.writes[0].payload, {
    is_batch: true,
    product_record_id: 'rec_K1',
    product_number: 'K1|黑色|A',
    item_no: 'K1',
    color: '黑色',
    supplier_record_id: 'sup_K1',
    behavior_record_id: 'rec_behavior',
    operator_open_id: 'ou_me',
    items: [{
      product_record_id: 'rec_K1', product_number: 'K1|黑色|A', item_no: 'K1', color: '黑色',
      supplier_record_id: 'sup_K1', size: 40, quantity: 2,
      behavior_record_id: 'rec_behavior', behavior_kind: 'purchase_request',
    }],
  }, 'N=1 ⇒ 写出来的与旧路径**一模一样** ✓（能真红：少一列/改一值 ⇒ 红）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ENT3 / AC-ENT4 拦住 + 人话 + 零写入
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ENT3 🔴 同货号同尺码重复 ⇒ 拦住 + 人话 + **零写入**（默认开关下也一样）', async () => {
  const h = build();
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  const grouped = h.service.groupPayload({ groups: [group('K1', [{ size: '40', quantity: '1' }, { size: '40', quantity: '2' }])] });
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: grouped.items[0] });
  const result = await h.service.submitDraft({
    openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, submitKey: opened.orderKey, behavior: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'duplicate_line');
  assert.match(result.message, /40/);
  assert.deepEqual(h.writes, [], '🔴 拦住 ⇒ **一个字节都不写** ✓（真实写入开关下更关键）');
});

test('AC-ENT4 🔴 超上限（20/50 可配）⇒ 拒单 + 人话 + **零写入**', async () => {
  const h = build({ env: { SCAN_MULTI_ITEM_MAX_PRODUCTS: '1' } });
  const { result } = await flow(h, { groups: [group('K1', [{ size: '40', quantity: '1' }]), group('K2', [{ size: '41', quantity: '1' }])] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'too_many_products');
  assert.match(result.message, /1/);
  assert.deepEqual(h.writes, [], '拒单 ⇒ 零写入 ✓');
  assert.equal(build().config.maxProducts, 20, '默认仍是 20 ✓');
  assert.equal(build().config.maxLines, 50, '默认仍是 50 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ENT5 退货超库存 ⇒ 后端如实少退（差额可见）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ENT5 ⭐⭐ 退货超库存 ⇒ **如实少退 + 差额可见**（`cap+report`；绝不退成负数 ✗）', async () => {
  const h = build();
  const { result } = await flow(h, {
    chain: 'return',
    amount: '399',
    groups: [group('K7', [{ size: '42', quantity: '5' }])],
    // 实时库存只有 2 双（前端已经当场拦过；后端这一层**仍然**按能退的记 ✓）
    stockView: (productKey, size) => (productKey === 'rec_K7' && size === '42' ? 2 : null),
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.detail_count, 1);
  assert.equal(h.writes[0].payload.items[0].quantity, 2, '🔴 退 **能退的 2 双**（不是 5 ✗ 更不是负数 ✗）');
  // 差额**如实回报**（她要"差额可见" ✓）
  const opened = await h.service.openDraft({ openId: 'ou_me2', chain: 'return' });
  const grouped = h.service.groupPayload({ groups: [group('K7', [{ size: '42', quantity: '5' }])] });
  await h.service.addItem({ openId: 'ou_me2', chain: 'return', orderKey: opened.orderKey, item: grouped.items[0] });
  const checked = h.service.validateDraft({
    draft: { items: grouped.items, order_amount: '1' },
    chainConfig: h.config.chains.return,
    stockView: () => 2,
  });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.normalized.shortfalls,
    [{ product: 'rec_K7', size: '42', declared: 5, taken: 2, shortage: 3 }],
    '差额逐行如实（她填 5 / 库存 2 ⇒ 短 3 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ENT6 并发只落一次 + 第 2 单不被吸收
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ENT6 🔴 并发同一 `orderKey` ⇒ 只落一次；提交后 `orderKey` 轮换 ⇒ 第 2 单不被吸收', async () => {
  const h = build();
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  const grouped = h.service.groupPayload({ groups: [group('K1', [{ size: '40', quantity: '1' }])] });
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: grouped.items[0] });
  const [a, b] = await Promise.all([
    h.service.submitDraft({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, submitKey: opened.orderKey, behavior: {} }),
    h.service.submitDraft({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, submitKey: opened.orderKey, behavior: {} }),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(h.writes.length, 1, '🔴 并发两跑 ⇒ 只写一次 ✓');
  const next = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  assert.notEqual(next.orderKey, opened.orderKey, '⭐ 提交后轮换 ⇒ 第 2 单自成一单 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ENT7 既有判据 0 行放宽（逐条点名）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ENT7 ⭐⭐ 既有判据**逐条点名仍在**（本步没有改动它们）+ 引擎仍**不按链分支** ✗', () => {
  const carriers = [
    ['test/scanPurchaseReturn.test.js', ['AC-R5', 'AC-R5b', 'AC-R6', 'AC-R7', 'AC-R8', 'AC-R9', 'AC-R10']],
    ['test/scanPurchaseAmountWrite.test.js', ['AC-PAW1', 'AC-PAW2', 'AC-PAW3', 'AC-PAW4', 'AC-PAW5', 'AC-PAW6']],
    ['test/scanPurchaseAmountRequired.test.js', ['AC-PA1']],
    ['test/realmSizeBehaviorConfig.test.js', ['AC-RB-1']],
    // 第 1 步那套（本步**继续钉着** ✓）
    ['test/multiItemOrderStep1.test.js', ['AC-MI1', 'AC-MI2', 'AC-MI3', 'AC-MI4', 'AC-MI5', 'AC-MI6', 'AC-MI7', 'AC-MI8', 'AC-MI9']],
  ];
  for (const [file, markers] of carriers) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const marker of markers) assert.ok(source.includes(marker), `${file} 的 ${marker} 必须还在 ✗`);
  }
  // 引擎仍不按链分支 / 不直连 gateway（第 1 步的哨兵继续成立 ✓）
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ["=== 'replenish'", "=== 'return'", 'gateway.create', 'gateway.update']) {
    assert.equal(code.includes(forbidden), false, `不许出现 ${forbidden} ✗`);
  }
  // 写入件的键名映射只在一处（`resolveWriters`）——引擎里没有 `if (补货)` ✗
  assert.ok(code.includes('resolveWriters'), '入口用 `resolveWriters` 把既有写入件装进来 ✓');
  assert.equal(code.includes('publishPurchaseRequest'), false, '引擎**不认识**具体写入件的名字（键名由配置给 ✓）');
});
