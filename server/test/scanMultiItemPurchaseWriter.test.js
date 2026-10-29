/**
 * 🔴 回归（P0）：扫码页「一单多货」→ **补货** 的假成功。
 *
 * 故障链（业务负责人 2026-10-29 授权解冻修复）：
 *   扫码页 → 补货 → 一次扫多个货品 → 页面「提交成功」
 *   → `multiItemOrderService` 调写入件 `writer(taskId, **扁平 payload**, { supplierGroups })`
 *   → `multiItemWriters().purchase` 原样转手 → `publishPurchaseRequest` 读 `task.draft` ⇒ undefined
 *   → `Cannot read properties of undefined (reading 'is_batch')` ⇒ 采购批次/明细**零写入**（假成功）。
 *
 * 判据（**都能真红**）：
 *   AC-SMF1 新形状：写入件交给 publisher 的必须是 `task.draft`（扁平 payload 在 `task.draft` 里），
 *           且本地任务记录 `{task_id, kind:'scan_replenish', status:'posting', draft}` 真的建了；
 *           `options.supplierGroups` 原样透传。
 *   AC-SMF2 同一 task 重放 ⇒ **复用/更新同一条本地任务**（不新建第二条）。
 *   AC-SMF3 反向探针：把扁平 payload 直接当 task 调 publisher ⇒ **必须抛 `is_batch`**
 *           （证明 AC-SMF1 不是空跑：改回旧形状 ⇒ AC-SMF1 立刻红）。
 *   AC-SMF4 引擎真跑（一单多货 ≥2 货品）：走真 `multiItemOrderService.submitDraft` ⇒ publisher 收到
 *           `task.draft.is_batch === true`、明细行数对；同 submitKey 重放 ⇒ `reused` 且不重复调写入件。
 *   AC-SMF5 边界：`purchaseReturn` 写入件**没被改**（仍原样收 draft，不包 task）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_fix';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_fix_secret';

const { createScanWriteService } = require('../src/services/scanWriteService');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');

const silentLogger = { logInfo: () => {}, logWarn: () => {}, logError: () => {} };

/** 假 publisher：**与生产同形** —— 读 `task.draft`，扁平 payload 直接传 ⇒ 抛 is_batch（真红探针）。 */
const makePublisher = (calls) => async (taskId, task, options = {}) => {
  const draft = task && task.draft;
  if (!draft || draft.is_batch !== true) {
    throw new Error("Cannot read properties of undefined (reading 'is_batch')");
  }
  calls.push({ taskId, task, options });
  return { batch_no: 'CGD-TEST-0001', batch_record_id: 'rec_batch_test', request_ids: ['rec_req_test'] };
};

/** 内存版本地任务存储（与 JsonTaskStore 同形：get/create/update(函数式 mutator)）。 */
const makeTaskStore = (seed = {}) => {
  const records = new Map(Object.entries(seed).map(([id, task]) => [id, { ...task }]));
  return {
    records,
    async get(id) { return records.has(id) ? { ...records.get(id) } : null; },
    async create(task) { records.set(task.task_id, { ...task }); return { ...task }; },
    async update(id, patchOrMutator) {
      const current = records.has(id) ? { ...records.get(id) } : null;
      const patch = typeof patchOrMutator === 'function' ? patchOrMutator(current) : patchOrMutator;
      const next = { ...(current || {}), ...(patch || {}) };
      records.set(id, next);
      return { ...next };
    },
  };
};

const buildWrite = ({ taskStore, calls, purchaseReturn } = {}) => createScanWriteService({
  gateway: {},
  config: SCAN_WRITE,
  references: { resolveBehavior: async (code) => ({ recordId: `rec_behavior_${code}` }) },
  purchaseStore: taskStore || makeTaskStore(),
  createPurchaseService: () => ({ publishPurchaseRequest: makePublisher(calls) }),
  purchaseReturnService: purchaseReturn,
});

