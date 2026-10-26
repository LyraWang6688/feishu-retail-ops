require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * task-36（**第 1 步 / 影子跑**）：「一单多货品」—— 本单草稿 + 批量提交。
 *
 * 设计：`docs/multi-item-order-design-2026-10-15.md`（§10 配置清单 · §13 判据迁移表 · §14 风险）。
 * 业务负责人 2026-10-15 确认的清单：**每单 20 货品 / 50 行**（可配）· 总开关 **`false`（先影子跑）** ·
 * 退货超库存 **`cap+report`（如实少退）** · 异步**第二步才开** · 批次号**复用既有生成器** ·
 * 尺码规则**不搬不重写** ✓
 *
 * 本文件钉 9 条 AC（每条都能真红）：
 *   AC-MI1 影子模式**零写入**（假写入件调用 0 次 + 源码哨兵：不直连 gateway）
 *   AC-MI2 **N=1 与旧路径逐字等价**（`services/scanWriteService.js:1449` / `:1601` 那个形状）
 *   AC-MI3 **N 货品 ⇒ 1 批次 + N×M 行**（行数与幂等键逐字可查）
 *   AC-MI4 **同货号同尺码重复 ⇒ 拦住 + 人话 + 零写入**
 *   AC-MI5 ⭐ **第 2 单不被第 1 单吸收**（`orderKey` 轮换）
 *   AC-MI6 **并发提交同一 `orderKey` ⇒ 只落一次**
 *   AC-MI7 **超上限（20/50）⇒ 拒单 + 人话 + 零写入**
 *   AC-MI8 **改配置即改行为** + **显式布尔**（禁 `||` 兜底）
 *   AC-MI9 §13 那些"既有判据的承载"**一条没动**（源码哨兵）+ 引擎里**不许按链分支** ✗
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_multi_item';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'multi_item_secret';

const { resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const SERVICE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/services/multiItemOrderService.js'), 'utf8');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/config/multiItemOrder.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// 假件：会话存储（**与 scanSessionService 同一个 store 的形状**）+ 假写入件 + 假日志
// ═══════════════════════════════════════════════════════════════════════════

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
    records,
    idOf,
    async ensure(openId) {
      const id = idOf(openId);
      if (!records.has(id)) await store.create({ session_id: id, open_id: String(openId || '') });
      return store.get(id);
    },
  };
};

const makeLogs = () => {
  const entries = [];
  return {
    entries,
    logger: {
      logInfo: (event, detail) => entries.push({ event, detail }),
      logWarn: (event, detail) => entries.push({ event, detail }),
      logError: (event, detail) => entries.push({ event, detail }),
    },
  };
};

const makeWriters = () => {
  const calls = [];
  return {
    calls,
    writers: {
      purchase: async (taskId, payload) => { calls.push({ writer: 'purchase', taskId, payload }); return { batch_no: 'CGD-1' }; },
      purchaseReturn: async (taskId, payload) => { calls.push({ writer: 'purchaseReturn', taskId, payload }); return { batch_no: 'CGTH-1' }; },
    },
  };
};

const build = ({ env = {}, enabled = false } = {}) => {
  const config = resolveMultiItemOrderConfig({
    SCAN_MULTI_ITEM_ENABLED: enabled ? 'true' : 'false', ...env,
  });
  const sessions = makeSessions();
  const logs = makeLogs();
  const writers = makeWriters();
  // ⚠️ 只注入**既有写入件**的假替身（真实现是 purchaseWebhookService / purchaseReturnService）——
  //    本模块**没有任何 gateway 依赖** ✓（AC-MI1 的源码哨兵钉着）
  const service = createMultiItemOrderService({
    sessions, config, writers: writers.writers, logger: logs.logger,
    now: () => Date.parse('2026-10-15T22:00:00+08:00'),
  });
  return { config, sessions, logs, writers, service };
};

/** 一个货品（`entries` = 勾的尺码 + 数量）。 */
const item = (id, entries, extra = {}) => ({
  product_record_id: `rec_${id}`,
  number: `${id}|黑色|A`,
  item_no: id,
  color: '黑色',
  supplier_record_id: `sup_${id}`,
  entries,
  ...extra,
});

