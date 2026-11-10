const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkbenchService } = require('../src/services/v1WorkbenchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 2026-11-08：自建销售查询已退场，本文件只保留实时库存读模型用例。
const SIZES = [36, 37, 38].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const gatewayFor = (records) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => (key === 'sizeManagement' ? SIZES : records[key] || []),
});

test('live inventory resolves sizes from the link and filters by the numeric size', async () => {
  const gateway = gatewayFor({
    liveInventory: [
      { record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_36'] }], 所属状态: '门盒' } },
      { record_id: 'l2', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_37'] }], 所属状态: '门盒' } },
      { record_id: 'l3', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_37'] }], 所属状态: '门盒' } },
    ],
    product: [{ record_id: 'p1', fields: { 编号: '93827黑' } }],
  });
  const all = await createWorkbenchService(gateway).getLiveInventory();
  const filtered = await createWorkbenchService(gateway).getLiveInventory({ size: '37' });

  assert.deepEqual(all.rows.map((row) => [row.size, row.quantity]).sort(), [[36, 1], [37, 2]]);
  assert.deepEqual(filtered.rows.map((row) => [row.size, row.quantity]), [[37, 2]]);
});

