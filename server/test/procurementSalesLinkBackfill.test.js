/**
 * 2026-11-08（业务负责人）：销售明细新增单向关联「采购明细」→ 采购提交成功后**按编号+尺码回填**。
 *
 * 判据：
 *   AC-SL1 按「编号+尺码」匹配、**只取未关联**的行、按销售日旧→新、最多取采购明细的「数量」条；
 *   AC-SL2 幂等：同一 task 再跑一次 ⇒ 不再多链（已关联数先抵扣）；
 *   AC-SL3 未关联行不够 ⇒ 链已有的 + 记 warn（不抛）；
 *   AC-SL4 某条 update 失败 ⇒ 其余继续 + failed 计数（不抛，不影响采购事实）；
 *   AC-SL5 本地任务没有批次号 ⇒ 直接 no-op；gateway 抛错 ⇒ 返回 ok:false、不抛；
 *   AC-SL7 **上新来源（source=new）**：直接不参与回填（即使存在可关联销售行），不 warn；
 *   AC-SL8 **补货来源但没有可关联销售记录**：静默跳过（不 warn，汇总 info 计数）。
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

const salesRecord = ({ id, product, size, soldAt, linked = [], trade = 'spot' }) => ({
  record_id: id,
  fields: {
    [S.product]: [{ text: product, type: 'text' }],
    [S.size]: size,
    [S.soldAt]: soldAt,
    [S.stockQuantity]: 0,
    [S.tradeType]: [{ record_ids: [trade === 'prepaid' ? 'recPrepaid' : 'recSpot'], text: trade === 'prepaid' ? '预订' : '现货' }],
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
  recA1: 'A1|黑色|男',
  recB2: 'B2|咖色|女',
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
    async listAll(tableKey) {
      if (tableKey !== 'behavior') throw new Error(`unexpected listAll ${tableKey}`);
      const codeField = V1_BITABLE_SCHEMA.tables.behavior.fields.code;
      return [
        { record_id: 'recSpot', fields: { [codeField]: [{ text: 'SALE_CASH' }] } },
        { record_id: 'recPrepaid', fields: { [codeField]: [{ text: 'SALE_PREPAID' }] } },
      ];
    },
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
  salesRecord({ id: 'r1', product: 'A1|黑色|男', size: 39, soldAt: at('2026-11-07T10:00:00') }),
  salesRecord({ id: 'r2', product: 'A1|黑色|男', size: 39, soldAt: at('2026-11-07T12:00:00') }),
  salesRecord({ id: 'r3', product: 'A1|黑色|男', size: 39, soldAt: at('2026-11-08T01:00:00') }),
  salesRecord({ id: 'r4', product: 'A1|黑色|男', size: 40, soldAt: at('2026-11-07T11:00:00') }),
  salesRecord({ id: 'r5', product: 'B2|咖色|女', size: 39, soldAt: at('2026-11-07T09:00:00') }),
  salesRecord({ id: 'r6', product: 'A1|黑色|男', size: 39, soldAt: at('2026-11-06T09:00:00'), linked: ['recOldDetail'] }),
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

test('AC-SL6 预订优先：数量不够时先链预订（同类型内旧→新），剩下的才是现货', async () => {
  const env = makeEnv({
    // 现货更旧（若只按日期会先链现货），但预订必须先链
    sales: [
      salesRecord({ id: 'sSpotOld', product: 'A1|黑色|男', size: 39, soldAt: at('2026-11-06T08:00:00'), trade: 'spot' }),
      salesRecord({ id: 'sPreNew1', product: 'A1|黑色|男', size: 39, soldAt: at('2026-11-07T12:00:00'), trade: 'prepaid' }),
      salesRecord({ id: 'sPreNew2', product: 'A1|黑色|男', size: 39, soldAt: at('2026-11-07T13:00:00'), trade: 'prepaid' }),
    ],
    requestIds: ['recDetailA'],
    items: [{ product_record_id: 'recA1', size: 39, quantity: 2 }],
  });
  const result = await env.backfill.run({ taskId: 'task_link_prepaid_first' });
  assert.equal(result.ok, true);
  assert.equal(result.linked, 2);
  assert.deepEqual(env.linkedIdsOf('sPreNew1'), ['recDetailA'], '预订（更早）先链');
  assert.deepEqual(env.linkedIdsOf('sPreNew2'), ['recDetailA'], '预订（更晚）再链');
  assert.deepEqual(env.linkedIdsOf('sSpotOld'), [], '数量只有 2 ⇒ 现货留着下次');
});

test('AC-SL7 上新来源：直接不参与回填（即使有可关联销售行），不产生 warn', async () => {
  const env = makeEnv({
    sales: baseSales(),
    requestIds: ['recDetailA'],
    items: [{ product_record_id: 'recA1', size: 39, quantity: 1, source: 'new' }],
  });
  const result = await env.backfill.run({ taskId: 'task_link_new' });
  assert.equal(result.ok, true);
  assert.equal(result.linked, 0, '上新行不参与回填');
  assert.deepEqual(env.linkedIdsOf('r1'), [], '不写任何关联');
  assert.equal(env.logs.warn.length, 0, `上新场景不许产生 warn: ${JSON.stringify(env.logs.warn)}`);
  assert.equal(result.skipped_new_products, 1);
  const info = env.logs.info.find((one) => one.event === config.events.salesLinkBackfilled);
  assert.equal(info.payload.skipped_new_products, 1);
});

test('AC-SL8 补货来源但没有可关联销售记录 ⇒ 静默跳过（不 warn，仅 info 汇总）', async () => {
  const env = makeEnv({
    // 只有 A1|39 的销售行；这次补的是 B2|40（没卖过）⇒ 没有候选
    sales: baseSales(),
    requestIds: ['recDetailB'],
    items: [{ product_record_id: 'recB2', size: 40, quantity: 1, source: 'replenish' }],
  });
  const result = await env.backfill.run({ taskId: 'task_link_no_sales' });
  assert.equal(result.ok, true);
  assert.equal(result.linked, 0);
  assert.equal(result.skipped_no_sales_rows, 1);
  assert.equal(env.logs.warn.length, 0, '没有销售记录不是异常，不许 warn');
  const info = env.logs.info.find((one) => one.event === config.events.salesLinkBackfilled);
  assert.equal(info.payload.skipped_no_sales_rows, 1);
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
    sales: [salesRecord({ id: 'p1', product: 'B2|咖色|女', size: 39, soldAt: at('2026-11-07T09:00:00') })],
    requestIds: ['recDetailB'],
    items: [{ product_record_id: 'recB2', size: 39, quantity: 3 }],
  });
  const result = await env.backfill.run({ taskId: 'task_link_2' });
  assert.equal(result.ok, true);
  assert.equal(result.linked, 1);
  assert.equal(result.unmatched, 1, '数量不足要计数（通知用）');
  assert.equal(result.unmatched_details[0].purchase_detail_id, 'recDetailB');
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
  assert.equal(result.failures[0].sales_detail_id, 'r1', '失败明细要带回给通知用');
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
