/**
 * ⭐⭐ 2026-10-12「**销售提交提速（第二刀）**」：网关新增 `getBatch`（飞书 `records/batch_get`）。
 *
 * 起因（业务负责人核过的事实）：网关原来只有**单条** `get` ⇒「已知 id ⇒ 精确读」
 *   = 1 次主表读 + N 次 `get`，比"1 次整表读"**调用更多** ⇒ 所以"按已知 id 精确读"这条
 *   优化**只有先有批量读才成立**（那一轮我判断"不做"，就是这个理由 ✓）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**）
 *   AC-GB1 `假网关断言请求的 id 集合**逐字**`（不许多传、不许少传、不许改顺序相关语义）
 *   AC-GB2 `分片边界：500 条 = 1 次请求 · 501 条 = 2 次（500 + 1）`
 *   AC-GB3 `空 ids / 全空串 ⇒ **零请求**，返回 []`
 *   AC-GB4 `部分 id 不存在 ⇒ 返回**实际存在的** + 日志如实报缺失数（**不编空记录**）`
 *   AC-GB5 `失败 ⇒ **抛错**（绝不静默返回空 —— 空会被当成"这单没有明细" ⇒ 重复建行 ✗）`
 *   AC-GB6 `options.correlation` 原样进日志（不透明传递，语义与其它方法一致）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { V1BitableGateway } = require('../src/services/v1BitableGateway');

const TABLE = 'salesDetail';
// ⚠️ 用例**自带最小 schema**（不读 env、不依赖真 Base 的 tableId）：
//    worktree 里没有 `.env`，而真 schema 缺 `FEISHU_V1_BITABLE_APP_TOKEN` 会当场报错。
const V1_BITABLE_SCHEMA = {
  appToken: 'app_test',
  tables: { [TABLE]: { tableName: '销售明细', tableId: 'tbl_test_sales_detail', fields: { salesEntry: '销售单号' } } },
};

/** 抓日志：`logInfo` 是**解构导入**的 ⇒ 必须在 gateway 模块加载前替换（清 require 缓存再 require）。 */
const withCapturedLogs = (run) => {
  const logger = require('../src/utils/logger');
  const original = logger.logInfo;
  const logs = [];
  logger.logInfo = (event, payload) => { logs.push({ event, payload }); };
  const modulePath = require.resolve('../src/services/v1BitableGateway');
  delete require.cache[modulePath];
  const { V1BitableGateway: Fresh } = require('../src/services/v1BitableGateway');
  try { return run(Fresh, logs, () => { logger.logInfo = original; delete require.cache[modulePath]; }); }
  finally { logger.logInfo = original; delete require.cache[modulePath]; }
};

/** 假飞书 client：记下每一次 batchGet 的入参，按"存在哪些 id"决定回什么。 */
const fakeClient = ({ existing = () => true, fail = null, forbidden = () => false } = {}) => {
  const calls = [];
  return {
    calls,
    bitable: {
      appTableRecord: {
        batchGet: async ({ path, data }) => {
          calls.push({ path, ids: (data?.record_ids || []).slice() });
          if (fail) throw fail;
          const ids = data?.record_ids || [];
          return {
            code: 0,
            data: {
              // ⚠️ 真飞书的口径：`forbidden_record_ids` 里的 id **不会**出现在 `records` 里。
              records: ids.filter((id) => existing(id) && !forbidden(id))
                .map((id) => ({ record_id: id, fields: { 编号: 'XHB1' } })),
              forbidden_record_ids: ids.filter((id) => forbidden(id)),
            },
          };
        },
      },
    },
  };
};

const gatewayFor = (client, options = {}) => new V1BitableGateway({
  client,
  schema: V1_BITABLE_SCHEMA,
  ...options,
});

test('AC-GB1 请求的 id 集合**逐字**（不许多、不许少、保持调用方给的顺序）', async () => {
  const client = fakeClient();
  const gateway = gatewayFor(client);
  const ids = ['rec_a', 'rec_b', 'rec_c'];
  const records = await gateway.getBatch(TABLE, ids);
  assert.equal(client.calls.length, 1, '三次以内的 id 只该有一次请求');
  assert.deepEqual(client.calls[0].ids, ids, '请求的 id 集合与顺序都要逐字一致');
  assert.equal(client.calls[0].path.table_id, V1_BITABLE_SCHEMA.tables[TABLE].tableId);
  assert.equal(records.length, 3);
  // 空串 / null 会被剔掉，但不影响别的 id
  const client2 = fakeClient();
  await gatewayFor(client2).getBatch(TABLE, ['rec_a', '', null, 'rec_b']);
  assert.deepEqual(client2.calls[0].ids, ['rec_a', 'rec_b'], '空值剔掉，剩下的原样');
});

