'use strict';

/**
 * ⭐⭐ 2026-10-13（验收提速 ② `/accept`）——「待验收批次列表」提速的验收标准。
 *
 * 病灶（有真实日志依据）：`batches_ms ≈ 2981`（`render_ms: 0` / `batch_count: 0`）——
 * **列表是空的都还要 ~3 秒**：那 3 秒 = **1 次飞书整表读**本身（本机实测单次 RT ≈ 2.4~3.2s），
 * 不是渲染、也不是条数。她真机同量级 4.8~7.4 秒（「点 4、5 次才跳过去」）。
 * ⇒ 三步（AC 如实写，**不许假装 <1s**）：
 *   ① **只读需要的列 + 过滤下推**（`到货状态` 是 type 3 单选 ⇒ **可筛**；生产大表分页时才真见效）
 *   ② ⭐ **短缓存**（TTL 可配，默认 30~60s）⇒ **热读 <1s / 零飞书调用**（"点 4、5 次"的直接解药）
 *      ＋ **验收成功后主动失效**（避免"刚验完还在列表里"）
 *   ③ **冷读如实报下限**（≈1 次 RT）
 *
 * 本文件钉的 AC：
 *   AC-P1 冷读 = **1 次**调用，且**带过滤**、且**只要需要的列**（不用 `listAll`）
 *   AC-P2 TTL 内重复读 ⇒ **零飞书调用**，内容与首次逐字相同
 *   AC-P3 TTL 过期 ⇒ 再读 **1 次**
 *   AC-P4 `invalidate()` ⇒ 下一次**立刻真读**且反映新数据（验收成功后失效的口径）
 *   AC-P5 列表内容与"整表读 + 本地过滤"的**改前口径逐条相同**（record_id 集合 + 各字段值）
 *   AC-P6 过滤公式拼不出来（取值不安全）⇒ **回落整表读**，内容不变（不静默丢批次）
 *   AC-P7 配置：`SCAN_ACCEPT_PENDING_CACHE_TTL_MS` 可配；**认不出的值 ⇒ 抛错**（不静默回落）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_pending_cache';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'pending_cache_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');

const F = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;

/** 三行：两条「未到货」（一条正常、一条没有批次号）+ 一条「已到货」。 */
const makeRecords = () => ([
  {
    record_id: 'rec_pending_1',
    fields: {
      [F.arrivalStatus]: '未到货', [F.batchNo]: 'CGD-1',
      [F.supplier]: '金猴', [F.createdAt]: '2026-10-12', [F.quantity]: '3',
    },
  },
  {
    record_id: 'rec_pending_2',
    fields: { [F.arrivalStatus]: '未到货', [F.batchNo]: '', [F.supplier]: '', [F.createdAt]: '', [F.quantity]: '' },
  },
  {
    record_id: 'rec_done',
    fields: { [F.arrivalStatus]: '已到货', [F.batchNo]: 'CGD-2' },
  },
]);

const makeFake = (records = makeRecords()) => {
  const calls = [];
  return {
    calls,
    reads: () => calls.filter((call) => call.kind === 'listAll' || call.kind === 'listByFilter'),
    gateway: {
      table: (key) => V1_BITABLE_SCHEMA.tables[key],
      listAll: async (key, options) => { calls.push({ kind: 'listAll', key, options }); return records; },
      listByFilter: async (key, filter, options) => {
        calls.push({ kind: 'listByFilter', key, filter, options });
        // 假飞书：**真的按过滤条件筛**（否则"过滤下推"这条 AC 就是假绿）。
        const wanted = String(filter || '').match(/\[([^\]]+)\]="([^"]*)"/);
        if (!wanted) return records;
        return records.filter((row) => String(row.fields?.[wanted[1]] ?? '') === wanted[2]);
      },
    },
  };
};

/** 可注入时钟（TTL 用例不靠 sleep）。 */
const makeService = (fake, { ttlMs = 30000, clock = { now: 1000 } } = {}) => ({
  clock,
  service: new PurchasePendingBatchService({
    gateway: fake.gateway,
    settings: { pending: '未到货' },
    cacheTtlMs: ttlMs,
    now: () => clock.now,
  }),
});

