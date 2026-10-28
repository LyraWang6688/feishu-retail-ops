/**
 * 采购页写入件**形状适配**判据（Bug-1 / P0 回归，2026-10-28 真测试 Base 验证发现）：
 *   引擎给写入件的是**扁平 payload**；既有 `publishPurchaseRequest(taskId, task)` 要的是
 *   **本地任务记录**（`task.draft` 才是 payload）⇒ 不包一层就是「HTTP 假成功、后台零写入」。
 *
 * 本文件的断言**能真红**：假 publisher 硬断言 `task.draft.is_batch === true`；
 * 把旧形状（直接传 payload）喂进去必须抛错（AC-W1 的反向探针）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_procurement_writers';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'procurement_writers_secret';

const { createProcurementPurchaseWriters } = require('../src/services/procurementPurchaseWriters');
const { createProcurementPageSubmitService } = require('../src/services/procurementPageSubmitService');
const { buildProcurementPageConfig } = require('../src/config/procurementPage');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const config = buildProcurementPageConfig({});
const PF = V1_BITABLE_SCHEMA.tables.product.fields;
const CF = V1_BITABLE_SCHEMA.tables.color.fields;
const NOW = Date.parse('2026-10-28T09:00:00+08:00');
const SUBMIT_KEY = 'procurement_writer_shape_0001';

const makeStore = () => {
  const data = new Map();
  return {
    data,
    async get(id) { return data.get(id) || null; },
    async create(task) {
      assert.ok(task?.task_id, '本地任务必须有 task_id');
      const record = { ...task, created_at: 'T', updated_at: 'T' };
      data.set(task.task_id, record);
      return record;
    },
    async update(id, patchOrMutator) {
      const current = data.get(id);
      if (!current) throw new Error(`任务不存在: ${id}`);
      const patch = typeof patchOrMutator === 'function' ? patchOrMutator(current) : patchOrMutator;
      const next = { ...current, ...patch, updated_at: 'T' };
      data.set(id, next);
      return next;
    },
  };
};

/** 假 publisher：**按既有 `publishPurchaseRequest` 的契约硬断言**（这就是"能真红"的判据）。 */
const makePublisher = () => {
  const calls = [];
  return {
    calls,
    async publishPurchaseRequest(taskId, task, options = {}) {
      assert.ok(task && typeof task === 'object', '第二实参必须是任务对象');
      assert.ok(task.draft && typeof task.draft === 'object', '任务对象必须有 draft（旧形状会在这里炸）');
      assert.equal(task.draft.is_batch, true, 'draft.is_batch 必须为 true（引擎真实载荷）');
      assert.ok(Array.isArray(task.draft.items) && task.draft.items.length > 0, 'draft.items 必须来自引擎');
      calls.push({ taskId, task, options });
      return { ok: true, batch_no: 'CGD-TEST-0001', batch_record_id: 'recBatchTest', request_ids: ['r1'] };
    },
  };
};

const payloadOf = () => ({
  is_batch: true,
  items: [{ product_record_id: 'recA', size: 39, quantity: 1 }],
  operator_open_id: 'ou_test',
});
const baseWriteService = () => ({ multiItemWriters: () => ({ behavior: async () => ({ recordId: 'recBeh' }) }) });

test('AC-W1 适配层：扁平 payload → 本地 task（含 draft）→ 既有 publish；supplierGroups 原样透传', async () => {
  const store = makeStore();
  const publisher = makePublisher();
  const writers = createProcurementPurchaseWriters({
    gateway: {}, writeService: baseWriteService(), store, webhooks: publisher, config,
  });
  const supplierGroups = [{ supplier_key: 's1', indexes: [0] }];
  const result = await writers.purchase('task_1', payloadOf(), { supplierGroups });
  assert.equal(result.ok, true);
  assert.equal(publisher.calls.length, 1);
  assert.equal(publisher.calls[0].taskId, 'task_1');
  assert.deepEqual(publisher.calls[0].task.draft.items, payloadOf().items);
  assert.deepEqual(publisher.calls[0].options.supplierGroups, supplierGroups, 'supplierGroups 必须透传');
  const task = await store.get('task_1');
  assert.equal(task.kind, config.draft.taskKind, '本地任务 kind 与单货品那条路一致');
  assert.equal(task.status, 'posting');
  assert.equal(task.draft.is_batch, true);
});

test('AC-W1b ⭐ 反向探针：旧形状（直接把 payload 当 task）⇒ 假 publisher 当场抛（证明判据能真红）', async () => {
  const publisher = makePublisher();
  await assert.rejects(
    () => publisher.publishPurchaseRequest('task_old', payloadOf()),
    /任务对象必须有 draft/,
    '旧形状必须被抓住（这正是线上"假成功"的根因）',
  );
});

