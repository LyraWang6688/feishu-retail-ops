/**
 * ⭐⭐ 「实时库存」**内存快照**的验收标准（业务负责人 2026-10-09 同意的两项优化之一）。
 *
 * 她的原话（要点）：「**首屏毫秒级，不再依赖 filter、也不会回退整表**」；
 * 前提是她要的「**库存准确**」——所以**任何写操作必须立刻失效**（不是等 30 秒）。
 *
 * 线上证据（服务器只读日志 + nginx access.log）：
 *   · `scan.page.cache_miss 08:30:19` → `scan.page.viewed 08:30:33` ⇒ **13.9 秒**；
 *   · 更早一次编号不存在（`3357|黑|B`：过滤读一条没读到 ⇒ **回退整表读「货品信息」**）
 *     25 秒还没回来，她在飞书 webview 里等成一张白页，nginx 记 **499**（她先关了）。
 *   ⇒ 每次扫码都要打飞书读「实时库存」，还随时可能掉进整表回退。
 *     快照把这**整张表**搬进内存（后台每 30 秒一拍），扫码时直接查内存。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-S1 快照就绪时**直接查内存**：扫码不再打任何「实时库存」的飞书读
 *        （`listAll` / `listByFilter` 一次都没有），而且**结果与过滤读逐字一致**
 *        （total / rows / missing_count / notes 全部 deepEqual）。
 *  AC-S2 快照**未就绪 / 过期** ⇒ 回退现有"按编号过滤读"，并记一条可 grep 的日志
 *        （`scan.snapshot.miss`，带 `reason`）——不静默、不改变结果。
 *  AC-S3 **写操作立刻失效**：`invalidateLiveInventorySnapshot()` 一调，快照当场作废
 *        （下一次扫码不再吃旧快照），并触发一次后台重拉。
 *  AC-S4 **全部配置化**：开关 / 刷新间隔 / 上限 / 过期阈值都在 `config/scanPage.js`；
 *        关掉开关时**一次整表读都不发生**；上限超了 ⇒ 快照不 ready（回退，不截断）。
 *  AC-S5 **只读 + 失败不炸**：刷新只调 `listAll`（写方法一碰就抛）；刷新抛错 ⇒ 记 warn、
 *        快照作废，扫码照常走回退并出结果（绝不因为快照坏了就打不开页面）。
 *  AC-S6 定时器**可启停**、且 `unref()`（不许把进程/h 测试吊住）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageService } = require('../src/services/scanPageService');
const {
  createLiveInventorySnapshot,
  invalidateLiveInventorySnapshot,
  registeredSnapshotCount,
} = require('../src/services/liveInventorySnapshot');

const NUMBER = 'YD6693-2|黑色|A';

const PRODUCT = {
  record_id: 'prod_1',
  fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' }, 类别: 'A', 品类: { text: '休闲鞋' }, 单价: 399 },
};
const SIZE_RECORDS = [
  { record_id: 'size_40', fields: { 尺码: 40, 类别: ['A'] } },
  { record_id: 'size_41', fields: { 尺码: 41, 类别: ['A'] } },
];
const inventoryRow = (id, sizeRecordId, state) => ({
  record_id: id,
  fields: {
    编号: ['prod_1'],
    尺码: [sizeRecordId],
    所属状态: state,
    库存键: `${NUMBER}|${String(sizeRecordId).replace('size_', '')}`,
    品类: '休闲鞋',
    更新时间: Date.UTC(2026, 9, 8, 12, 30),
  },
});
const INVENTORY = [
  inventoryRow('inv_40_box', 'size_40', '门盒'),
  inventoryRow('inv_41_sample', 'size_41', '样品'),
  inventoryRow('inv_40_wh', 'size_40', '仓库'),
];

/** 记账用的假网关：把每一次读都记下来（好断言"快照命中时一次「实时库存」读都没有"）。 */
const fakeGateway = ({ inventory = INVENTORY } = {}) => {
  const calls = [];
  const data = { product: [PRODUCT], liveInventory: inventory, sizeManagement: SIZE_RECORDS };
  const boom = (name) => async () => { throw new Error(`快照只读，不许写：${name}`); };
  return {
    calls,
    // 用例用它模拟"有人改了库存"（真的写入口在别的 service，本任务不碰）。
    setInventory: (next) => { data.liveInventory = next; },
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => { calls.push({ kind: 'listAll', tableKey: key }); return data[key] || []; },
    listByFilter: async (key) => { calls.push({ kind: 'listByFilter', tableKey: key }); return data[key] || []; },
    create: boom('create'),
    update: boom('update'),
    delete: boom('delete'),
    readsOf: (tableKey) => calls.filter((call) => call.tableKey === tableKey),
  };
};

