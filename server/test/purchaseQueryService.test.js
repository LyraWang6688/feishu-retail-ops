const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 「尺码」是指向「尺码管理」的关联字段，读取时要能从关联记录解析回整数。
const SIZE_RECORDS = [36, 37].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const sizeLink = (size) => [`size_${size}`];

const makeGateway = (records = {}) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => (key === 'sizeManagement' ? SIZE_RECORDS : records[key] || []),
});

test('listPurchaseRequests maps fields and filters by batchNo', async () => {
  // ⚠️ 2026-10-07：到货状态**从「报货批次」那一行读**（「具体信息」的同名列已被
  // 业务负责人从生产表删除，schema 映射与读取点同步删掉了）。所以这台假 Base 里，
  // 「到货状态」挂在**批次记录**上 —— 断言口径没变（行上显示的就是这一批的到货状态）。
  const gateway = makeGateway({
    purchaseRequest: [
      { record_id: 'req_1', fields: { 报货批次号: ['batch_1'], 编号: ['prod_1'], 尺码: sizeLink(36), 数量: 2, 报单时间: 1758844800000 } },
      { record_id: 'req_2', fields: { 报货批次号: ['batch_2'], 编号: ['prod_2'], 尺码: sizeLink(37), 数量: 1, 报单时间: 1758931200000 } },
    ],
    product: [
      { record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: ['sup_1'] } },
      { record_id: 'prod_2', fields: { 编号: '9099黑', 供应商: ['sup_2'] } },
    ],
    purchaseOrderBatch: [
      { record_id: 'batch_1', fields: { 报货批次号: 'BH-001', 供应商: ['sup_1'], 到货状态: '部分到货' } },
      { record_id: 'batch_2', fields: { 报货批次号: 'BH-002', 供应商: ['sup_2'], 到货状态: '未到货' } },
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

  const filtered = await service.listPurchaseRequests({ batchNo: 'BH-001' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].batch_no, 'BH-001');

  const byStatus = await service.listPurchaseRequests({ arrivalStatus: '部分到货' });
  assert.equal(byStatus.length, 1);
  assert.equal(byStatus[0].record_id, 'req_1');
});

test('listPurchaseArrivals maps fields and resolves batch link', async () => {
  // ⚠️ 2026-10-05：原先这里的记录还带「识别状态」「识别失败原因」两个字段，
  // 断言里也有 recognition_status / failure_reason 两项和一个 recognitionStatus 过滤。
  // 业务负责人已把这两个字段从生产表删除（拍照识别链路整体退场），schema 映射同步删掉，
  // 查询接口也不再投影/过滤它们——所以本用例改成只断言留下来的容器字段。
  //
  // ⚠️ 2026-10-07 晚：同一张表又变了一次 —— 表改名「到货验收」，且**「图片」整列被她删掉**。
  // 下面这两条假记录**故意还带着「图片」附件**（本机测试 Base 落后、那一列还在，
  // 真实生产里已经没有它）：接口**一个字都不许再读它**，`image_count` 这个 key
  // 必须像 recognition_status 一样**彻底消失**，而不是永远返回 0。
  const gateway = makeGateway({
    purchaseArrival: [
      { record_id: 'arr_1', fields: { 到货日: 1758844800000, 报货批次号: ['batch_1'], 图片: [{ file_token: 't1' }, { file_token: 't2' }], 确认状态: '待确认' } },
      { record_id: 'arr_2', fields: { 到货日: 1758931200000, 报货批次号: ['batch_2'], 图片: [], 确认状态: '待确认' } },
    ],
    purchaseOrderBatch: [
      { record_id: 'batch_1', fields: { 报货批次号: 'BH-001', 供应商: ['sup_1'] } },
      { record_id: 'batch_2', fields: { 报货批次号: 'BH-002', 供应商: ['sup_2'] } },
    ],
  });
  const service = createPurchaseQueryService(gateway);

  const all = await service.listPurchaseArrivals();
  assert.equal(all.length, 2);
  assert.equal(all[0].record_id, 'arr_2');
  assert.equal(all[0].batch_no, 'BH-002');
  assert.equal(all[0].confirm_status, '待确认');
  assert.equal(all[0].supplier_record_id, '');
  // 退场的字段连 key 都不该再出现（否则前端会渲染出一列永远为空的"识别状态"）。
  assert.equal('recognition_status' in all[0], false);
  assert.equal('failure_reason' in all[0], false);
  // 同上：「图片」列已被她删除 ⇒ image_count 也必须彻底消失（留着 = 永远显示 0，比不显示更误导）。
  assert.equal('image_count' in all[0], false, '「图片」列已删 → 不许再投影 image_count');
  assert.equal('image_count' in all[1], false, '哪怕真表里还留着那一列（测试 Base 落后），也不许再读它');

  assert.equal(all[1].record_id, 'arr_1');

  const filtered = await service.listPurchaseArrivals({ confirmStatus: '待确认' });
  assert.equal(filtered.length, 2);

  // recognitionStatus 过滤已摘掉：传了也不该再筛掉任何东西。
  const byRetiredFilter = await service.listPurchaseArrivals({ recognitionStatus: '识别失败' });
  assert.equal(byRetiredFilter.length, 2);
});

test('listPurchaseArrivals handles missing batch link gracefully', async () => {
  const gateway = makeGateway({
    purchaseArrival: [
      { record_id: 'arr_nobatch', fields: { 到货日: 1758844800000, 报货批次号: [], 图片: [], 确认状态: '待确认' } },
    ],
    purchaseOrderBatch: [],
  });
  const service = createPurchaseQueryService(gateway);
  const rows = await service.listPurchaseArrivals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].batch_no, '');
  assert.equal(rows[0].supplier_record_id, '');
});
