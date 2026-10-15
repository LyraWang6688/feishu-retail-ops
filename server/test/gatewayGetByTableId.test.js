'use strict';

/**
 * ⭐⭐ 2026-10-15（task-19 的**前置件** · Lead 已批准）：
 *   业务负责人新建的「**配品销售**」表（`tblkT1QTUsESnl5b`）**不在 schema 里** ⇒
 *   本网关其它方法都按"语义键 + `schema.tableId`"取表 ⇒ 那张表**没有任何门**；
 *   而"绕过网关直连飞书 SDK"会破坏「**全仓只有网关直连飞书**」这条纪律 ✗
 *   ⇒ 新增这一个**只读**口 `getByTableId` ✓
 *
 * AC（本文件只钉这两个**前置件**；入口 service 与 8 条 AS 用例见下一刀）：
 *   · **AC-P1** `getByTableId` 把**原始 table_id / record_id / field_names** 原样送出去（只读 `get`）
 *   · **AC-P2** 空 `tableId` / 空 `recordId` ⇒ **当场抛**（不猜、不发请求 ✓）
 *   · **AC-P3** 飞书回错 ⇒ **如实抛**（**绝不静默返回空** ✗ —— 空会被上层当成"这一行没有值"）
 *   · **AC-P4** 它**只读**：网关**没有**随之出现任何"按 table_id 写"的口 ✗
 *   · **AC-P5** 事件里"按 `field_id` 取值"的纯件 `findFieldValue` **可复用**（从 `tagQrCodeService` 导出 ✓）
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_intake_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'intake_secret';
// ⚠️ 网关构造时就要 app_token（缺 ⇒ 当场抛）⇒ 必须在 **require 之前**给它一个假值 ✓（与其它用例同一手法）
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { findFieldValue } = require('../src/services/tagQrCodeService');

const TABLE_ID = 'tblkT1QTUsESnl5b';
const RECORD_ID = 'rec_accessory_sale_1';

/** 假 SDK client：把"真实打到飞书的那份请求"原样抓下来（只实现 `appTableRecord.get`）。 */
const captureClient = (response = { code: 0, data: { record: { record_id: RECORD_ID, fields: {} } } }) => {
  const calls = [];
  const client = {
    bitable: {
      appTableRecord: {
        get: async (request) => { calls.push(request); return response; },
        create: async () => { throw new Error('本口不许写 ✗'); },
        update: async () => { throw new Error('本口不许写 ✗'); },
      },
    },
  };
  return { client, calls };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-P1 / AC-P2 / AC-P3 读的形状与失败口径
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P1 ⭐ `getByTableId` 把**原始 table_id / record_id / field_names** 原样送出去（只读 `get`）', async () => {
  const { client, calls } = captureClient();
  const gateway = new V1BitableGateway({ client });
  const record = await gateway.getByTableId({
    tableId: TABLE_ID, recordId: RECORD_ID,
    fieldNames: ['名称', '金额', '收款方式'],
    reason: 'accessory_sale_intake.fallback',
  });
  assert.equal(calls.length, 1, '恰发一次请求 ✓');
  assert.equal(calls[0].path.table_id, TABLE_ID, '**原始 table_id**（不经过 schema ✓）');
  assert.equal(calls[0].path.record_id, RECORD_ID);
  assert.equal(calls[0].path.app_token, gateway.schema.appToken, 'app_token 照旧来自 schema ✓');
  assert.deepEqual(JSON.parse(calls[0].params.field_names), ['名称', '金额', '收款方式'],
    '按需取字段（与既有"按需取列"同一口径 ✓）');
  assert.equal(record.record_id, RECORD_ID, '返回飞书那条 record ✓');
});

test('AC-P1b ⭐ 不给 `fieldNames` ⇒ **不发** `field_names` 参数（退回整条读 ✓ 不编空数组 ✗）', async () => {
  const { client, calls } = captureClient();
  const gateway = new V1BitableGateway({ client });
  await gateway.getByTableId({ tableId: TABLE_ID, recordId: RECORD_ID });
  assert.equal(calls[0].params, undefined, '没有要的列就不带参数 ✓');
});

test('AC-P2 🔴 空 `tableId` / 空 `recordId` ⇒ **当场抛**（不猜、一个请求都不发）', async () => {
  const { client, calls } = captureClient();
  const gateway = new V1BitableGateway({ client });
  await assert.rejects(() => gateway.getByTableId({ tableId: '', recordId: RECORD_ID }), /需要 tableId/);
  await assert.rejects(() => gateway.getByTableId({ tableId: TABLE_ID, recordId: '  ' }), /需要 recordId/);
  assert.equal(calls.length, 0, '**一个请求都不许发** ✓');
});

test('AC-P3 🔴 飞书回错 ⇒ **如实抛**（**绝不静默返回空** ✗）', async () => {
  const { client } = captureClient({ code: 1254607, msg: 'Data not ready, please try again later' });
  const gateway = new V1BitableGateway({ client });
  await assert.rejects(() => gateway.getByTableId({ tableId: TABLE_ID, recordId: RECORD_ID }));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P4 只读（源码哨兵）：只有读口，没有"按 table_id 写"的口
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P4 🔴 它**只读**：源码里没有任何"按 tableId 写/删"的口（`createByTableId` 之类 ✗）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'v1BitableGateway.js'), 'utf8');
  for (const forbidden of ['createByTableId', 'updateByTableId', 'deleteByTableId', 'batchCreateByTableId']) {
    assert.equal(source.includes(forbidden), false, `不许有 \`${forbidden}\` ✗（要写必须先有 schema 映射）`);
  }
  assert.match(source, /async getByTableId\(/, '只留这一个**只读**口 ✓');
  // 它体内只许出现 `appTableRecord.get`（不许出现写方法）
  const start = source.indexOf('async getByTableId(');
  const body = source.slice(start, source.indexOf('\n  async getBatch(', start));
  assert.match(body, /appTableRecord\.get\(/, '读 ✓');
  for (const write of ['appTableRecord.create', 'appTableRecord.update', 'appTableRecord.delete']) {
    assert.equal(body.includes(write), false, `\`getByTableId\` 体内不许写 ✗（${write}）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P5 事件读值的纯件**可复用**（Lead：复用既有 `findFieldValue`，不抄第二份 ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P5 ⭐ `findFieldValue` 可复用（按 `field_id` 从事件的 `after_value` 里取值）', () => {
  const afterValue = [
    { field_id: 'fld_name', field_value: [{ record_ids: ['rec_acc_oil'] }] },
    { field_id: 'fld_amount', field_value: 128 },
  ];
  assert.deepEqual(findFieldValue(afterValue, 'fld_name'), [{ record_ids: ['rec_acc_oil'] }],
    '关联列 ⇒ 拿得到那条关联记录的 id ✓（不需要按名字反查 ✓）');
  assert.equal(findFieldValue(afterValue, 'fld_amount'), 128, '数字列原样 ✓');
  assert.equal(findFieldValue(afterValue, 'fld_missing'), undefined, '没带那一列 ⇒ `undefined`（**不编 0 / 不编空串** ✗）');
  assert.equal(findFieldValue(null, 'fld_amount'), undefined, '整个 `after_value` 缺失 ⇒ 也是 `undefined` ✓');
});