const behavior = { recordId: 'rec_behavior_purchase', kind: 'purchase_request' };

const submit = (h, { chain = 'replenish', orderKey, submitKey, stockView = null, behavior: b = behavior } = {}) =>
  h.service.submitDraft({ openId: 'ou_me', chain, orderKey, submitKey, stockView, behavior: b });

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI1 影子模式零写入
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI1 ⭐⭐ 影子模式（enabled=false）⇒ **零写入**：既有写入件一次都没被调 + 只记一条影子日志', async () => {
  const h = build();
  assert.equal(h.config.enabled, false, '默认就是影子跑（她确认的清单 ✓）');
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  assert.equal(opened.ok, true);
  await h.service.addItem({
    openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item('K1', [{ size: '40', quantity: '2' }]),
  });
  const result = await submit(h, { orderKey: opened.orderKey, submitKey: opened.orderKey });
  assert.equal(result.ok, true, '影子跑也要**成功返回**（她要看"这一单会提交什么"）✓');
  assert.equal(result.shadow, true, '这一跑是影子 ✓');
  // 🔴 零写入：两个既有写入件一次都没被调
  assert.deepEqual(h.writers.calls, [], '🔴 影子模式**一个字节都不许写**（能真红：真去调写入件 ⇒ 红）');
  // 影子日志带上了"会提交什么"
  const shadow = h.logs.entries.find((entry) => entry.event === h.config.events.shadowSubmit);
  assert.ok(shadow, '要留一条影子日志（排查时按它 grep ✓）');
  assert.equal(shadow.detail.batch_count, 1);
  assert.equal(shadow.detail.detail_count, 1);
  assert.deepEqual(shadow.detail.detail_keys, [`purchase_request:${shadow.detail.task_id}:rec_K1:40`]);
});

