'use strict';

/**
 * ⭐⭐ task-65 ①（2026-10-16 · Lead 当场授权）：网关新增 **`deleteBatch`**
 *   （飞书 `appTableRecord.batchDelete` ⇒
 *    `POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_delete`）。
 *
 * 起因（真账）：采购退货扣库存那一段原来**每一双**一次 `delete`
 *   （单货品 3 双 = 3 次、多货品 6 双 = 6 次）⇒ 批量之后整批 **1 次**。
 *   官方（curl 核过，《删除多条记录》）：请求体 `{ records: string[] }`，
 *   **「单次调用中最多删除 500 条记录」**，频率限制 50 次/秒；
 *   响应 `data.records = [{ deleted, record_id }]`。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *   BD-1 逐字请求体：5 条 ⇒ **1 次**请求；`data.records` = 调用方给的那串 id（**同序、不多不少**）；
 *        返回与入参**同序**的 `[{ recordId, deleted }]`
 *   BD-2 ⭐ 空数组 / 全空串 ⇒ **零请求**（不是"打一次空请求"；空串被过滤掉）
 *   BD-3 ⭐ 分片：501 条 ⇒ 2 次（**500 + 1**；与 `createBatch` / `getBatch` 同一把尺子）
 *   BD-4 失败 ⇒ **抛错**（绝不静默返回半截）+ 记 `bitable.record.batch_delete_failed`；
 *        飞书结构化拒绝（`code != 0`）⇒ 错误上带 `bitableRejected`（语义：明确拒绝 ⇒ 确定没写入）
 *   BD-5 条数对不上 ⇒ **先**记 `bitable.record.batch_write_mismatch`
 *        （requested / returned / missing / operation:'delete'）**再抛**
 *   BD-6 ⭐ 官方明说某几条 `deleted:false` ⇒ **抛**（绝不把"部分成功"当全成功），
 *        且错误上如实带 `bitablePartialDelete` / `bitableDeletedRecordIds`
 *        —— **只含明说 `deleted:true` 的那些**（宁可少记，也绝不把"可能没删"记成"已删"）
 *   BD-7 `correlation` **不透明**：只进日志，**不进 payload**（请求体形状一个字节不许变）
 *   BD-8 🔴 **只加能力**：请求体是**纯 id 列表**（没有 fields）；单条 `delete` 一字没动
 *        （既有调用方行为逐字不变）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TABLE = 'liveInventory';
const TABLE_ID = 'tbl_batch_delete_test';
// ⚠️ 用例**自带最小 schema**（不读 env、不依赖真 Base 的 tableId）：
//    worktree 里没有 `.env`，而真 schema 缺 `FEISHU_V1_BITABLE_APP_TOKEN` 会当场报错。
const schema = {
  appToken: 'app_batch_delete_test',
  tables: {
    [TABLE]: { tableName: '实时库存', tableId: TABLE_ID, fields: { product: '编号', size: '尺码' } },
  },
};

/**
 * 抓日志：网关是**解构导入** `logInfo/logWarn/logError` 的 ⇒ 必须在它加载前替换，
 * 并清 require 缓存再 require（否则抓到的是旧引用）。
 */
const withCapturedLogs = async (run) => {
  const logs = [];
  const stop = require('../src/utils/logger').addLogListener(({ level, event, ...payload }) => {
    logs.push({ level, event, payload });
  });
  const { V1BitableGateway: Fresh } = require('../src/services/v1BitableGateway');
  try { return await run(Fresh, logs); } finally { stop(); }
};

/**
 * 假飞书 client：记下每一次 `batchDelete` 的入参，按 `respond` 决定回什么。
 * 默认照真飞书口径回 `{ code:0, data:{ records:[{deleted:true, record_id}] } }`。
 */
const fakeClient = (options = {}) => {
  const calls = [];
  return {
    calls,
    bitable: {
      appTableRecord: {
        batchDelete: async (payload) => {
          calls.push(payload);
          if (options.throwOnce && calls.length === options.throwOnce) throw new Error('socket hang up');
          if (options.fail) return { code: options.fail, msg: 'no permission' };
          const ids = payload?.data?.records || [];
          if (options.respond) return options.respond(ids, calls.length);
          return { code: 0, data: { records: ids.map((id) => ({ deleted: true, record_id: id })) } };
        },
        // 单条 delete 也留一个（BD-8 用它钉"既有调用方行为逐字不变"）
        delete: async (payload) => {
          calls.push(payload);
          return { code: 0, data: { deleted: true, record_id: payload?.path?.record_id } };
        },
      },
    },
  };
};

