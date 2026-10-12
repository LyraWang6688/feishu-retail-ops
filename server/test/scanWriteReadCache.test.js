/**
 * ⭐⭐ **只读引用缓存**的验收标准（2026-10-12，(b) 提交链路提速的"安全那一半"）。
 *
 * 背景：线上量级实测，一趟"提交这一单"会打 **41 次飞书调用**，其中**同一次提交里**
 * 反复读同一张只读引用表（`尺码管理` ×3、`行为管理` ×2、`货品信息` ×1+1…）。
 * 提速手段是"同键在飞去重 + 短 TTL"，**但绝不能碰写入判据**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-RC1 同一张**白名单**表在同一 TTL 内读 N 次 ⇒ 只真的打 1 次（同一次提交里的重复读被吃掉）。
 *  AC-RC2 **白名单之外**的表一律直通（`salesEntry` / `salesDetail` / `paymentRecord` /
 *         `liveInventory` 每次都真打）—— 幂等回查 / 单号分配 / 库存判据**碰不到缓存**。
 *  AC-RC3 **写方法原样透传**（create / update / delete 连包都不包），且每次真打。
 *  AC-RC4 **同键并发只飞一趟**（她连点 14 次那种并发打同一张表）。
 *  AC-RC5 关掉它的两条路都是**显式**的：`enabled:false` / `ttlMs:0` / 空 `tables` ⇒ 原样返回传入的网关；
 *         TTL 过期后**重新读**（不会拿着过期数据不放）。
 *  AC-RC6 命中缓存返回的数组是**浅拷贝**：调用方 `sort` / `splice` 弄不脏缓存那一份。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createReadOnlyReferenceCache } = require('../src/services/scanWriteService');
const { READ_CACHE } = require('../src/config/scanWrite');

const POLICY = { enabled: true, ttlMs: 5000, tables: ['sizeManagement', 'product', 'behavior', 'paymentMethod'] };

/** 记账用的假网关：每一次**真打**都记一笔。 */
const makeGateway = () => {
  const calls = [];
  const data = {
    sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
    product: [{ record_id: 'prod_1', fields: { 编号: 'YD6693-2|黑色|A' } }],
    salesEntry: [{ record_id: 'se_1', fields: {} }],
    liveInventory: [{ record_id: 'inv_1', fields: {} }],
  };
  return {
    calls,
    table: (key) => ({ tableName: key, fields: {} }),
    listAll: async (key) => { calls.push(['listAll', key]); return [...(data[key] || [])]; },
    get: async (key, id) => { calls.push(['get', key, id]); return (data[key] || []).find((r) => r.record_id === id) || null; },
    listByFilter: async (key) => { calls.push(['listByFilter', key]); return [...(data[key] || [])]; },
    findOneByText: async (key, field, value) => {
      calls.push(['findOneByText', key]);
      return (data[key] || []).find((r) => String(r.fields?.[field] ?? '') === String(value)) || null;
    },
    create: async (key) => { calls.push(['create', key]); return { recordId: `${key}_new` }; },
    update: async (key, id) => { calls.push(['update', key, id]); return { record_id: id }; },
    delete: async (key, id) => { calls.push(['delete', key, id]); return { deleted: true }; },
    countOf: (name, key) => calls.filter((c) => c[0] === name && (key === undefined || c[1] === key)).length,
  };
};

test('AC-RC1 白名单表在同一 TTL 内读 3 次 ⇒ 只真打 1 次（同一次提交里的重复读被吃掉）', async () => {
  const gateway = makeGateway();
  const cached = createReadOnlyReferenceCache(gateway, POLICY);
  const first = await cached.listAll('sizeManagement');
  await cached.listAll('sizeManagement');
  await cached.listAll('sizeManagement');
  assert.equal(gateway.countOf('listAll', 'sizeManagement'), 1, '尺码管理在同一 TTL 内只该真打 1 次');
  assert.equal(first.length, 1, '拿到的仍然是那份数据');
  // 不同表各自算各自的键。
  await cached.listAll('behavior');
  await cached.listAll('behavior');
  assert.equal(gateway.countOf('listAll', 'behavior'), 1);
  // 不同方法各自算各自的键（get 与 listAll 不能互相冒充）。
  await cached.get('product', 'prod_1');
  await cached.get('product', 'prod_1');
  await cached.listAll('product');
  assert.equal(gateway.countOf('get', 'product'), 1);
  assert.equal(gateway.countOf('listAll', 'product'), 1);
});

