'use strict';

/**
 * ⭐⭐ 2026-10-12（验收提速）——**网关批量写**的验收标准。
 *
 * 为什么先钉它：她真机每批 5 码，逐码"库存 + 流水"要串行敲 10+ 次飞书（每次约 10 秒）
 * ⇒ 单这一刀 119.5 秒（占整批 143.9 秒的 83%）。批量之后 **5 行一次** ⇒ 10 次变 2 次。
 *
 * 这一批 AC 钉的是"**批量能力本身**"（③ 把验收路径接上去之后，调用次数对照在那边再报）：
 *   AC-1 `createBatch` 5 条 ⇒ **1 次**飞书请求；返回与入参**同序**的 5 个 recordId
 *   AC-2 ⭐ **空数组 ⇒ 零请求**（一次飞书都不打）
 *   AC-3 分片：501 条 ⇒ 2 次（≤500/次，与 `getBatch` 同一把尺子）
 *   AC-4 失败 ⇒ **抛错**（不静默、不返回半截）+ 记 `bitable.record.batch_create_failed`
 *   AC-5 `updateBatch` 同语义（5 条 1 次 / 空 0 次 / 失败抛错）
 *   AC-6 `correlation` **不透明**：只进日志，**不进 payload**（payload 形状一个字节不许变）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');

const schema = {
  appToken: 'app_v1',
  tables: {
    sample: { tableName: '测试表', tableId: 'tbl_sample', fields: { name: '名称', quantity: '数量' } },
  },
};

const makeClient = () => {
  const calls = { batchCreate: [], batchUpdate: [] };
  const ok = (records) => ({ code: 0, data: { records } });
  const client = {
    bitable: {
      appTableRecord: {
        batchCreate: async (payload) => {
          calls.batchCreate.push(payload);
          return ok(payload.data.records.map((row, index) => ({
            record_id: `rec_${(calls.batchCreate.length - 1) * 500 + index}`, fields: row.fields,
          })));
        },
        batchUpdate: async (payload) => {
          calls.batchUpdate.push(payload);
          return ok(payload.data.records.map((row) => ({ record_id: row.record_id, fields: row.fields })));
        },
      },
    },
  };
  return { client, calls };
};

const rows = (n) => Array.from({ length: n }, (_, i) => ({ name: `A${i}`, quantity: i }));

test('AC-1 createBatch：5 条 ⇒ **1 次**请求，返回与入参同序的 5 个 recordId', async () => {
  const { client, calls } = makeClient();
  const gateway = new V1BitableGateway({ schema, client });
  const created = await gateway.createBatch('sample', rows(5));
  assert.equal(calls.batchCreate.length, 1, '5 条必须只打一次飞书（这就是提速的全部意义）');
  assert.equal(calls.batchCreate[0].data.records.length, 5);
  assert.deepEqual(created.map((item) => item.recordId),
    ['rec_0', 'rec_1', 'rec_2', 'rec_3', 'rec_4'], '返回顺序必须与入参一一对应');
  assert.deepEqual(calls.batchCreate[0].data.records[0].fields, { 名称: 'A0', 数量: 0 },
    '语义键照样映射成中文列名');
});

test('AC-2 ⭐ 空数组 ⇒ **零请求**（不是"打一次空请求"）', async () => {
  const { client, calls } = makeClient();
  const gateway = new V1BitableGateway({ schema, client });
  assert.deepEqual(await gateway.createBatch('sample', []), []);
  assert.deepEqual(await gateway.updateBatch('sample', []), []);
  assert.equal(calls.batchCreate.length + calls.batchUpdate.length, 0, '一次飞书都不许打');
});

test('AC-3 分片：501 条 ⇒ 2 次（每次 ≤500，与 getBatch 同一把尺子）', async () => {
  const { client, calls } = makeClient();
  const gateway = new V1BitableGateway({ schema, client });
  const created = await gateway.createBatch('sample', rows(501));
  assert.equal(calls.batchCreate.length, 2);
  assert.deepEqual(calls.batchCreate.map((call) => call.data.records.length), [500, 1]);
  assert.equal(created.length, 501);
});

test('AC-4 失败 ⇒ **抛错**（不静默、不返回半截）；条数对不上 ⇒ 先记 requested/returned/missing 再抛', async () => {
  const client = {
    bitable: { appTableRecord: { batchCreate: async () => ({ code: 1254066, msg: 'UserFieldConvFail' }) } },
  };
  const gateway = new V1BitableGateway({ schema, client });
  await assert.rejects(() => gateway.createBatch('sample', rows(5)), /新增“测试表”记录/);

  // ⭐ 飞书回 0 但**少给了几条** ⇒ 先 warn（三个数）再抛（写库不许半截当成功）
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    const short = {
      bitable: { appTableRecord: { batchCreate: async () => ({ code: 0, data: { records: [{ record_id: 'rec_0' }] } }) } },
    };
    let thrown = null;
    try { await new V1BitableGateway({ schema, client: short }).createBatch('sample', rows(5)); }
    catch (error) { thrown = error; }
    assert.ok(thrown, '条数对不上必须抛错（不许半截当成功）');
    assert.match(thrown.message, /batch_create_count_mismatch: expected 5, got 1/, `实际：${thrown.message}`);
  } finally { console.warn = original; }
  const logged = warnings.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const mismatch = logged.find((item) => item.event === 'bitable.record.batch_write_mismatch');
  assert.ok(mismatch, `必须记一条 batch_write_mismatch：${warnings.join(' | ')}`);
  assert.deepEqual(
    { requested: mismatch.requested, returned: mismatch.returned, missing: mismatch.missing },
    { requested: 5, returned: 1, missing: 4 }, '三个数照 getBatch 的口径如实记');
});

test('AC-5 updateBatch：同语义（5 条 1 次 · 空 0 次 · 失败抛错）', async () => {
  const { client, calls } = makeClient();
  const gateway = new V1BitableGateway({ schema, client });
  const patches = Array.from({ length: 5 }, (_, i) => ({ recordId: `rec_${i}`, values: { quantity: i } }));
  const updated = await gateway.updateBatch('sample', patches);
  assert.equal(calls.batchUpdate.length, 1, '5 条一次');
  assert.equal(calls.batchUpdate[0].data.records.length, 5);
  assert.deepEqual(calls.batchUpdate[0].data.records[0], { record_id: 'rec_0', fields: { 数量: 0 } });
  assert.equal(updated.length, 5);
  const bad = { bitable: { appTableRecord: { batchUpdate: async () => ({ code: 99991672, msg: 'no perm' }) } } };
  await assert.rejects(() => new V1BitableGateway({ schema, client: bad })
    .updateBatch('sample', patches), /更新“测试表”记录/);
});

test('AC-6 correlation **不透明**：只进日志，不进 payload（形状一个字节不变）', async () => {
  const { client, calls } = makeClient();
  const gateway = new V1BitableGateway({ schema, client });
  await gateway.createBatch('sample', rows(1), { correlation: { task_id: 't1', batch_no: 'B1' } });
  await gateway.updateBatch('sample', [{ recordId: 'rec_0', values: { quantity: 1 } }],
    { correlation: { task_id: 't1' } });
  assert.deepEqual(Object.keys(calls.batchCreate[0]).sort(), ['data', 'path'],
    'payload 只允许 path + data（correlation 不许混进去）');
  assert.deepEqual(Object.keys(calls.batchCreate[0].data), ['records']);
  assert.deepEqual(Object.keys(calls.batchUpdate[0].data), ['records']);
});
