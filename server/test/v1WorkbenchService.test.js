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


test('实时库存读遇到 504/2200 瞬态错误会短重试，成功后正常返回', async () => {
  const original = process.env.WORKBENCH_ORDERS_RETRY_DELAY_MS;
  process.env.WORKBENCH_ORDERS_RETRY_DELAY_MS = '0';
  let liveCalls = 0;
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'liveInventory') {
        liveCalls += 1;
        if (liveCalls === 1) {
          throw Object.assign(new Error('Request failed with status code 504'), {
            response: { status: 504, data: { code: 2200, msg: 'Gateway timeout. Please try again later.' } },
          });
        }
        return [{ record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_36'] }], 所属状态: '门盒' } }];
      }
      if (key === 'sizeManagement') return SIZES;
      return key === 'product' ? [{ record_id: 'p1', fields: { 编号: '93827黑' } }] : [];
    },
  };
  try {
    const result = await createWorkbenchService(gateway).getLiveInventory();
    assert.equal(liveCalls, 2, '第一次 504 后必须再读一次');
    assert.equal(result.rows.length, 1);
  } finally {
    if (original === undefined) delete process.env.WORKBENCH_ORDERS_RETRY_DELAY_MS;
    else process.env.WORKBENCH_ORDERS_RETRY_DELAY_MS = original;
  }
});