const gatewayFor = (client) => {
  const { V1BitableGateway } = require('../src/services/v1BitableGateway');
  return new V1BitableGateway({ client, schema });
};

test('BD-1 逐字请求体：5 条 ⇒ 1 次请求；id 同序、不多不少；返回同序', async () => {
  await withCapturedLogs(async (Fresh, logs) => {
    const client = fakeClient();
    const gateway = new Fresh({ client, schema });
    const ids = ['rec_a', 'rec_b', 'rec_c', 'rec_d', 'rec_e'];
    const deleted = await gateway.deleteBatch(TABLE, ids);

    assert.equal(client.calls.length, 1, '5 条必须只打一次飞书（这就是批量的全部意义）');
    assert.equal(client.calls[0].path.table_id, TABLE_ID);
    assert.equal(client.calls[0].path.app_token, 'app_batch_delete_test');
    assert.deepEqual(client.calls[0].data, { records: ids },
      '请求体逐字：只有 records，且 id 同序、不多不少');
    assert.deepEqual(deleted, ids.map((recordId) => ({ recordId, deleted: true })),
      '返回与入参同序（调用方按位置对账）');
    assert.ok(logs.some((item) => item.event === 'bitable.record.batch_deleted'
      && item.payload.count === 5), '成功要有 batch_deleted 日志');
  });
});

test('BD-2 ⭐ 空数组 / 全空串 ⇒ **零请求**；空串被过滤掉', async () => {
  await withCapturedLogs(async (Fresh) => {
    const client = fakeClient();
    const gateway = new Fresh({ client, schema });
    assert.deepEqual(await gateway.deleteBatch(TABLE, []), []);
    assert.deepEqual(await gateway.deleteBatch(TABLE, ['', '  ', null, undefined]), []);
    assert.deepEqual(await gateway.deleteBatch(TABLE), []);
    assert.equal(client.calls.length, 0, '一次飞书都不许打');
  });
});

test('BD-3 ⭐ 分片：501 条 ⇒ 2 次（500 + 1，与 createBatch / getBatch 同一把尺子）', async () => {
  await withCapturedLogs(async (Fresh) => {
    const client = fakeClient();
    const gateway = new Fresh({ client, schema });
    const ids = Array.from({ length: 501 }, (_, index) => `rec_${index}`);
    const deleted = await gateway.deleteBatch(TABLE, ids);
    assert.equal(client.calls.length, 2, '501 条 = 两次请求');
    assert.equal(client.calls[0].data.records.length, 500, '第一片 500');
    assert.equal(client.calls[1].data.records.length, 1, '第二片 1');
    assert.deepEqual(client.calls[0].data.records, ids.slice(0, 500), '顺序不许打乱');
    assert.deepEqual(client.calls[1].data.records, ids.slice(500));
    assert.deepEqual(deleted.map((item) => item.recordId), ids, '返回整体同序');
  });
});

test('BD-4 失败 ⇒ 抛错（绝不静默返回半截）+ batch_delete_failed；明确拒绝带 bitableRejected', async () => {
  await withCapturedLogs(async (Fresh, logs) => {
    const client = fakeClient({ fail: 99991672 });
    const gateway = new Fresh({ client, schema });
    await assert.rejects(() => gateway.deleteBatch(TABLE, ['rec_a', 'rec_b']),
      (error) => {
        assert.match(error.message, /删除“实时库存”记录失败/);
        assert.equal(error.bitableRejected, true,
          '飞书结构化拒绝 ⇒ 确定没写入（幂等判据靠这一位区分"明确失败"与"结果未知"）');
        assert.equal(error.bitableCode, 99991672);
        return true;
      });
    const failed = logs.find((item) => item.event === 'bitable.record.batch_delete_failed');
    assert.ok(failed, '失败要有 batch_delete_failed 日志');
    assert.equal(failed.payload.count, 2);
    assert.equal(failed.payload.table_key, TABLE);
  });
});

test('BD-5 条数对不上 ⇒ **先**记 requested/returned/missing 再抛', async () => {
  await withCapturedLogs(async (Fresh, logs) => {
    // 少回一条（官方"部分成功"的另一种形状）
    const client = fakeClient({ respond: () => ({ code: 0, data: { records: [{ deleted: true, record_id: 'rec_a' }] } }) });
    const gateway = new Fresh({ client, schema });
    await assert.rejects(() => gateway.deleteBatch(TABLE, ['rec_a', 'rec_b']),
      /batch_delete_count_mismatch: expected 2, got 1/);
    const mismatch = logs.find((item) => item.event === 'bitable.record.batch_write_mismatch');
    assert.ok(mismatch, '要先记 batch_write_mismatch');
    assert.equal(mismatch.payload.operation, 'delete');
    assert.equal(mismatch.payload.requested, 2);
    assert.equal(mismatch.payload.returned, 1);
    assert.equal(mismatch.payload.missing, 1);
    assert.equal(mismatch.payload.not_deleted, 0);
  });
});

