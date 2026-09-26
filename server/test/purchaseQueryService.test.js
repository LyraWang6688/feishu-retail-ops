const test = require('node:test');
const assert = require('node:assert/strict');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');

const makeGateway = (records = {}) => ({
  listAll: async (key) => records[key] || [],
});

test('listPurchaseRequests maps fields and filters by batchNo', async () => {
  const gateway = makeGateway({
    purchaseRequest: [
      { record_id: 'req_1', fields: { 报货批次号: 'BH-001', 编号: ['prod_1'], 尺码: 36, 数量: 2, 到货状态: '部分到货', 报单时间: 1758844800000 } },
      { record_id: 'req_2', fields: { 报货批次号: 'BH-002', 编号: ['prod_2'], 尺码: 37, 数量: 1, 到货状态: '未到货', 报单时间: 1758931200000 } },
    ],
    product: [
      { record_id: 'prod_1', fields: { 编号: '8088灰', 供应商: ['sup_1'] } },
      { record_id: 'prod_2', fields: { 编号: '9099黑', 供应商: ['sup_2'] } },
    ],
    purchaseOrderBatch: [
      { record_id: 'batch_1', fields: { 报货批次号: 'BH-001', 供应商: ['sup_1'] } },
      { record_id: 'batch_2', fields: { 报货批次号: 'BH-002', 供应商: ['sup_2'] } },
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
  const gateway = makeGateway({
    purchaseArrival: [
      { record_id: 'arr_1', fields: { 到货日: 1758844800000, 报货批次号: ['batch_1'], 鞋盒图片: [{ file_token: 't1' }, { file_token: 't2' }], 识别状态: '识别成功', 确认状态: '待确认', 识别失败原因: '' } },
      { record_id: 'arr_2', fields: { 到货日: 1758931200000, 报货批次号: ['batch_2'], 鞋盒图片: [], 识别状态: '识别失败', 确认状态: '待确认', 识别失败原因: '没有鞋盒图片' } },
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
  assert.equal(all[0].recognition_status, '识别失败');
  assert.equal(all[0].confirm_status, '待确认');
  assert.equal(all[0].failure_reason, '没有鞋盒图片');
  assert.equal(all[0].image_count, 0);
  assert.equal(all[0].supplier_record_id, '');

  assert.equal(all[1].record_id, 'arr_1');
  assert.equal(all[1].image_count, 2);

  const filtered = await service.listPurchaseArrivals({ confirmStatus: '待确认' });
  assert.equal(filtered.length, 2);

  const byRecognition = await service.listPurchaseArrivals({ recognitionStatus: '识别失败' });
  assert.equal(byRecognition.length, 1);
  assert.equal(byRecognition[0].record_id, 'arr_2');
});

test('listPurchaseArrivals handles missing batch link gracefully', async () => {
  const gateway = makeGateway({
    purchaseArrival: [
      { record_id: 'arr_nobatch', fields: { 到货日: 1758844800000, 报货批次号: [], 鞋盒图片: [], 识别状态: '待识别', 确认状态: '待确认', 识别失败原因: '' } },
    ],
    purchaseOrderBatch: [],
  });
  const service = createPurchaseQueryService(gateway);
  const rows = await service.listPurchaseArrivals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].batch_no, '');
  assert.equal(rows[0].supplier_record_id, '');
});