test('AC-P1 冷读 = 1 次调用（带过滤 + 只要需要的列；不用 listAll）', async () => {
  const fake = makeFake();
  const { service } = makeService(fake);
  const batches = await service.listPendingBatches();
  assert.equal(fake.reads().length, 1, `冷读必须只打一次飞书（实际 ${fake.reads().length} 次）`);
  const call = fake.reads()[0];
  assert.equal(call.kind, 'listByFilter', '必须**带过滤**读（把「未到货」下推到飞书）');
  assert.match(String(call.filter), /CurrentValue\.\[.+\]="未到货"/, `过滤公式要钉在「未到货」上：${call.filter}`);
  assert.ok(Array.isArray(call.options?.fieldNames) && call.options.fieldNames.length > 0,
    '必须**只要需要的列**（field_names），别把整表所有列都拉回来');
  assert.deepEqual(batches.map((row) => row.recordId), ['rec_pending_1'],
    '内容：只有「未到货」且有批次号的那条');
});

test('AC-P2 TTL 内重复读 ⇒ **零飞书调用**（热读），内容与首次逐字相同', async () => {
  const fake = makeFake();
  const { service, clock } = makeService(fake);
  const first = await service.listPendingBatches();
  const readsAfterCold = fake.reads().length;
  clock.now += 1000;   // 仍在 TTL 内
  const second = await service.listPendingBatches();
  assert.equal(fake.reads().length, readsAfterCold, 'TTL 内重复读**一次飞书都不许打**');
  assert.deepEqual(second, first, '热读返回同一份内容');
});

test('AC-P3 TTL 过期 ⇒ 再读 1 次（缓存不许变成"永久缓存"）', async () => {
  const fake = makeFake();
  const { service, clock } = makeService(fake, { ttlMs: 30000 });
  await service.listPendingBatches();
  assert.equal(fake.reads().length, 1);
  clock.now += 30001;
  await service.listPendingBatches();
  assert.equal(fake.reads().length, 2, 'TTL 过了必须重新读一次飞书');
});

test('AC-P4 invalidate() ⇒ 下一次**立刻真读**且反映新数据（验收成功后失效的口径）', async () => {
  const fake = makeFake();
  const { service } = makeService(fake);
  await service.listPendingBatches();
  const before = fake.reads().length;
  // 模拟"她刚验收完这一批"：被验收那条从「未到货」变成「已到货」
  fake.gateway.listByFilter = async (key, filter, options) => {
    fake.calls.push({ kind: 'listByFilter', key, filter, options });
    const wanted = String(filter || '').match(/\[([^\]]+)\]="([^"]*)"/);
    return makeRecords().filter((row) => String(row.fields?.[wanted[1]] ?? '') === wanted[2]
      && row.record_id !== 'rec_pending_1');
  };
  service.invalidate();
  const after = await service.listPendingBatches();
  assert.equal(fake.reads().length, before + 1, '失效之后必须真读一次');
  assert.deepEqual(after.map((row) => row.recordId), [], '刚验完那一批**立刻**从列表里消失');
});

test('AC-P5 内容与「整表读 + 本地过滤」的改前口径**逐条相同**', async () => {
  const records = makeRecords();
  const fake = makeFake(records);
  const { service } = makeService(fake);
  const got = await service.listPendingBatches();
  // 改前口径：整表读 + 本地 filter(status === pending) + map（本用例把它原样复刻一遍当对照）
  const expected = records
    .filter((record) => String(record.fields?.[F.arrivalStatus] ?? '').trim() === '未到货')
    .map((record) => ({
      batchNo: String(record.fields?.[F.batchNo] ?? '').trim(),
      recordId: record.record_id,
      suppliers: String(record.fields?.[F.supplier] ?? '').split(/[,，、;；]/).map((x) => x.trim()).filter(Boolean),
      reportedAt: record.fields?.[F.createdAt] ?? '',
      quantity: String(record.fields?.[F.quantity] ?? '').trim(),
    }))
    .filter((item) => item.batchNo);
  assert.deepEqual(got, expected, '提速**不许**改变列表内容（record_id 集合 + 每个字段值逐条相同）');
});

