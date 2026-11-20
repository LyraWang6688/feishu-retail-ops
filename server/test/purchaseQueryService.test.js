const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeLinkFields } = require('./support/linkReadShape');

// 「尺码」是指向「尺码管理」的关联字段，读取时要能从关联记录解析回整数。
const SIZE_RECORDS = [36, 37].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];

const makeGateway = (records = {}) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => (key === 'sizeManagement' ? SIZE_RECORDS : (records[key] || []).map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }))),
});

test('listPurchaseRequests maps fields and filters by batchNo', async () => {
  // ⚠️ 2026-10-07：到货状态**从「报货批次」那一行读**（「具体信息」的同名列已被
  // 业务负责人从生产表删除，schema 映射与读取点同步删掉了）。所以这台假 Base 里，
  // 「到货状态」挂在**批次记录**上 —— 断言口径没变（行上显示的就是这一批的到货状态）。
  const gateway = makeGateway({
    purchaseRequest: [
      { record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: [{ record_ids: ['prod_1'] }], 尺码: sizeLink(36), 数量: 2, 报单时间: 1758844800000 } },
      { record_id: 'req_2', fields: { 报货批次号: ['batch_2'], 编号: [{ record_ids: ['prod_2'] }], 尺码: sizeLink(37), 数量: 1, 报单时间: 1758931200000 } },
    ],
    product: [
      { record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: [{ record_ids: ['sup_1'] }] } },
      { record_id: 'prod_2', fields: { 编号: '9099黑', 供应商: [{ record_ids: ['sup_2'] }] } },
    ],
    behavior: [
      { record_id: 'behavior_order', fields: { 行为名称: '报货', 行为编码: 'PURCHASE_ORDER' } },
      { record_id: 'behavior_in', fields: { 行为名称: '入库', 行为编码: 'PURCHASE_IN' } },
    ],
    purchaseOrderBatch: [
      { record_id: 'batch_1', fields: { 报货批次号: 'BH-001', 供应商: [{ record_ids: ['sup_1'] }], 发生行为: ['behavior_in'], 到货日: '2026-11-20T07:00:00.000Z' } },
      { record_id: 'batch_2', fields: { 报货批次号: 'BH-002', 供应商: [{ record_ids: ['sup_2'] }], 发生行为: ['behavior_order'] } },
    ],
  });
  const service = createPurchaseQueryService(gateway);

  const all = await service.listPurchaseRequests();
  assert.equal(all.length, 2);
  assert.equal(all[0].batch_no, 'BH-002');
  assert.equal(all[0].product_number, '9099黑');
  assert.equal(all[0].size, 37);
  assert.equal(all[0].quantity, 1);
  assert.equal(all[0].arrival_status, '未到货');
  assert.equal(all[0].supplier_record_id, 'sup_2');
  const arrivedRow = (await service.listPurchaseRequests({ batchNo: 'BH-001' }))[0];

  const filtered = await service.listPurchaseRequests({ batchNo: 'BH-001' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].batch_no, 'BH-001');

  const byStatus = await service.listPurchaseRequests({ arrivalStatus: '已到货' });
  assert.equal(byStatus.length, 1);
  assert.equal(byStatus[0].record_id, 'req_1');
});