test('AC-W2 已有本地 task ⇒ 只更新 draft，不重复 create；payload 永远落在 task.draft', async () => {
  const store = makeStore();
  const publisher = makePublisher();
  const writers = createProcurementPurchaseWriters({
    gateway: {}, writeService: baseWriteService(), store, webhooks: publisher, config,
  });
  await store.create({ task_id: 'task_2', kind: 'scan_replenish', status: 'posting', draft: { items: [] } });
  await writers.purchase('task_2', payloadOf(), {});
  const task = await store.get('task_2');
  assert.equal(task.draft.items.length, 1);
  assert.equal(publisher.calls.length, 1);
});

// ── 端到端：submit（accepted）→ 后台那一跑 → 真 publisher 收到正确 task 形状 ──────────
const makeGateway = () => ({
  async getBatch(tableKey, ids) {
    if (tableKey === 'color') return [{ record_id: 'recColor', fields: { [CF.name]: [{ text: '黑色' }] } }];
    return (ids || []).map((id) => ({
      record_id: id,
      fields: {
        [PF.number]: { type: 1, value: [{ text: `no_${id}` }] },
        [PF.itemNo]: [{ text: `item_${id}` }],
        [PF.color]: { link_record_ids: ['recColor'] },
        [PF.supplier]: { link_record_ids: ['recSup'] },
      },
    }));
  },
  async listAll() { return []; },
});
const makeSessions = () => {
  const data = new Map();
  const store = {
    async get(id) { return data.get(id) || null; },
    async update(id, mutate) {
      const base = data.get(id) || {};
      data.set(id, { ...base, ...(mutate(base) || {}) });
      return data.get(id);
    },
  };
  return { idOf: (openId) => `s_${openId}`, async ensure() {}, store, data };
};

test('AC-W3 端到端：修复后 accepted 之后后台**不再因 task 形状失败**，publisher 拿到 draft.is_batch', async () => {
  const store = makeStore();
  const publisher = makePublisher();
  const sessions = makeSessions();
  const writers = createProcurementPurchaseWriters({
    gateway: {}, writeService: baseWriteService(), store, webhooks: publisher, config,
  });
  const scheduled = [];
  const background = { scheduleCustomRest: (args) => { scheduled.push(args); return Promise.resolve({ ok: true }); } };
  const service = createProcurementPageSubmitService({
    gateway: makeGateway(), writeService: { sessions, multiItemWriters: () => ({ behavior: async () => ({ recordId: 'recBeh' }) }) },
    writers, background, config, now: () => NOW, logger: {},
  });
  const result = await service.submit({
    openId: 'ou_test', submitKey: SUBMIT_KEY,
    items: [{ productRecordId: 'recA', entries: [{ size: 39, quantity: 1 }] }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  const backgroundResult = await scheduled[0].run();
  assert.equal(backgroundResult.ok, true, '修复后后台必须成功（不是 write_failed）');
  assert.equal(publisher.calls.length, 1);
  assert.equal(publisher.calls[0].task.draft.items[0].size, 39);
  assert.equal(publisher.calls[0].task.draft.items[0].item_no, 'item_recA');
});

test('AC-W3b ⭐ 反面对照：把旧形状接到同一套 submit ⇒ 后台失败、草稿落 failed（证明"假成功"是真的会红）', async () => {
  const store = makeStore();
  const publisher = makePublisher();
  const sessions = makeSessions();
  const brokenWriters = {
    // 旧形状：直接把引擎 payload 当 task 传下去
    purchase: (taskId, payload) => publisher.publishPurchaseRequest(taskId, payload),
    behavior: async () => ({ recordId: 'recBeh' }),
  };
  const scheduled = [];
  const background = { scheduleCustomRest: (args) => { scheduled.push(args); return Promise.resolve({ ok: true }); } };
  const service = createProcurementPageSubmitService({
    gateway: makeGateway(), writeService: { sessions, multiItemWriters: () => ({ behavior: async () => ({ recordId: 'recBeh' }) }) },
    writers: brokenWriters, background, config, now: () => NOW, logger: {},
  });
  const result = await service.submit({
    openId: 'ou_test', submitKey: SUBMIT_KEY,
    items: [{ productRecordId: 'recA', entries: [{ size: 39, quantity: 1 }] }],
  });
  assert.equal(result.accepted, true, '旧形状下 HTTP 仍然 accepted（这正是 P0 假成功）');
  const backgroundResult = await scheduled[0].run();
  assert.equal(backgroundResult.ok, false, '旧形状后台必须失败');
  assert.equal(publisher.calls.length, 0);
  const session = await sessions.store.get(`s_ou_test`);
  const draft = Object.values(session[config.draft.ordersField] || {})[0];
  assert.equal(draft.status, 'failed', '失败要如实落到本地草稿（可查）');
});
