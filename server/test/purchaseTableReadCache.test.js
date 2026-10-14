'use strict';

/**
 * ⭐⭐ 2026-10-14（她真机：工作台「采购 → 验收」慢 + 偶发"采购申请读取失败"）
 *
 * 实测：`listPurchaseRequests` 一次 **8~11 秒** ✗（并发整表读 4 张表）。
 * 修法：给整表读加**短时缓存**（TTL 可配 ✓）。本文件钉住三件事：
 *
 *   AC-PR2 ⭐ 同一屏连续读 ⇒ **第二次明显快**（上游 `listAll` 不再重复打 ✓ 缓存真的命中 ✓）
 *   AC-PR3 ⭐ 缓存**不改变查询结果**（逐字一致 ✓）
 *   AC-PR4 ⭐ 缓存可**关掉**（`tableCacheTtlMs: 0` ⇒ 每次都真读 ✓ 排查用 ✓）
 *   AC-PR5 ⭐ 过期后**会重新读**（不许拿旧数据当永久 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');

/** 尺码关联的桩：本文件只关心"整表读了几次"，尺码解析一律当空处理 ✓（与既有用例同一形状） */
const SIZE_STUB = {
  resolveLinkedCell: async () => ({ size: 0, recordId: '' }),
  resolveByNumber: async () => ({ recordId: '', size: 0 }),
  resolveByName: async () => ({ recordId: '', size: 0 }),
  list: async () => [],
};

/** 一个假网关：数一数每张表被读了几次。 */
const fakeGateway = (calls) => ({
  listAll: async (tableKey) => {
    calls[tableKey] = (calls[tableKey] || 0) + 1;
    if (tableKey === 'purchaseRequest') {
      return [{ record_id: 'pr1', fields: {} }];
    }
    if (tableKey === 'behavior') {
      return [{ record_id: 'bh1', fields: {} }];
    }
    return [];
  },
});

test('AC-PR2 ⭐ 连续两次读 ⇒ 上游整表读**只发生一次**（缓存命中 ⇒ 第二次快）', async () => {
  const calls = {};
  const service = createPurchaseQueryService(fakeGateway(calls), { sizeReferences: SIZE_STUB, now: () => 1000 });
  await service.listPurchaseRequests({});
  const afterFirst = { ...calls };
  await service.listPurchaseRequests({});
  assert.deepEqual(calls, afterFirst, '第二次一个字都不许再打上游（这就是"快"的来源）');
  assert.equal(calls.purchaseRequest, 1, '采购申请表只读过 1 次');
});

test('AC-PR3 ⭐ 缓存不改变结果（逐字）', async () => {
  const service = createPurchaseQueryService(fakeGateway({}), { sizeReferences: SIZE_STUB, now: () => 1000 });
  const first = await service.listPurchaseRequests({});
  const second = await service.listPurchaseRequests({});
  assert.deepEqual(second, first, '两次结果逐字一致');
});

test('AC-PR4 ⭐ 可关掉（TTL=0 ⇒ 每次都真读，排查用）', async () => {
  const calls = {};
  const service = createPurchaseQueryService(fakeGateway(calls), { sizeReferences: SIZE_STUB, tableCacheTtlMs: 0, now: () => 1000 });
  await service.listPurchaseRequests({});
  await service.listPurchaseRequests({});
  assert.equal(calls.purchaseRequest, 2, '关掉缓存 ⇒ 每次都真读');
});

test('AC-PR5 ⭐ 过期后重新读（不许拿旧数据当永久）', async () => {
  const calls = {};
  let clock = 1000;
  const service = createPurchaseQueryService(fakeGateway(calls), { sizeReferences: SIZE_STUB, tableCacheTtlMs: 5000, now: () => clock });
  await service.listPurchaseRequests({});
  clock += 5001;
  await service.listPurchaseRequests({});
  assert.equal(calls.purchaseRequest, 2, '过了 TTL ⇒ 重新读');
});