/** 抓 info / warn 日志（`utils/logger` 的 info→console.log、warn→console.warn）。 */
const captureLogs = async (run) => {
  const entries = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (line) => { entries.push(JSON.parse(String(line))); };
  console.warn = (line) => { entries.push(JSON.parse(String(line))); };
  try {
    const value = await run();
    return { value, entries };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
};

const makeSnapshot = (gateway, overrides = {}, options = {}) => createLiveInventorySnapshot({
  gateway,
  config: { ...SCAN_PAGE.snapshot, ...overrides },
  limits: SCAN_PAGE.limits,
  ...options,
});

/**
 * ⚠️ 这一组用例必须**关掉扫码页那层 45 秒视图缓存**：它是"同一款连着扫"的兜底，
 *    会把第二次扫码直接吃掉 —— 那样就测不到"快照失效之后到底读没读"了。
 */
const CONFIG_NO_VIEW_CACHE = {
  ...SCAN_PAGE,
  cache: { ...SCAN_PAGE.cache, enabled: false, ttlMs: 0, maxEntries: 1 },
};

/** 手动把快照填好（不启定时器）——测的是"查内存"这一层。 */
const warmSnapshot = async (gateway, overrides = {}) => {
  const snapshot = makeSnapshot(gateway, overrides);
  await snapshot.refresh({ reason: 'test' });
  return snapshot;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-S1 命中快照：一次「实时库存」的飞书读都没有，结果逐字一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S1 快照就绪 ⇒ 扫码直接查内存（0 次飞书读），结果与过滤读逐字一致', async () => {
  const gateway = fakeGateway();
  const snapshot = await warmSnapshot(gateway);
  assert.equal(snapshot.get().ready, true, '刷新完就该就绪');
  assert.equal(snapshot.get().records.length, INVENTORY.length);

  const base = { product: gateway.readsOf('product').length, liveInventory: gateway.readsOf('liveInventory').length };
  const service = createScanPageService(gateway, {
    config: CONFIG_NO_VIEW_CACHE, snapshot, startSnapshot: false,
  });
  const timing = {};
  const view = await service.lookup({ number: NUMBER, requestId: 'req_s1', timing });

  assert.equal(gateway.readsOf('liveInventory').length, base.liveInventory,
    '命中快照后「实时库存」一次飞书读都不许打');
  assert.equal(timing.snapshot_hit, true, '耗时日志里要能看出这一趟吃的是快照');
  assert.equal(timing.whole_table_fallback, false, '吃快照既不是过滤读、更不是整表回退');

  // 与"没有快照、走过滤读"的结果逐字一致（只读语义一个字不改）
  const plainGateway = fakeGateway();
  const plain = createScanPageService(plainGateway, { config: CONFIG_NO_VIEW_CACHE, snapshot: false })
    .lookup({ number: NUMBER, requestId: 'req_s1b' });
  const plainView = await plain;
  assert.deepEqual(view.rows, plainView.rows, '库存表逐字一致');
  assert.deepEqual(view.columns, plainView.columns);
  assert.equal(view.total, plainView.total);
  assert.equal(view.missing_count, plainView.missing_count);
  assert.deepEqual(view.notes, plainView.notes);
  assert.equal(view.price_text, plainView.price_text);

  // 「库存真的为 0」与「filter 悄悄不生效」长得一样 ⇒ 快照命中时也不必再 warn（多出来的那条会误导）
  const { entries } = await captureLogs(async () => service.lookup({ number: NUMBER, requestId: 'req_s1c' }));
  assert.equal(entries.some((entry) => entry.event === 'scan.data.filtered_empty'), false,
    '吃快照跟 filter 没关系，别记 filter 的那条 warn');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S2 未就绪 / 过期 ⇒ 回退过滤读 + 记日志
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S2 快照未就绪 / 过期 ⇒ 回退"按编号过滤读"，并记一条带 reason 的日志', async () => {
  // ① 从来没刷过（进程刚起来 / 上一拍还没回来）
  const coldGateway = fakeGateway();
  const cold = createScanPageService(coldGateway, {
    config: CONFIG_NO_VIEW_CACHE, snapshot: makeSnapshot(coldGateway), startSnapshot: false,
  });
  const { value: coldView, entries: coldLogs } = await captureLogs(
    () => cold.lookup({ number: NUMBER, requestId: 'req_s2a' }),
  );
  assert.equal(coldView.found, true, '快照没就绪也必须照常出结果（回退过滤读）');
  assert.ok(coldGateway.readsOf('liveInventory').length > 0, '回退就是真的去读');
  const coldMiss = coldLogs.find((entry) => entry.event === 'scan.snapshot.miss');
  assert.ok(coldMiss, '未就绪必须记一条 scan.snapshot.miss（不静默）');
  assert.equal(coldMiss.reason, 'not_ready');

  // ② 过期（`maxAgeMs` 一过就不再吃旧数据）
  let clock = 1_000_000;
  const staleGateway = fakeGateway();
  const snapshot = createLiveInventorySnapshot({
    gateway: staleGateway,
    config: { ...SCAN_PAGE.snapshot, maxAgeMs: 5000 },
    limits: SCAN_PAGE.limits,
    now: () => clock,
  });
  await snapshot.refresh({ reason: 'test' });
  assert.equal(snapshot.get().ready, true);
  clock += 5001;
  assert.equal(snapshot.get().ready, false, '过了 maxAgeMs 就不 ready');
  assert.equal(snapshot.get().reason, 'stale');
  const stale = createScanPageService(staleGateway, {
    config: CONFIG_NO_VIEW_CACHE, snapshot, startSnapshot: false,
  });
  const { entries: staleLogs } = await captureLogs(() => stale.lookup({ number: NUMBER, requestId: 'req_s2b' }));
  const staleMiss = staleLogs.find((entry) => entry.event === 'scan.snapshot.miss');
  assert.ok(staleMiss && staleMiss.reason === 'stale', '过期要记 stale（看得出为什么没用快照）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S3 写操作立刻失效
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S3 写操作立刻失效：下一次扫码一定拿到最新库存，绝不吃旧快照', async () => {
  const gateway = fakeGateway();
  const snapshot = await warmSnapshot(gateway);
  const service = createScanPageService(gateway, {
    config: CONFIG_NO_VIEW_CACHE, snapshot, startSnapshot: false,
  });
  assert.equal((await service.lookup({ number: NUMBER, requestId: 'req_s3a' })).total, INVENTORY.length,
    '第一趟吃的是快照');
  assert.equal(snapshot.get().ready, true);

  // 有人真的改了库存（例：销售扣减 —— 这里直接把假网关的数据换掉），然后写入口调失效。
  gateway.setInventory([inventoryRow('inv_only', 'size_40', '门盒')]);
  const { entries } = await captureLogs(async () => {
    invalidateLiveInventorySnapshot('sale_submitted');
    // 失效是**同步**的：当场就不 ready（不等到下一拍 30 秒）
    assert.equal(snapshot.get().ready, false, '失效必须当场生效');
  });
  const invalidated = entries.find((entry) => entry.event === 'scan.snapshot.invalidated');
  assert.ok(invalidated, '失效要记一条日志（能对上"什么时候因为哪次写失效的"）');
  assert.equal(invalidated.reason, 'sale_submitted');

  const after = await service.lookup({ number: NUMBER, requestId: 'req_s3b' });
  assert.equal(after.total, 1, '这一趟拿到的一定是最新库存（不是快照里那份旧的）');
  // ⚠️ 2026-10-09：行的清单按**配置尺码段**补全（A 男 38–48）⇒ 第一行不再是 40，
  //    要按尺码找那一行。
  const row40 = after.rows.find((row) => row.size_text === '40');
  assert.ok(row40, '40 码那一行必须在');
  assert.equal(row40.cells[0].count, 1, '拿到的是最新那一双');
});

test('AC-S3 失效之后若还没重拉完：这一趟回退"按编号过滤读"并记 miss（不静默）', async () => {
  const gateway = fakeGateway();
  // 关掉"失效即重拉"（纯手动档）：这样"未就绪 ⇒ 回退"是确定的，不跟后台刷新抢时间。
  const snapshot = await warmSnapshot(gateway, { refreshOnInvalidate: false });
  const service = createScanPageService(gateway, {
    config: CONFIG_NO_VIEW_CACHE, snapshot, startSnapshot: false,
  });
  snapshot.invalidate('inventory_adjusted');
  const before = gateway.readsOf('liveInventory').length;
  const { value: view, entries } = await captureLogs(
    () => service.lookup({ number: NUMBER, requestId: 'req_s3c' }),
  );
  assert.equal(view.found, true);
  assert.ok(gateway.readsOf('liveInventory').length > before, '没快照就真的去读');
  const miss = entries.find((entry) => entry.event === 'scan.snapshot.miss');
  assert.ok(miss, '这一趟要记 miss（看得出为什么没用快照）');
  assert.equal(miss.reason, 'not_ready');
});

test('AC-S3 失效会触发一次后台重拉（不用等到下一拍 30 秒）', async () => {
  const gateway = fakeGateway();
  const snapshot = makeSnapshot(gateway);
  createScanPageService(gateway, { config: SCAN_PAGE, snapshot, startSnapshot: false });
  snapshot.invalidate('inventory_adjusted');
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(snapshot.get().ready, true, '失效后立刻重拉，下一趟扫码又能吃快照');
  assert.equal(gateway.readsOf('liveInventory').length, 1);
});

test('AC-S3 写入口调用点：扫码页写入成功后立刻失效（路由那一行）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage.js'), 'utf8');
  assert.match(source, /invalidateLiveInventorySnapshot\s*\(/, '扫码写入口必须调失效（本任务允许的那一行）');
  // 只在**写入成功之后**调：失败的那两处（respondWriteFailure）不许顺手失效（无谓的慢）
  const invalidationPoints = source.match(/invalidateLiveInventorySnapshot\s*\(([^)]*)\)/g) || [];
  assert.ok(invalidationPoints.length >= 1);
  for (const call of invalidationPoints) {
    assert.equal(/ok/.test(call), false, `失效调用要写清原因，别把 result.ok 塞进去：${call}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S4 全部配置化
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S4 配置化：开关 / 间隔 / 上限 / 过期阈值都在 config，关掉就一次整表读都不发生', async () => {
  // ① 配置项齐全（默认值就是她认可的口径：30 秒一拍）
  const snapshotConfig = SCAN_PAGE.snapshot;
  assert.equal(typeof snapshotConfig.enabled, 'boolean');
  assert.equal(snapshotConfig.refreshIntervalMs, 30000, '默认每 30 秒一拍');
  assert.ok(snapshotConfig.maxAgeMs >= snapshotConfig.refreshIntervalMs, '过期阈值不小于一拍');
  assert.ok(snapshotConfig.maxRecords > 0);
  // 环境变量名（换值不用改代码）
  for (const key of [
    'SCAN_PAGE_SNAPSHOT_ENABLED', 'SCAN_PAGE_SNAPSHOT_REFRESH_MS',
    'SCAN_PAGE_SNAPSHOT_MAX_AGE_MS', 'SCAN_PAGE_SNAPSHOT_MAX_RECORDS',
  ]) {
    const source = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'config', 'scanPage.js'), 'utf8',
    );
    assert.ok(source.includes(key), `配置项 ${key} 要能从环境变量读`);
  }

  // ② 关掉开关：连后台刷新都不起，一次「实时库存」整表读都没有
  const gateway = fakeGateway();
  const snapshot = makeSnapshot(gateway, { enabled: false });
  assert.equal(snapshot.enabled, false);
  snapshot.start();
  await snapshot.refresh({ reason: 'test' });
  assert.equal(gateway.readsOf('liveInventory').length, 0, '关掉就一次都不许读');
  assert.equal(snapshot.get().ready, false);
  assert.equal(snapshot.get().reason, 'disabled');
  const service = createScanPageService(gateway, {
    config: CONFIG_NO_VIEW_CACHE, snapshot, startSnapshot: false,
  });
  const timing = {};
  assert.equal((await service.lookup({ number: NUMBER, requestId: 'req_s4', timing })).found, true);
  assert.equal(timing.snapshot_hit, false, '关掉快照就是老路径');
  assert.ok(gateway.readsOf('liveInventory').length > 0, '老路径照常读（行为与提速后逐字一致）');

  // ③ 上限超了 ⇒ 不 ready（回退，绝不截断出一张错的库存表）
  const bigGateway = fakeGateway({
    inventory: Array.from({ length: 5 }, (_, index) => inventoryRow(`inv_${index}`, 'size_40', '门盒')),
  });
  const capped = makeSnapshot(bigGateway, { maxRecords: 3 });
  const result = await capped.refresh({ reason: 'test' });
  assert.equal(result.ok, false);
  assert.equal(capped.get().ready, false);
  assert.equal(capped.get().reason, 'limit_exceeded');

  // ④ 刷新间隔可配（定时器用这个值）
  const timers = [];
  const handle = { unref() {} };
  const ticked = makeSnapshot(fakeGateway(), { refreshIntervalMs: 1234 }, {
    setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return handle; },
    clearIntervalFn: () => {},
  });
  ticked.start();
  assert.equal(timers[0].ms, 1234, '定时器用的是配置里的间隔');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S5 只读 + 失败不炸
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S5 快照只读（写方法一碰就炸）；刷新失败 ⇒ 记 warn + 作废，扫码照常出结果', async () => {
  const gateway = fakeGateway();
  const snapshot = makeSnapshot(gateway);
  await snapshot.refresh({ reason: 'test' });
  assert.equal(snapshot.get().ready, true);
  // 刷新这一路不许碰任何写方法（假网关的写方法一碰就抛，能跑到这里就证明没碰）
  for (const method of ['create', 'update', 'delete']) assert.equal(typeof gateway[method], 'function');

  // 刷新失败：记 warn + 当场作废（宁可慢一次，也不给她看可能过期的库存）
  gateway.listAll = async () => { throw new Error('飞书 500'); };
  const { entries } = await captureLogs(() => snapshot.refresh({ reason: 'tick' }));
  const failed = entries.find((entry) => entry.event === 'scan.snapshot.refresh_failed');
  assert.ok(failed, '刷新失败必须记 warn（不静默）');
  assert.equal(failed.level, 'warn');
  assert.equal(snapshot.get().ready, false, '刷新失败 ⇒ 作废（下次扫码回退到真读）');

  // 回退照常出结果
  gateway.listAll = async (key) => ({ product: [PRODUCT], liveInventory: INVENTORY, sizeManagement: SIZE_RECORDS }[key] || []);
  const service = createScanPageService(gateway, {
    config: CONFIG_NO_VIEW_CACHE, snapshot, startSnapshot: false,
  });
  const view = await service.lookup({ number: NUMBER, requestId: 'req_s5' });
  assert.equal(view.found, true, '快照坏了也绝不打不开页面');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-S6 定时器可启停 + unref
// ═══════════════════════════════════════════════════════════════════════════

test('AC-S6 定时器可启停、unref（不许把进程吊住），且每一拍真的重拉整表', async () => {
  const gateway = fakeGateway();
  let unrefCalled = false;
  const timers = [];
  const cleared = [];
  const snapshot = makeSnapshot(gateway, {}, {
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms, unref: () => { unrefCalled = true; } };
      timers.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => { cleared.push(handle); },
  });

  snapshot.start();
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(unrefCalled, true, '必须 unref（不然测试/进程退不出去）');
  assert.equal(timers.length, 1, 'start 是幂等的（重复 start 不许起第二个定时器）');
  assert.equal(gateway.readsOf('liveInventory').length, 1, 'start 会立刻先拉一次（首屏不用等 30 秒）');
  assert.equal(snapshot.get().ready, true);

  snapshot.start();
  assert.equal(timers.length, 1, '重复 start 不叠定时器');

  // 每一拍 = 一次整表重拉
  await timers[0].fn();
  assert.equal(gateway.readsOf('liveInventory').length, 2);

  snapshot.stop();
  assert.deepEqual(cleared, [timers[0]], 'stop 要把定时器清掉');
  snapshot.stop();
  assert.equal(cleared.length, 1, '重复 stop 安全');
  assert.equal(snapshot.started, false);
});

test('AC-S6 快照模块能被跨模块失效（全局注册表），且实例各自独立', async () => {
  const before = registeredSnapshotCount();
  const gatewayA = fakeGateway();
  const gatewayB = fakeGateway();
  const a = await warmSnapshot(gatewayA);
  const b = await warmSnapshot(gatewayB);
  assert.equal(registeredSnapshotCount(), before + 2, '每个实例都注册进全局表（跨模块失效靠它）');
  assert.equal(a.get().ready, true);
  assert.equal(b.get().ready, true);
  invalidateLiveInventorySnapshot('inventory_adjusted');
  assert.equal(a.get().ready, false, '一次失效命中所有实例');
  assert.equal(b.get().ready, false);
});