test('AC-RC2 白名单之外的表一律直通（幂等 / 单号 / 库存判据碰不到缓存）', async () => {
  const gateway = makeGateway();
  const cached = createReadOnlyReferenceCache(gateway, POLICY);
  for (const table of ['salesEntry', 'salesDetail', 'paymentRecord', 'liveInventory', 'inventoryLedger']) {
    await cached.listAll(table);
    await cached.listAll(table);
    assert.equal(gateway.countOf('listAll', table), 2, `${table} 不在白名单里 ⇒ 每次都必须真打`);
  }
  // 白名单**只有**只读引用表（配置本身就是这条红线的落点）。
  for (const forbidden of ['salesEntry', 'salesDetail', 'paymentRecord', 'liveInventory', 'inventoryLedger']) {
    assert.equal(READ_CACHE.tables.includes(forbidden), false, `只读缓存白名单里不许出现 ${forbidden}`);
  }
});

test('AC-RC3 写方法原样透传（create / update / delete 连包都不包）', async () => {
  const gateway = makeGateway();
  const cached = createReadOnlyReferenceCache(gateway, POLICY);
  await cached.create('salesEntry', {});
  await cached.create('salesEntry', {});
  await cached.update('salesEntry', 'se_1', {});
  await cached.update('salesEntry', 'se_1', {});
  await cached.delete('liveInventory', 'inv_1');
  assert.equal(gateway.countOf('create', 'salesEntry'), 2, '写入永远不许被缓存');
  assert.equal(gateway.countOf('update', 'salesEntry'), 2, '更新永远不许被缓存');
  assert.equal(gateway.countOf('delete', 'liveInventory'), 1);
  assert.equal(cached.create, gateway.create, '写方法就是原方法本身（没有第二层包装）');
  assert.equal(cached.update, gateway.update);
  assert.equal(cached.delete, gateway.delete);
});

test('AC-RC4 同键**并发**只飞一趟（她连点 14 次那种并发打同一张表）', async () => {
  const gateway = makeGateway();
  const cached = createReadOnlyReferenceCache(gateway, POLICY);
  const results = await Promise.all(Array.from({ length: 14 }, () => cached.listAll('sizeManagement')));
  assert.equal(gateway.countOf('listAll', 'sizeManagement'), 1, '14 个并发请求只该有 1 趟真的去读');
  assert.equal(results.length, 14);
  for (const result of results) assert.equal(result.length, 1, '每一个调用方都要拿到数据（不是 undefined）');
});

test('AC-RC5 关掉它只有**显式**两条路；TTL 过期后重新读', async () => {
  const gateway = makeGateway();
  // ① 显式关闭 / TTL 为 0 / 白名单为空 ⇒ 原样返回传入的网关（形同没装）。
  assert.equal(createReadOnlyReferenceCache(gateway, { enabled: false, ttlMs: 5000, tables: ['product'] }), gateway);
  assert.equal(createReadOnlyReferenceCache(gateway, { enabled: true, ttlMs: 0, tables: ['product'] }), gateway);
  assert.equal(createReadOnlyReferenceCache(gateway, { enabled: true, ttlMs: 5000, tables: [] }), gateway);
  assert.equal(createReadOnlyReferenceCache(gateway, undefined), gateway);
  // ② TTL 过期 ⇒ 重新读（不会拿着过期数据不放）。
  let clock = 0;
  const cached = createReadOnlyReferenceCache(gateway, { enabled: true, ttlMs: 100, tables: ['product'] }, () => clock);
  await cached.listAll('product');
  clock = 50;
  await cached.listAll('product');
  assert.equal(gateway.countOf('listAll', 'product'), 1, 'TTL 内命中');
  clock = 101;
  await cached.listAll('product');
  assert.equal(gateway.countOf('listAll', 'product'), 2, 'TTL 过期后必须重新读');
});

test('AC-RC6 命中缓存返回的是**浅拷贝**：调用方 sort / splice 弄不脏缓存那一份', async () => {
  const gateway = makeGateway();
  const cached = createReadOnlyReferenceCache(gateway, POLICY);
  const first = await cached.listAll('sizeManagement');
  first.push({ record_id: 'poison' });
  first.length = 0;
  const second = await cached.listAll('sizeManagement');
  assert.equal(second.length, 1, '缓存里那一份不许被上一个调用方改坏');
  assert.equal(second[0].record_id, 'size_40');
});