test('AC-GB2 分片边界：500 条 = 1 次 · 501 条 = 2 次（500 + 1）', async () => {
  const ids500 = Array.from({ length: 500 }, (_, i) => `rec_${i}`);
  const client500 = fakeClient();
  await gatewayFor(client500).getBatch(TABLE, ids500);
  assert.equal(client500.calls.length, 1, '正好 500 ⇒ 一次请求');
  assert.equal(client500.calls[0].ids.length, 500);

  const ids501 = Array.from({ length: 501 }, (_, i) => `rec_${i}`);
  const client501 = fakeClient();
  const records = await gatewayFor(client501).getBatch(TABLE, ids501);
  assert.equal(client501.calls.length, 2, '501 ⇒ 必须分两片');
  assert.equal(client501.calls[0].ids.length, 500, '第一片 500');
  assert.equal(client501.calls[1].ids.length, 1, '第二片 1');
  assert.deepEqual(client501.calls[1].ids, ['rec_500'], '第二片是**剩下的**那一条');
  assert.equal(records.length, 501, '两片结果合起来一条不少');
});

test('AC-GB3 空 ids / 全空串 ⇒ **零请求**，返回 []', async () => {
  for (const empty of [[], undefined, null, '', ['', null, undefined, '  ']]) {
    const client = fakeClient();
    const records = await gatewayFor(client).getBatch(TABLE, empty);
    assert.deepEqual(records, [], `${JSON.stringify(empty)} ⇒ 空数组`);
    assert.equal(client.calls.length, 0, `${JSON.stringify(empty)} ⇒ 一个请求都不许发`);
  }
});

test('AC-GB4 部分 id 不存在 ⇒ 返回实际存在的 + 如实报缺失数（不编空记录）', async () => {
  const client = fakeClient({ existing: (id) => id !== 'rec_missing', forbidden: (id) => id === 'rec_forbidden' });
  await withCapturedLogs(async (Fresh, logs) => {
    const records = await new Fresh({ client, schema: V1_BITABLE_SCHEMA })
      .getBatch(TABLE, ['rec_ok', 'rec_missing', 'rec_forbidden']);
    assert.deepEqual(records.map((r) => r.record_id), ['rec_ok'], '只返回**实际存在的**那些（不补空记录）');
    const log = logs.find((item) => item.event === 'bitable.record.batch_read');
    assert.ok(log, '要有一条 batch_read 日志');
    assert.equal(log.payload.requested, 3);
    assert.equal(log.payload.returned, 1);
    assert.equal(log.payload.missing, 2, '缺 2 条要如实报');
    assert.equal(log.payload.forbidden, 1, '官方 forbidden 的条数照报');
  });
});

test('AC-GB5 失败 ⇒ **抛错**（绝不静默返回空）', async () => {
  const client = fakeClient({ fail: new Error('飞书 500') });
  await assert.rejects(() => gatewayFor(client).getBatch(TABLE, ['rec_a']),
    /批量读取|飞书 500/, '读失败必须抛出来，不许吞掉变空数组');
});

test('AC-GB6 `options.correlation` 原样进日志（不透明传递，不改请求内容）', async () => {
  const client = fakeClient();
  await withCapturedLogs(async (Fresh, logs) => {
    await new Fresh({ client, schema: V1_BITABLE_SCHEMA })
      .getBatch(TABLE, ['rec_a'], { correlation: { task_id: 't_1', batch_no: 'B-1' } });
    const log = logs.find((item) => item.event === 'bitable.record.batch_read');
    assert.equal(log.payload.task_id, 't_1', '关联键照旧进日志');
    assert.equal(log.payload.batch_no, 'B-1');
    assert.equal(JSON.stringify(client.calls[0]).includes('t_1'), false, '关联键不许进请求');
  });
});