const flatPayload = () => ({
  is_batch: true,
  product_record_id: '',
  behavior_record_id: 'rec_behavior_replenish',
  operator_open_id: 'ou_test',
  items: [
    { product_record_id: 'recA', item_no: 'A1', size: '39', quantity: 1, supplier_record_id: 'sup_1' },
    { product_record_id: 'recB', item_no: 'B1', size: '41', quantity: 2, supplier_record_id: 'sup_2' },
  ],
});

test('AC-SMF1 新形状：写入件把扁平 payload 包进 `task.draft` 再调既有 publish（且 task 记录真的建了）', async () => {
  const calls = [];
  const taskStore = makeTaskStore();
  const writers = buildWrite({ taskStore, calls }).multiItemWriters();
  const payload = flatPayload();
  const supplierGroups = [{ supplier_key: 'sup_1', indexes: [0], detail_count: 1, pair_count: 1 }];

  await writers.purchase('task_scan_multi_001', payload, { supplierGroups });

  assert.equal(calls.length, 1, '写入件必须调一次既有 publish ✓');
  const { taskId, task, options } = calls[0];
  assert.equal(taskId, 'task_scan_multi_001');
  assert.equal(task.kind, 'scan_replenish', '本地任务 kind 与单货品补货同形 ✓');
  assert.equal(task.status, 'posting', '本地任务状态 = posting（既有 publish 会 update 它）✓');
  assert.equal(task.draft, payload, '🔴 交给 publisher 的**必须是 `task.draft`**（扁平 payload 原样放里面）✓');
  assert.equal(task.draft.is_batch, true, '`is_batch` 真实值 ✓');
  assert.deepEqual(options.supplierGroups, supplierGroups, '供应商分组原样透传（既有拆分口径 ✓）');
  assert.equal(taskStore.records.size, 1, '本地任务记录必须真的落地 ✓');
});

test('AC-SMF2 同一 task 重放 ⇒ 复用/更新同一条本地任务（不新建第二条）', async () => {
  const calls = [];
  const taskStore = makeTaskStore({
    task_scan_multi_002: { task_id: 'task_scan_multi_002', kind: 'scan_replenish', status: 'posting', draft: { is_batch: true, items: [{ old: true }] } },
  });
  const writers = buildWrite({ taskStore, calls }).multiItemWriters();
  await writers.purchase('task_scan_multi_002', flatPayload());

  assert.equal(calls.length, 1);
  assert.equal(taskStore.records.size, 1, '不许新建第二条任务 ✓');
  assert.equal(taskStore.records.get('task_scan_multi_002').draft.items.length, 2, 'draft 必须被替换为本次 payload ✓');
  assert.equal(calls[0].task.task_id, 'task_scan_multi_002');
});

test('AC-SMF3 反向探针：旧形状（扁平 payload 当 task）⇒ **必须**抛 is_batch（证明 SMF1 能真红）', async () => {
  const publish = makePublisher([]);
  const payload = flatPayload();
  await assert.rejects(
    () => publish('task_old_shape', payload),
    /reading 'is_batch'/,
    '把扁平 payload 直接当 task ⇒ 生产同款崩溃（所以我们才要包一层 ✓）',
  );
});