test('AC-MI1b 🔴 源码哨兵：新模块**不直连 gateway**（连它都不认识）、也不认识飞书字段映射', () => {
  const code = SERVICE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['gateway.create', 'gateway.update', 'v1BitableGateway', 'create/update']) {
    assert.equal(code.includes(forbidden), false, `新引擎里不许出现 ${forbidden}（写入只经既有业务件 ✗）`);
  }
  // 也不许自己拼飞书字段名（映射只有 config/v1BitableSchema.js 一处 ✓）
  assert.equal(code.includes('v1BitableSchema'), false, '引擎不认识飞书字段名 ✓');
  assert.equal(code.includes('require(') && code.includes("'../infrastructure/"), false,
    '引擎不直接碰存储基础设施（草稿走既有 scanSessionService 的 store ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI2 N=1 与旧路径逐字等价
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI2 ⭐⭐ N=1 ⇒ 载荷与旧路径（scanWriteService 的 draft 形状）**逐字等价**', async () => {
  const h = build();
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await h.service.addItem({
    openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey,
    item: item('K1', [{ size: '40', quantity: '2' }, { size: '41', quantity: '' }]),
  });
  const loaded = await h.service.readDraft({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey });
  // ⚠️ 与真实流水线同序：**先校验**（尺码 / 数量在那里规范化：`'40'` ⇒ `40`、空数量 ⇒ 默认值 ✓）**再算载荷**
  const checked = h.service.validateDraft({ draft: loaded.draft, chainConfig: h.config.chains.replenish });
  assert.equal(checked.ok, true);
  const plan = h.service.planSubmission({
    draft: { ...loaded.draft, items: checked.normalized.items },
    chainConfig: h.config.chains.replenish, submitKey: opened.orderKey, behavior,
  });
  // ⚠️ 期望值**逐字抄自** `services/scanWriteService.js:1449-1461`（补货那条老路径的 `draft`）——
  //    唯一差别是 N>1 时批次级那三列留空（N=1 时它们照旧 ✓）
  assert.deepEqual(plan.payload, {
    is_batch: true,
    product_record_id: 'rec_K1',
    product_number: 'K1|黑色|A',
    item_no: 'K1',
    color: '黑色',
    supplier_record_id: 'sup_K1',
    behavior_record_id: 'rec_behavior_purchase',
    operator_open_id: 'ou_me',
    items: [
      {
        product_record_id: 'rec_K1',
        product_number: 'K1|黑色|A',
        item_no: 'K1',
        color: '黑色',
        supplier_record_id: 'sup_K1',
        size: 40,
        quantity: 2,
        behavior_record_id: 'rec_behavior_purchase',
        behavior_kind: 'purchase_request',
      },
      {
        product_record_id: 'rec_K1',
        product_number: 'K1|黑色|A',
        item_no: 'K1',
        color: '黑色',
        supplier_record_id: 'sup_K1',
        size: 41,
        // 勾了不填 ⇒ 按配置默认值（= 1 双 ✓ 与旧路径 `scanWriteService.js:1398` 同一行口径）
        quantity: 1,
        behavior_record_id: 'rec_behavior_purchase',
        behavior_kind: 'purchase_request',
      },
    ],
  }, 'N=1 的载荷必须与旧路径逐字一致（能真红：少一列 / 改一个值 ⇒ 红）');
  // task id 也逐字同形：`<taskIdPrefix>_<清洗过的 key>`（旧路径 `scanWriteService.js:1464`）
  assert.equal(plan.taskId,
    `scan_replenish_${opened.orderKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    'task id 与旧路径同形 ✓（幂等靠它 ⇒ 形状变了就会重复建单 ✗）');
});

test('AC-MI2b ⭐⭐ N=1（退货链）⇒ 载荷与旧路径逐字等价（**不写行为列**、带整单金额）', async () => {
  const h = build();
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'return' });
  await h.service.addItem({
    openId: 'ou_me', chain: 'return', orderKey: opened.orderKey, item: item('K2', [{ size: '42', quantity: '1' }]),
  });
  await h.sessions.store.update(h.sessions.idOf('ou_me'), (session) => ({
    orders: {
      ...(session.orders || {}),
      [opened.orderKey]: { ...session.orders[opened.orderKey], order_amount: '399' },
    },
  }));
  const loaded = await h.service.readDraft({ openId: 'ou_me', chain: 'return', orderKey: opened.orderKey });
  const checked = h.service.validateDraft({ draft: loaded.draft, chainConfig: h.config.chains.return });
  assert.equal(checked.ok, true, '整单金额在（399）⇒ 校验放行 ✓');
  const plan = h.service.planSubmission({
    draft: { ...loaded.draft, items: checked.normalized.items },
    chainConfig: h.config.chains.return, submitKey: opened.orderKey, behavior,
  });
  // 逐字抄自 `scanWriteService.js:1601-1614`（退货那条老路径的 `draft`）
  assert.deepEqual(plan.payload, {
    product_record_id: 'rec_K2',
    product_number: 'K2|黑色|A',
    item_no: 'K2',
    color: '黑色',
    supplier_record_id: 'sup_K2',
    behavior_record_id: 'rec_behavior_purchase',
    operator_open_id: 'ou_me',
    items: [{
      product_record_id: 'rec_K2', product_number: 'K2|黑色|A', item_no: 'K2', color: '黑色',
      supplier_record_id: 'sup_K2', size: 42, quantity: 1,
    }],
    order_amount: '399',
  }, '退货 N=1 载荷逐字等价（**明细不带行为列** ✓、整单金额原样透传 ✓）');
  assert.equal(Object.prototype.hasOwnProperty.call(plan.payload, 'is_batch'), false,
    '退货那条链**没有** `is_batch`（与旧路径一致 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI3 N 货品 ⇒ 1 批次 + N×M 行
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI3 ⭐⭐ N 货品 ⇒ **1 个批次 + N×M 行明细**（行数与幂等键逐字可查、逐行含货品+尺码）', async () => {
  const h = build();
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item('K1', [{ size: '40', quantity: '2' }, { size: '41', quantity: '1' }]) });
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item('K2', [{ size: '40', quantity: '3' }]) });
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item('K3', [{ size: '42', quantity: '1' }, { size: '43', quantity: '1' }]) });
  const result = await submit(h, { orderKey: opened.orderKey, submitKey: opened.orderKey });
  assert.equal(result.ok, true);
  const plan = result.plan;
  assert.equal(plan.batchCount, 1, 'N 货品**只建 1 个批次** ✓');
  assert.equal(plan.summary.product_count, 3);
  assert.equal(plan.summary.detail_count, 5, '3 个货品一共 5 行（2+1+2）✓');
  assert.equal(plan.details.length, 5);
  assert.equal(plan.payload.items.length, 5, '载荷里也是 5 行 ✓');
  // 每行的幂等键**必须含「货品 + 尺码」**（否则两个货品同尺码会撞车 ✗ §14 风险 6）
  const keys = plan.details.map((detail) => detail.idempotency_key);
  assert.equal(new Set(keys).size, 5, '5 行的幂等键**互不相同** ✓（K1/40 与 K2/40 不许撞 ✗）');
  assert.ok(keys.includes(`purchase_request:${plan.taskId}:rec_K1:40`));
  assert.ok(keys.includes(`purchase_request:${plan.taskId}:rec_K2:40`), '两个货品的 40 码是**两把不同的键** ✓');
  // N>1 ⇒ 批次级"那一个货品"的三列留空（一单多货品没有"一个货品"可言 ✓）
  assert.equal(plan.payload.product_record_id, '');
  assert.equal(plan.payload.item_no, '');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI4 同货号同尺码重复 ⇒ 拦住
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI4 🔴 同货号 + 同尺码重复 ⇒ **拦住 + 人话 + 零写入**（两个货品同尺码**允许** ✓）', async () => {
  const h = build();
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await h.service.addItem({
    openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey,
    item: item('K1', [{ size: '40', quantity: '1' }, { size: '40', quantity: '2' }]),
  });
  const bad = await submit(h, { orderKey: opened.orderKey, submitKey: opened.orderKey });
  assert.equal(bad.ok, false, '重复行必须拦住 ✓');
  assert.equal(bad.code, 'duplicate_line');
  assert.match(bad.message, /40/, '人话里要写清**哪个尺码**重复了 ✓');
  assert.deepEqual(h.writers.calls, [], '🔴 拦住时**零写入** ✓');

  // 对照组：**不同货品**的同尺码**允许**（这是多货品的正常形态 ✓）
  const ok = build();
  const opened2 = await ok.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await ok.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened2.orderKey, item: item('K1', [{ size: '40', quantity: '1' }]) });
  await ok.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened2.orderKey, item: item('K2', [{ size: '40', quantity: '1' }]) });
  const good = await submit(ok, { orderKey: opened2.orderKey, submitKey: opened2.orderKey });
  assert.equal(good.ok, true, '两个货品各自的 40 码 ⇒ 两行、允许 ✓');
  assert.equal(good.plan.summary.detail_count, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI5 第 2 单不被第 1 单吸收
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI5 ⭐⭐ `orderKey` 轮换 ⇒ **第 2 单不会被第 1 单吸收**（同一 `orderKey` 重放仍复用 ✓）', async () => {
  const h = build();
  const first = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: first.orderKey, item: item('K1', [{ size: '40', quantity: '1' }]) });
  const submitted1 = await submit(h, { orderKey: first.orderKey, submitKey: first.orderKey });
  assert.equal(submitted1.ok, true);

  // ① 同一把 `orderKey` 再提交 ⇒ **复用**（连接点两次 ≠ 写两次 ✓）
  const again = await submit(h, { orderKey: first.orderKey, submitKey: first.orderKey });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true, '同一单重放 ⇒ reused ✓（幂等）');

  // ② 她接着做第 2 单 ⇒ **新 `orderKey`**（不是第一单那把）
  const second = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  assert.notEqual(second.orderKey, first.orderKey, '⭐ 提交成功后 `orderKey` **必须轮换** ✓');
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: second.orderKey, item: item('K9', [{ size: '44', quantity: '2' }]) });
  const submitted2 = await submit(h, { orderKey: second.orderKey, submitKey: second.orderKey });
  assert.equal(submitted2.ok, true);
  assert.notEqual(submitted2.plan.taskId, submitted1.plan.taskId,
    '⭐ 第 2 单有自己的 task id（**不许被第 1 单的假成功吸收** ✗ —— 这正是 `replenishFingerprint` 那个坑）');
  assert.equal(submitted2.plan.summary.detail_count, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI6 并发提交同一 orderKey ⇒ 只落一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI6 🔴 并发提交同一 `orderKey` ⇒ **只落一次**（真写入件只被调一次）', async () => {
  const h = build({ enabled: true }); // 打开开关 ⇒ 这一步真的会调既有写入件（假替身）
  const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item('K1', [{ size: '40', quantity: '1' }]) });
  const [a, b] = await Promise.all([
    submit(h, { orderKey: opened.orderKey, submitKey: opened.orderKey }),
    submit(h, { orderKey: opened.orderKey, submitKey: opened.orderKey }),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(h.writers.calls.length, 1, '🔴 并发两跑 ⇒ 写入件**只被调一次** ✓（能真红：去掉去重 ⇒ 2 次）');
  assert.equal(h.writers.calls[0].writer, 'purchase', '补货那条链落到既有「采购申请」写入件 ✓');
  assert.equal(a.plan.taskId, b.plan.taskId, '两次拿到同一把 task id ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI7 超上限 ⇒ 拒单
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI7 🔴 超每单上限（默认 20 货品 / 50 行）⇒ **拒单 + 人话 + 零写入**', async () => {
  // ① 货品数超限（把上限调成 2，省得造 21 个 —— **改配置即改行为** 也在这一条里顺带钉着 ✓）
  const many = build({ env: { SCAN_MULTI_ITEM_MAX_PRODUCTS: '2' } });
  const opened = await many.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  for (const id of ['K1', 'K2', 'K3']) {
    await many.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item(id, [{ size: '40', quantity: '1' }]) });
  }
  const overProducts = await submit(many, { orderKey: opened.orderKey, submitKey: opened.orderKey });
  assert.equal(overProducts.ok, false);
  assert.equal(overProducts.code, 'too_many_products');
  assert.match(overProducts.message, /2/, '人话里要写清**上限是几** ✓');
  assert.deepEqual(many.writers.calls, [], '拦住的单**零写入** ✓');

  // ② 行数超限
  const manyLines = build({ env: { SCAN_MULTI_ITEM_MAX_LINES: '2' } });
  const opened2 = await manyLines.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await manyLines.service.addItem({
    openId: 'ou_me', chain: 'replenish', orderKey: opened2.orderKey,
    item: item('K1', [{ size: '40', quantity: '1' }, { size: '41', quantity: '1' }, { size: '42', quantity: '1' }]),
  });
  const overLines = await submit(manyLines, { orderKey: opened2.orderKey, submitKey: opened2.orderKey });
  assert.equal(overLines.ok, false);
  assert.equal(overLines.code, 'too_many_lines');
  assert.deepEqual(manyLines.writers.calls, [], '拦住的单**零写入** ✓');

  // ③ 默认值就是她确认的 20 / 50（**不是写死** —— 是配置的默认值 ✓）
  const defaults = build();
  assert.equal(defaults.config.maxProducts, 20);
  assert.equal(defaults.config.maxLines, 50);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI8 改配置即改行为 + 显式布尔（禁 || 兜底）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI8 ⭐⭐ 改配置即改行为 + **显式布尔**（空串 = 关掉；认不出的值当场抛；源码里没有 `||` 兜底）', async () => {
  // ① 显式布尔三态
  assert.equal(resolveMultiItemOrderConfig({ SCAN_MULTI_ITEM_ENABLED: 'true' }).enabled, true);
  assert.equal(resolveMultiItemOrderConfig({ SCAN_MULTI_ITEM_ENABLED: '' }).enabled, false,
    '**空串 = 关掉**（这就是"不许 `||` 兜底"要防的那个坑 ✓）');
  // ⚠️ 2026-10-15 晚**成对翻新**（她逐字：「**直接走新逻辑（一单多货品），不需要影子**」）：
  //   改前逐字：`assert.equal(resolveMultiItemOrderConfig({}).enabled, false, '没配 ⇒ 默认影子跑 ✓');`
  //   改后逐字：下面这一行（默认 `true`）
  //   依据：她那句 —— 影子阶段取消 ✗ ⇒ 真实写入成为默认；`''`（空串=关掉）那条**照旧**成立 ✓
  assert.equal(resolveMultiItemOrderConfig({}).enabled, true, '没配 ⇒ **默认直接走新逻辑**（不再影子）✓');
  // ⭐⭐ 2026-10-16 22:5x **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.equal(resolveMultiItemOrderConfig({ SCAN_MULTI_ITEM_ASYNC_ENABLED: 'true' }).asyncEnabled, true, …)`
  //   改后逐字：**那个开关已经不在了** ✗ —— 断言这个键**不存在** ✓（谁把它加回来 ⇒ 红 ✓）
  //   依据 = 业务负责人 22:5x「**不需要开关**」✓（`docs/no-switch-rule-2026-10-16.md` ✓）
  assert.equal('asyncEnabled' in resolveMultiItemOrderConfig({}), false,
    '⭐ `asyncEnabled` 已经**退场** ✗（一单多货的"提交即回"是永远开 ✓ 不许留开关 ✗）');
  assert.throws(() => resolveMultiItemOrderConfig({ SCAN_MULTI_ITEM_ENABLED: '也许' }),
    /显式布尔/, '认不出的值 ⇒ **当场抛**（绝不静默按 true/false 处理 ✓）');

  // ② 改配置即改行为：同一个草稿，上限 1 ⇒ 拦住；上限 20 ⇒ 放行
  const strict = build({ env: { SCAN_MULTI_ITEM_MAX_PRODUCTS: '1' } });
  const loose = build({ env: { SCAN_MULTI_ITEM_MAX_PRODUCTS: '20' } });
  for (const [h, expect] of [[strict, false], [loose, true]]) {
    const opened = await h.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
    await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item('K1', [{ size: '40', quantity: '1' }]) });
    await h.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, item: item('K2', [{ size: '41', quantity: '1' }]) });
    const result = await submit(h, { orderKey: opened.orderKey, submitKey: opened.orderKey });
    assert.equal(result.ok, expect, `上限=${h.config.maxProducts} ⇒ ok=${expect}（改配置即改行为 ✓）`);
  }

  // ③ 幂等键模板也可配（改它 ⇒ 明细键跟着变 ✓）
  const custom = build({ env: { SCAN_MULTI_ITEM_DETAIL_KEY: 'mi:{taskId}:{productKey}:{size}' } });
  const opened3 = await custom.service.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await custom.service.addItem({ openId: 'ou_me', chain: 'replenish', orderKey: opened3.orderKey, item: item('K1', [{ size: '40', quantity: '1' }]) });
  const plan = await submit(custom, { orderKey: opened3.orderKey, submitKey: opened3.orderKey });
  assert.match(plan.plan.details[0].idempotency_key, /^mi:/, '明细幂等键模板来自配置 ✓');

  // ④ 源码哨兵：**布尔一律 readFlag**（不许 `readFlag(...) || 默认值` 这种关不掉的写法 ✗）
  const configCode = CONFIG_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/readFlag\([^)]*\)\s*\|\|/.test(configCode), false,
    '🔴 不许 `readFlag(...) || 兜底`（那会让"清空变量想关掉"关不掉 ✗）');
  assert.equal(/process\.env\.\w+\s*\|\|/.test(configCode), false, '不许 `process.env.X || 兜底` ✗');
  const flags = configCode.match(/readFlag\(/g) || [];
  // 三处：总开关 / 异步开关 / 退货"整单金额必填"（沿用既有键名 ✓）
  assert.ok(flags.length >= 3, `布尔都必须走 readFlag（实际 ${flags.length} 处）✓`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-MI9 §13 的承载没被动过 + 引擎不按链分支
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI9 ⭐⭐ §13 的"既有判据承载"**一条没动**（本步只新增两个文件）+ 引擎**不按链分支** ✗', () => {
  // ① 引擎里不许出现按链分支（"补货/退货只差配置" ✓ §10）
  const code = SERVICE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ["=== 'replenish'", "=== 'return'", "=== 'purchase_return'", 'chain === ', 'chain !== ']) {
    assert.equal(code.includes(forbidden), false, `引擎里不许按链分支：${forbidden} ✗（差异全在 config.chains ✓）`);
  }
  // ② 链与链的差异**确实**在配置里（两个块的键集合一致 ⇒ "只差配置" ✓）
  const cfg = resolveMultiItemOrderConfig({});
  const keysOf = (chain) => Object.keys(cfg.chains[chain]).sort();
  assert.deepEqual(keysOf('replenish'), keysOf('return'),
    '两条链的配置键**集合相同**（只差值 ✓ —— 形状不同就说明引擎里偷偷分叉了）');
  assert.notDeepEqual(cfg.chains.replenish.payload, cfg.chains.return.payload, '差异在配置值里 ✓');

  // ③ §13 那些判据的承载（既有测试文件 / 既有实现）**都还在**且**没被本步改动** —— 抽查锚点：
  const carriers = [
    ['test/legacy-sync/scanPageWrite.test.js', ['AC-RK1', 'AC-RK2', 'AC-RK3']],
    ['test/scanPurchaseReturn.test.js', ['AC-R5', 'AC-R5b', 'AC-R6', 'AC-R7', 'AC-R8', 'AC-R9', 'AC-R10']],
    ['test/scanPurchaseAmountWrite.test.js', ['AC-PAW1', 'AC-PAW3', 'AC-PAW4', 'AC-PAW5', 'AC-PAW6']],
    ['test/scanPurchaseAmountRequired.test.js', ['AC-PA1']],
    ['test/realmSizeBehaviorConfig.test.js', ['AC-RB-1']],
  ];
  for (const [file, markers] of carriers) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const marker of markers) {
      assert.ok(source.includes(marker), `${file} 里的 ${marker} **必须还在**（既有判据一条不许丢 ✗）`);
    }
  }
  // ④ 老的"单货品即时提交"那套**一个字没动**（本步不碰它 ✓ 第 ③ 步才收口）
  const writeSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/scanWriteService.js'), 'utf8');
  assert.ok(writeSrc.includes('replenishFingerprint'), '老的指纹那套**本步不动**（第 ③ 步才删 ✓）');
  assert.ok(writeSrc.includes('const submitReplenish ='), '老路径照旧在 ✓');
  assert.ok(writeSrc.includes('const submitPurchaseReturn ='), '老路径照旧在 ✓');
  // ⑤ 尺码规则**不搬不改**（§8 #8 / §13 #27）
  const scanPageSrc = fs.readFileSync(path.join(__dirname, '..', 'src/config/scanPage.js'), 'utf8');
  assert.ok(scanPageSrc.includes('REALM_SIZE_BEHAVIOR'), '尺码规则仍只有 `config/scanPage.js` 一处 ✓');
  assert.equal(SERVICE_SRC.includes('checkMissingByDefault'), false, '引擎里不许重写尺码规则 ✗');
  // ⑥ 草稿**沿用既有会话存储**（不新建存储 ✓）
  assert.ok(SERVICE_SRC.includes('sessions.store'), '草稿走既有 `scanSessionService` 的 store ✓');
  assert.equal(/new JsonTaskStore/.test(code), false, '🔴 不许新建存储 ✗');
  assert.equal(cfg.session.dir, SCAN_WRITE.session.dir, '会话目录与既有那份**同一个** ✓');
});