test('listPurchaseArrivals ⭐ 改读「报货批次」那一行（到货落点 2026-10-07 晚改到这里）', async () => {
  // ⚠️ 2026-10-05：原先这里的记录还带「识别状态」「识别失败原因」两个字段。
  // ⚠️ 2026-10-07 晚：同一张表又变了一次 —— 表改名「到货验收」→ 然后**被业务负责人整个删除**。
  //    到货信息（验收原话 / 确认状态）现在写在**「报货批次」那一行**上
  //    ⇒ 这个查询**只读「报货批次」**，一行 = 一条批次记录。
  // ⚠️ 下面这台假 Base **故意还留着 `purchaseArrival` 的旧记录**（本机测试 Base 落后）：
  //    接口**一个字都不许再读它** —— 断言"返回的行来自批次表"就是这条。
  const gateway = makeGateway({
    behavior: [
      { record_id: 'behavior_order', fields: { 行为名称: '报货', 行为编码: 'PURCHASE_ORDER' } },
      { record_id: 'behavior_in', fields: { 行为名称: '入库', 行为编码: 'PURCHASE_IN' } },
      { record_id: 'behavior_ret', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN' } },
    ],
    purchaseArrival: [
      { record_id: 'arr_legacy', fields: { 到货日: 1758844800000, 报货批次号: ['batch_1'], 确认状态: '待确认' } },
    ],
    purchaseOrderBatch: [
      {
        record_id: 'batch_1',
        fields: {
          报货批次号: 'BH-001',
          发生行为: ['behavior_in'],
          到货日: '2026-11-20T07:00:00.000Z',
        },
      },
      { record_id: 'batch_2', fields: { 报货批次号: 'BH-002', 发生行为: ['behavior_order'] } },
      { record_id: 'batch_ret', fields: { 报货批次号: 'BH-003', 发生行为: ['behavior_ret'], 幂等键: 'purchase_batch:BH-003' } },
    ],
  });
  const service = createPurchaseQueryService(gateway);

  const all = await service.listPurchaseArrivals();
  assert.equal(all.length, 2, '退货批次（没有任何到货信息）不进这个面板');
  // 排序：批次号倒序（与「具体信息」面板一致；批次行上没有可信的"到货时刻"可排）。
  assert.deepEqual(all.map((row) => row.batch_no), ['BH-002', 'BH-001']);
  const arrived = all.find((row) => row.batch_no === 'BH-001');
  assert.equal(arrived.arrival_status, '已到货');
  // ⛔ 那两个投影**已删除**（列都没有了，留着只会永远读出空串、把"没记"伪装成"记了但空"）。
  assert.equal('confirm_status' in arrived, false, '确认状态投影已退场');
  assert.equal('acceptance_text' in arrived, false, '验收原话投影已退场');
  // record_id / batch_record_id 都是**批次记录 id**（到货信息的落点）。
  assert.equal(arrived.record_id, 'batch_1');
  assert.equal(arrived.batch_record_id, 'batch_1');
  // 退场的字段连 key 都不该再出现（否则前端会渲染出一列永远为空的"识别状态"/"图片数"）。
  assert.equal('recognition_status' in arrived, false);
  assert.equal('failure_reason' in arrived, false);
  assert.equal('image_count' in arrived, false, '「图片」列已随表删除 → 不许再投影 image_count');
  assert.equal(arrived.arrival_at, '2026-11-20T07:00:00.000Z', '到货日 = 点击验收时间');

  const byBatch = await service.listPurchaseArrivals({ batchNo: 'BH-002' });
  assert.deepEqual(byBatch.map((row) => row.batch_no), ['BH-002']);

  // ⛔ 2026-10-09：`confirmStatus` 过滤**已删除**（「确认状态」那一列在真表上没有了，
  //   路由层与这里都不再接受这个筛选条件）。留下的筛选只有 batchNo / arrivalStatus。

  const byArrival = await service.listPurchaseArrivals({ arrivalStatus: '未到货' });
  assert.deepEqual(byArrival.map((row) => row.batch_no), ['BH-002']);
});

test('listPurchaseArrivals：批次表里什么都没有时返回空数组（不猜、不编）', async () => {
  const service = createPurchaseQueryService(makeGateway({ purchaseOrderBatch: [] }));
  assert.deepEqual(await service.listPurchaseArrivals(), []);
});

test('AC-BATCH1 按批次读：走「供应主表.采购明细」link + getBatch，不整表读 purchaseRequest', async () => {
  const records = {
    purchaseRequest: [
      { record_id: 'req_1', fields: { 报货批次号: [{ record_ids: ['batch_1'] }], 编号: [{ record_ids: ['prod_1'] }], 尺码: sizeLink(36), 数量: 2 } },
    ],
    product: [{ record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: [{ record_ids: ['sup_1'] }] } }],
    purchaseOrderBatch: [{
      record_id: 'batch_1',
      fields: { 报货批次号: 'BH-001', 采购明细: [{ record_ids: ['req_1'] }], 发生行为: ['behavior_order'] },
    }],
  };
  const calls = { fullPurchaseReads: 0, batchGets: [] };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'purchaseRequest') { calls.fullPurchaseReads += 1; throw new Error('must not read full purchaseRequest'); }
      if (key === 'sizeManagement') return SIZE_RECORDS;
      return (records[key] || []).map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }));
    },
    getBatch: async (key, ids) => {
      calls.batchGets.push({ key, ids });
      return (records[key] || []).filter((row) => ids.includes(row.record_id))
        .map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }));
    },
  };
  const service = createPurchaseQueryService(gateway);
  const rows = await service.listPurchaseRequestsForBatch({ batchNo: 'BH-001' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_id, 'req_1');
  assert.equal(rows[0].size, 36);
  assert.equal(calls.fullPurchaseReads, 0, '不许整表读 purchaseRequest');
  assert.deepEqual(calls.batchGets, [{ key: 'purchaseRequest', ids: ['req_1'] }]);
});