test('AC-P6 过滤公式拼不出来 ⇒ 回落整表读，内容不变（不静默丢批次）', async () => {
  const fake = makeFake();
  // 取值里带不安全字符（引号 / 换行）⇒ `equalsFormula` 返回 null ⇒ 只能整表读
  const { service } = makeService(fake);
  service.settings = { pending: '未\n到货' };
  const batches = await service.listPendingBatches();
  const kinds = fake.reads().map((call) => call.kind);
  assert.ok(kinds.includes('listAll'), `过滤拼不出来时必须回落整表读，实际：${kinds.join('/')}`);
  assert.equal(batches.length, 0, '回落路径的内容仍按同一口径过滤（不把「已到货」也带出来）');
});

test('AC-P7 配置：TTL 可配；**认不出的值 ⇒ 抛错**（不静默回落）', () => {
  const { resolvePendingCacheTtlMs } = require('../src/config/purchasePendingCache');
  assert.equal(resolvePendingCacheTtlMs({ SCAN_ACCEPT_PENDING_CACHE_TTL_MS: '60000' }), 60000, '可配');
  assert.equal(resolvePendingCacheTtlMs({ SCAN_ACCEPT_PENDING_CACHE_TTL_MS: '' }), 45000, '空 = 默认 45 秒');
  assert.equal(resolvePendingCacheTtlMs({}), 45000, '没设 = 默认');
  assert.throws(() => resolvePendingCacheTtlMs({ SCAN_ACCEPT_PENDING_CACHE_TTL_MS: 'abc' }),
    /SCAN_ACCEPT_PENDING_CACHE_TTL_MS/, '认不出的取值要**抛错**（别静默回默认）');
});

test('AC-P8 ⭐ 验收成功 ⇒ 缓存**主动失效**（下一次列表立刻反映，不等 TTL）', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createScanArrivalService } = require('../src/services/scanArrivalService');
  const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
  const invalidated = [];
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'accept-invalidate-')), idField: 'session_id',
  });
  const service = createScanArrivalService({
    gateway: {},
    store,
    // 注入"待验收列表"替身：只关心**验收成功后有没有被失效**。
    pendingBatches: { async listPendingBatches() { return []; }, invalidate() { invalidated.push(Date.now()); } },
    arrivalConversation: { confirmBatchArrival: async () => ({ ok: true }) },
  });
  const openId = 'ou_invalidate_probe';
  const now = Date.now();
  await store.create({
    session_id: service.idOf(openId), batch_no: 'CGD-INV', batch_record_id: 'rec_inv',
    request_ids: [], scans: [{ product_record_id: 'p1', size: 35, quantity: 1 }],
    status: 'active', posted_keys: [], created_at: now, updated_at: now,
  });
  const result = await service.finish({ openId, actualAmount: 100, operatorOpenId: 'ou_op' });
  assert.equal(result.ok, true, '验收要成功（否则谈不上"成功后失效"）');
  assert.equal(invalidated.length, 1, '验收成功那一刻必须**主动失效**待验收列表缓存');
});

test('AC-P9 验收**失败** ⇒ 不失效（没验收成功就别动缓存）', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createScanArrivalService } = require('../src/services/scanArrivalService');
  const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
  const invalidated = [];
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'accept-invalidate-fail-')), idField: 'session_id',
  });
  const service = createScanArrivalService({
    gateway: {},
    store,
    pendingBatches: { async listPendingBatches() { return []; }, invalidate() { invalidated.push(1); } },
    arrivalConversation: { confirmBatchArrival: async () => ({ ok: false, reason: 'boom', message: '失败' }) },
  });
  const openId = 'ou_invalidate_fail';
  const now = Date.now();
  await store.create({
    session_id: service.idOf(openId), batch_no: 'CGD-INV2', batch_record_id: 'rec_inv2',
    request_ids: [], scans: [{ product_record_id: 'p1', size: 35, quantity: 1 }],
    status: 'active', posted_keys: [], created_at: now, updated_at: now,
  });
  const result = await service.finish({ openId, actualAmount: 100, operatorOpenId: 'ou_op' });
  assert.equal(result.ok, false);
  assert.equal(invalidated.length, 0, '验收没成功 ⇒ 不许失效（否则列表会白读一次飞书）');
});
