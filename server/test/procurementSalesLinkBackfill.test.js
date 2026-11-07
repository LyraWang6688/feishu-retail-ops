/**
 * 2026-11-08（业务负责人）：销售明细新增单向关联「采购明细」→ 采购提交成功后**按编号+尺码回填**。
 *
 * 判据：
 *   AC-SL1 按「编号+尺码」匹配、**只取未关联**的行、按销售日旧→新、最多取采购明细的「数量」条；
 *   AC-SL2 幂等：同一 task 再跑一次 ⇒ 不再多链（已关联数先抵扣）；
 *   AC-SL3 未关联行不够 ⇒ 链已有的 + 记 warn（不抛）；
 *   AC-SL4 某条 update 失败 ⇒ 其余继续 + failed 计数（不抛，不影响采购事实）；
 *   AC-SL5 本地任务没有批次号 ⇒ 直接 no-op；gateway 抛错 ⇒ 返回 ok:false、不抛。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProcurementPageConfig } = require('../src/config/procurementPage');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createProcurementSalesLinkBackfill } = require('../src/services/procurementSalesLinkBackfill');

const config = buildProcurementPageConfig({});
const S = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
const R = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
const NOW = Date.parse('2026-11-08T03:45:00+08:00');
const at = (iso) => Date.parse(`${iso}+08:00`);

const salesRecord = ({ id, product, size, soldAt, linked = [] }) => ({
  record_id: id,
  fields: {
    [S.product]: [{ text: product, type: 'text' }],
    [S.size]: size,
    [S.soldAt]: soldAt,
    [S.stockQuantity]: 0,
    [S.tradeType]: [{ record_ids: ['recSpot'], text: '现货' }],
    [S.purchaseDetail]: linked.map((detailId) => ({ record_ids: [detailId] })),
  },
});
const detailRecord = ({ id, product, size, quantity }) => ({
  record_id: id,
  fields: {
    [R.batchNo]: [{ text: 'CGD-TEST-0001' }],
    [R.product]: [{ text: product }],
    [R.size]: size,
    [R.quantity]: quantity,
  },
});

const PRODUCT_NUMBERS = {
  recA1: 'A1|黑色|A',
  recB2: 'B2|咖色|B',
};
// 与 getBatch 同形（公式 `{type, value:[{text}]}`）
const productBatch = (ids) => ids.map((id) => ({
  record_id: id,
  fields: { [V1_BITABLE_SCHEMA.tables.product.fields.number]: { type: 1, value: [{ text: PRODUCT_NUMBERS[id] || '' }] } },
}));
const makeTask = ({ requestIds, items, batchNo = 'CGD-TEST-0001' }) => ({
  batch_no: batchNo,
  request_ids: requestIds,
  posting_plan: { version: 1, batch_no: batchNo, items },
});

const makeEnv = ({ sales, requestIds, items, failIds = [], task } = {}) => {
  const salesRows = sales.map((row) => JSON.parse(JSON.stringify(row)));
  const logs = { info: [], warn: [] };
  const gateway = {
    async getBatch(tableKey, ids) {
      assert.equal(tableKey, 'product');
      return productBatch(ids);
    },
    async update(tableKey, recordId, semanticValues) {
      assert.equal(tableKey, 'salesDetail');
      if (failIds.includes(recordId)) throw new Error('fake update failed');
      const row = salesRows.find((one) => one.record_id === recordId);
      // 与真网关同形：语义键 → 物理列名（真网关在 `fields()` 里做这层映射）
      const physical = Object.fromEntries(Object.entries(semanticValues).map(([key, value]) => [S[key], value]));
      row.fields = { ...row.fields, ...physical };
      return { record_id: recordId };
    },
  };
  const taskStore = { async get() { return task || makeTask({ requestIds, items }); } };
  const logger = {
    logInfo: (event, payload) => logs.info.push({ event, payload }),
    logWarn: (event, payload) => logs.warn.push({ event, payload }),
  };
  const backfill = createProcurementSalesLinkBackfill({
    gateway, config, taskStore, logger, readSalesRows: async () => salesRows,
  });
  const linkedIdsOf = (id) => {
    const row = salesRows.find((one) => one.record_id === id);
    return (row?.fields?.[S.purchaseDetail] || []).flatMap((cell) => (
      typeof cell === 'string' ? [cell] : (cell?.record_ids || [])
    ));
  };
  return { backfill, linkedIdsOf, logs, salesRows };
};

const baseSales = () => [
  salesRecord({ id: 'r1', product: 'A1|黑色|A', size: 39, soldAt: at('2026-11-07T10:00:00') }),
  salesRecord({ id: 'r2', product: 'A1|黑色|A', size: 39, soldAt: at('2026-11-07T12:00:00') }),
  salesRecord({ id: 'r3', product: 'A1|黑色|A', size: 39, soldAt: at('2026-11-08T01:00:00') }),
  salesRecord({ id: 'r4', product: 'A1|黑色|A', size: 40, soldAt: at('2026-11-07T11:00:00') }),
  salesRecord({ id: 'r5', product: 'B2|咖色|B', size: 39, soldAt: at('2026-11-07T09:00:00') }),
  salesRecord({ id: 'r6', product: 'A1|黑色|A', size: 39, soldAt: at('2026-11-06T09:00:00'), linked: ['recOldDetail'] }),
];

test('AC-SL1 按「编号+尺码」匹配：只链未关联行、旧→新、最多=采购明细数量', async () => {
  const env = makeEnv({
    sales: baseSales(),
    requestIds: ['recDetailA'],
    items: [{ product_record_id: 'recA1', size: 39, quantity: 2 }],
  });
  const result = await env.backfill.run({ taskId: 'task_link_1' });
  assert.equal(result.ok, true);
  assert.equal(result.linked, 2);
  assert.deepEqual(env.linkedIdsOf('r1'), ['recDetailA']);
  assert.deepEqual(env.linkedIdsOf('r2'), ['recDetailA']);
  assert.deepEqual(env.linkedIdsOf('r3'), [], '超过数量 2 ⇒ 第 3 条（最新那条）不链');
  assert.deepEqual(env.linkedIdsOf('r4'), [], '尺码不同 ⇒ 不链');
  assert.deepEqual(env.linkedIdsOf('r5'), [], '编号不同 ⇒ 不链');
  assert.deepEqual(env.linkedIdsOf('r6'), ['recOldDetail'], '已经关联过的行**绝不被改写**');
  assert.ok(env.logs.info.some((one) => one.event === config.events.salesLinkBackfilled));
});

test('AC-SL2 幂等：同一 task 再跑一次 ⇒ 不再多链', async () => {
  const env = makeEnv({
    sales: baseSales(),
    requestIds: ['recDetailA'],
    items: [{ product_record_id: 'recA1', size: 39, quantity: 2 }],
  });
  await env.backfill.run({ taskId: 'task_link_1' });
  const second = await env.backfill.run({ taskId: 'task_link_1' });
  assert.equal(second.linked, 0, '已关联数先抵扣 ⇒ 重跑 0 条');
  assert.deepEqual(env.linkedIdsOf('r1'), ['recDetailA']);
  assert.deepEqual(env.linkedIdsOf('r2'), ['recDetailA']);
});

test('AC-SL3 未关联行不够 ⇒ 链已有的 + warn（不抛）', async () => {
  const env = makeEnv({
    sales: [salesRecord({ id: 'p1', product: 'B2|咖色|B', size: 39, soldAt: at('2026-11-07T09:00:00') })],
    requestIds: ['recDetailB'],
    items: [{ product_record_id: 'recB2', size: 39, quantity: 3 }],
  });
  const result = await env.backfill.run({ taskId: 'task_link_2' });
  assert.equal(result.ok, true);
  assert.equal(result.linked, 1);
  assert.ok(env.logs.warn.some((one) => one.event === config.events.salesLinkBackfillFailed
    && one.payload.reason === 'not_enough_unlinked_sales_rows'));
});

test('AC-SL4 某条 update 失败 ⇒ 其余继续 + failed 计数（不抛）', async () => {
  const env = makeEnv({
    sales: baseSales(),
    requestIds: ['recDetailA', 'recDetailB'],
    items: [
      { product_record_id: 'recA1', size: 39, quantity: 2 },
      { product_record_id: 'recB2', size: 39, quantity: 1 },
    ],
    failIds: ['r1'],
  });
  const result = await env.backfill.run({ taskId: 'task_link_3' });
  assert.equal(result.ok, true);
  assert.deepEqual(env.linkedIdsOf('r1'), [], '失败的没写上');
  assert.deepEqual(env.linkedIdsOf('r2'), ['recDetailA'], '其余照常继续');
  assert.equal(env.linkedIdsOf('r5').length, 1, '另一个供应商的行也链上了');
  assert.ok(result.failed >= 1);
});

test('AC-SL5 没批次号 ⇒ no-op；gateway 抛错 ⇒ 返回 ok:false 且不抛', async () => {
  const noBatch = makeEnv({ sales: [], requestIds: [], items: [], task: {} });
  const empty = await noBatch.backfill.run({ taskId: 'task_no_batch' });
  assert.equal(empty.ok, true);
  assert.equal(empty.reason, 'no_purchase_facts');

  const boom = createProcurementSalesLinkBackfill({
    gateway: { async getBatch() { throw new Error('boom'); } },
    config,
    taskStore: { async get() { return makeTask({ requestIds: ['d1'], items: [{ product_record_id: 'recA1', size: 39, quantity: 1 }] }); } },
    readSalesRows: async () => [],
    logger: { logInfo() {}, logWarn() {} },
  });
  const failed = await boom.run({ taskId: 'task_boom' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /boom/);
});
