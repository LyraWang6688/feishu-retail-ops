/**
 * ⭐⭐ 2026-10-13「采购明细里出现过哪些尺码」只读小函数（docs/size-range-special-sizes-2026-10-13.md）
 * 口径：展示清单 = default ∪ **出现过的 special** ⇒ "出现过"这一读就是它的唯一来源 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchaseSizeReader, TABLE_KEY, sizeFieldName } = require('../src/services/purchaseSizeReader');

const SIZE_FIELD = sizeFieldName();

const fakeGateway = (records) => {
  const calls = { listAll: [] };
  return {
    calls,
    async listAll(tableKey) { calls.listAll.push(tableKey); return records; },
  };
};

// AC-1 ⭐ 只取「尺码」一列，去重且保序
test('AC-1 去重且保序：只取「尺码」列（其它列不读）· 同一个码出现多次只报一次', async () => {
  const gateway = fakeGateway([
    { record_id: 'r1', fields: { [SIZE_FIELD]: '38', 编号: 'A1', 数量: '2' } },
    { record_id: 'r2', fields: { [SIZE_FIELD]: '40' } },
    { record_id: 'r3', fields: { [SIZE_FIELD]: '38' } },
    { record_id: 'r4', fields: { [SIZE_FIELD]: '34' } },
    { record_id: 'r5', fields: { [SIZE_FIELD]: '40' } },
  ]);
  const reader = createPurchaseSizeReader({ gateway, cacheTtlMs: 0 });
  const sizes = await reader.listSizes();
  assert.deepEqual(sizes, ['38', '40', '34'], '去重且按**第一次出现的先后**保序 ✓');
  assert.deepEqual(gateway.calls.listAll, [TABLE_KEY], '只读这一张表（key = purchaseRequest）');
});

// AC-2 ⭐ TTL 命中 ⇒ 不再读表
test('AC-2 TTL 命中不再读表（listAll 只调一次）· 失效后重读 · ttl=0 每次都读', async () => {
  const gateway = fakeGateway([{ record_id: 'r1', fields: { [SIZE_FIELD]: '34' } }]);
  let t = 1000;
  const reader = createPurchaseSizeReader({ gateway, cacheTtlMs: 30000, now: () => t });
  await reader.listSizes();
  await reader.listSizes();
  assert.equal(gateway.calls.listAll.length, 1, 'TTL 内第二次命中缓存 ⇒ 不再读表 ✓');
  t += 30001; // 过期
  await reader.listSizes();
  assert.equal(gateway.calls.listAll.length, 2, '过期后重读 ✓');
  reader.invalidate();
  await reader.listSizes();
  assert.equal(gateway.calls.listAll.length, 3, '手动失效后重读 ✓');
  // ttl=0 ⇒ 不缓存
  const noCache = fakeGateway([{ record_id: 'r1', fields: { [SIZE_FIELD]: '34' } }]);
  const r2 = createPurchaseSizeReader({ gateway: noCache, cacheTtlMs: 0 });
  await r2.listSizes(); await r2.listSizes();
  assert.equal(noCache.calls.listAll.length, 2, 'ttl=0 ⇒ 每次都读 ✓');
});

// AC-3 ⭐⭐ 读表失败 ⇒ **抛出**（不吞、不给空清单）
test('AC-3 ⭐⭐ 读表失败 ⇒ 抛出（**不许**静默给空清单 ⇒ 否则就是"静默少码"）', async () => {
  const gateway = { async listAll() { throw new Error('飞书 500'); } };
  const reader = createPurchaseSizeReader({ gateway, cacheTtlMs: 0 });
  await assert.rejects(() => reader.listSizes(), /飞书 500/, '必须把错误抛给调用方（它要明确降级 + warn ✓）');
  // ⚠️ 反向哨兵：绝不返回 []（"读不到"与"表里真的没有码"**不是一回事**）
  const emptyReader = createPurchaseSizeReader({ gateway: fakeGateway([]), cacheTtlMs: 0 });
  assert.deepEqual(await emptyReader.listSizes(), [], '空表 ⇒ 空清单（不崩 ✓）');
});

// AC-4 空表 / 空值 / 数组值 / 脏数据
test('AC-4 空表 ⇒ 空清单（不崩）· 空值跳过 · 数组值展开 · 前后空格去掉', async () => {
  const gateway = fakeGateway([
    { record_id: 'r1', fields: {} },
    { record_id: 'r2', fields: { [SIZE_FIELD]: '' } },
    { record_id: 'r3', fields: { [SIZE_FIELD]: null } },
    { record_id: 'r4', fields: { [SIZE_FIELD]: ' 38 ' } },
    { record_id: 'r5', fields: { [SIZE_FIELD]: ['40', ' 41 ', ''] } },
  ]);
  const reader = createPurchaseSizeReader({ gateway, cacheTtlMs: 0 });
  assert.deepEqual(await reader.listSizes(), ['38', '40', '41'], '空值跳过、数组展开、trim ✓');
  const empty = createPurchaseSizeReader({ gateway: fakeGateway([]), cacheTtlMs: 0 });
  assert.deepEqual(await empty.listSizes(), [], '空表不崩 ✓');
});

// AC-5 可注入（单测/接线方替换）· 注入时完全不读表
test('AC-5 options.listSizes 可注入 ⇒ 完全不读表（单测与接线方都能换掉）', async () => {
  const gateway = fakeGateway([{ record_id: 'r1', fields: { [SIZE_FIELD]: '99' } }]);
  const reader = createPurchaseSizeReader({ gateway, listSizes: async () => ['34', '43'] });
  assert.deepEqual(await reader.listSizes(), ['34', '43'], '注入优先 ✓');
  assert.deepEqual(gateway.calls.listAll, [], '注入时一次表都不读 ✓');
});