test('AC-SMF4 引擎真跑：一单多货补货 ≥2 货品 ⇒ publisher 收到 task.draft.is_batch，同键重放 reused 不重复写', async () => {
  const calls = [];
  const taskStore = makeTaskStore();
  const write = buildWrite({ taskStore, calls });
  const writers = write.multiItemWriters();

  // 与多货品引擎用例同形的会话替身（不写磁盘）
  const records = new Map();
  const idOf = (openId) => `scan_session_${String(openId).replace(/[^a-zA-Z0-9]/g, '')}`;
  const sessions = {
    store: {
      async get(id) { return records.has(id) ? JSON.parse(JSON.stringify(records.get(id))) : null; },
      async create(task) { records.set(task.session_id, JSON.parse(JSON.stringify(task))); return { ...task }; },
      async update(id, patchOrMutator) {
        const current = records.has(id) ? JSON.parse(JSON.stringify(records.get(id))) : null;
        const patch = typeof patchOrMutator === 'function' ? patchOrMutator(current) : patchOrMutator;
        const next = { ...(current || {}), ...(patch || {}) };
        records.set(id, next);
        return { ...next };
      },
    },
    idOf,
    async ensure(openId) {
      const id = idOf(openId);
      if (!records.has(id)) await sessions.store.create({ session_id: id, open_id: String(openId || '') });
      return sessions.store.get(id);
    },
  };
  const engine = createMultiItemOrderService({
    sessions, config: resolveMultiItemOrderConfig({}), writers, logger: silentLogger,
  });

  const opened = await engine.openDraft({ openId: 'ou_test', chain: 'replenish' });
  assert.equal(opened.ok, true);
  const orderKey = opened.orderKey;
  const added = await engine.addItem({
    openId: 'ou_test', chain: 'replenish', orderKey,
    item: { product_record_id: 'recA', item_no: 'A1', number: 'A1|黑色|A', color: '黑色', supplier_record_id: 'sup_1' },
  });
  assert.equal(added.ok, true);
  await engine.addItem({
    openId: 'ou_test', chain: 'replenish', orderKey,
    item: { product_record_id: 'recB', item_no: 'B1', number: 'B1|黑色|A', color: '黑色', supplier_record_id: 'sup_1' },
  });
  await engine.setEntries({ openId: 'ou_test', chain: 'replenish', orderKey, productRecordId: 'recA', entries: [{ size: '39', quantity: 1 }] });
  await engine.setEntries({ openId: 'ou_test', chain: 'replenish', orderKey, productRecordId: 'recB', entries: [{ size: '41', quantity: 2 }] });

  const behavior = await writers.behavior('replenish');
  const result = await engine.submitDraft({
    openId: 'ou_test', chain: 'replenish', orderKey, submitKey: orderKey, behavior,
  });
  assert.equal(result.ok, true, `引擎提交应成功（实际：${JSON.stringify(result)}）`);
  assert.equal(result.reused, false);
  assert.equal(calls.length, 1, '写入件只调一次 ✓');
  const draft = calls[0].task.draft;
  assert.equal(draft.is_batch, true);
  assert.equal(draft.items.length, 2, '一单多货：2 个货品 × 1 行 = 2 行 ✓');
  assert.deepEqual(draft.items.map((one) => [one.product_record_id, one.size, one.quantity]), [['recA', 39, 1], ['recB', 41, 2]]);
  assert.ok(Array.isArray(calls[0].options.supplierGroups) && calls[0].options.supplierGroups.length >= 1, '供应商分组要透传给 publisher ✓');

  // 同一单重放 ⇒ 幂等（引擎 reused，不再调写入件）
  const again = await engine.submitDraft({ openId: 'ou_test', chain: 'replenish', orderKey: orderKey, submitKey: orderKey, behavior });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
  assert.equal(calls.length, 1, '重放不许重复写 ✓');
});

test('AC-SMF5 边界：`purchaseReturn` 写入件没动（仍原样收 draft，不包 task）', async () => {
  const seen = [];
  const write = buildWrite({
    calls: [], purchaseReturn: { submit: async (taskId, draft) => { seen.push({ taskId, draft }); return { ok: true }; } },
  });
  const writers = write.multiItemWriters();
  const draft = { is_batch: true, items: [{ product_record_id: 'recA', size: 39, quantity: 1 }] };
  const result = await writers.purchaseReturn('task_return_001', draft);
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskId, 'task_return_001');
  assert.equal(seen[0].draft, draft, '退货写入件仍**直接**收 draft（这次修复一个字没动它 ✓）');
});