test('BD-6 ⭐ 明说 deleted:false ⇒ 抛 + 如实带"官方回报的那一份"（只含 deleted:true）', async () => {
  await withCapturedLogs(async (Fresh, logs) => {
    const client = fakeClient({
      respond: () => ({
        code: 0,
        data: {
          records: [
            { deleted: true, record_id: 'rec_a' },
            { deleted: false, record_id: 'rec_b' },
            { deleted: true, record_id: 'rec_c' },
          ],
        },
      }),
    });
    const gateway = new Fresh({ client, schema });
    await assert.rejects(() => gateway.deleteBatch(TABLE, ['rec_a', 'rec_b', 'rec_c']),
      (error) => {
        assert.match(error.message, /batch_delete_count_mismatch: expected 3, got 3, not_deleted 1/);
        assert.equal(error.bitablePartialDelete, true, '要标出这是"部分删除"');
        assert.deepEqual(error.bitableDeletedRecordIds, ['rec_a', 'rec_c'],
          '只认明说 deleted:true 的（宁可少记 ⇒ 续跑会停下要人工核对；绝不把"可能没删"记成"已删"）');
        // 🔴 部分删除**不成立** `bitableRejected` 的语义（那是"明确拒绝 ⇒ 确定没写入"）
        assert.equal(error.bitableRejected, undefined);
        return true;
      });
    const mismatch = logs.find((item) => item.event === 'bitable.record.batch_write_mismatch');
    assert.equal(mismatch.payload.not_deleted, 1);
    assert.equal(mismatch.payload.missing, 0, '三条都回了 ⇒ 缺 0');
  });
});

test('BD-7 correlation **不透明**：只进日志，不进 payload（请求体形状一个字节不变）', async () => {
  await withCapturedLogs(async (Fresh, logs) => {
    const client = fakeClient();
    const gateway = new Fresh({ client, schema });
    await gateway.deleteBatch(TABLE, ['rec_a'], { correlation: { task_id: 't1', batch_no: 'CGD-1' } });
    assert.deepEqual(client.calls[0].data, { records: ['rec_a'] }, '请求体里不许出现业务键');
    assert.deepEqual(Object.keys(client.calls[0]).sort(), ['data', 'path'], '只许 path + data');
    const log = logs.find((item) => item.event === 'bitable.record.batch_deleted');
    assert.equal(log.payload.task_id, 't1', 'correlation 要进日志');
    assert.equal(log.payload.batch_no, 'CGD-1');
  });
});

test('BD-8 🔴 只加能力：请求体是纯 id 列表；单条 delete 一字没动（既有调用方逐字不变）', async () => {
  // ① 行为：单条 `delete` 仍旧只调 `appTableRecord.delete`，请求体形状与以前逐字相同。
  const client = fakeClient();
  const gateway = gatewayFor(client);
  assert.equal(await gateway.delete(TABLE, 'rec_a'), true, '单条 delete 的返回值照旧是 true');
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path.record_id, 'rec_a', '单条 delete 走的是 path.record_id');
  assert.equal(client.calls[0].data, undefined, '单条 delete 没有 body（与改动前逐字相同）');
  // ② 批量口：请求体只有 id 列表（没有 fields / 没有 values）
  const batchClient = fakeClient();
  const batchGateway = gatewayFor(batchClient);
  await batchGateway.deleteBatch(TABLE, ['rec_a', 'rec_b']);
  assert.deepEqual(Object.keys(batchClient.calls[0].data), ['records']);
  assert.equal(typeof batchClient.calls[0].data.records[0], 'string', '数组元素是 id 字符串');
  // ③ 源码哨兵：`deleteBatch` 用官方 `batchDelete`；单条 `delete` 那三行原样在
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'v1BitableGateway.js'), 'utf8');
  assert.match(source, /appTableRecord\.batchDelete\(\{/);
  assert.match(source, /async delete\(tableKey, recordId\) \{\n    const table = this\.tableWithId\(tableKey\);\n    const response = await this\.client\.bitable\.appTableRecord\.delete\(\{/,
    '单条 delete 必须原样（本卡只加能力，不改任何既有调用）');
});
