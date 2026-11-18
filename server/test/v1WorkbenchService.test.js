const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkbenchService } = require('../src/services/v1WorkbenchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { resetConfigTableCache } = require('../src/services/configTableCache');

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


test('单双调整按产品过滤读：只读 1 条货品 + 这一款库存，不整表读', async () => {
  resetConfigTableCache();
  let filteredCalls = 0;
  const listAllCalls = [];
  const live = [
    { record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_36'] }], 所属状态: '门盒' } },
    { record_id: 'l2', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_37'] }], 所属状态: '门盒' } },
    { record_id: 'l3', fields: { 编号: [{ record_ids: ['p2'] }], 尺码: [{ record_ids: ['size_38'] }], 所属状态: '门盒' } },
  ];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    get: async (key, id) => (id === 'p1' ? { record_id: 'p1', fields: { 编号: '93827黑' } } : null),
    listByFilter: async (key, formula, options) => {
      filteredCalls += 1;
      assert.equal(key, 'liveInventory');
      assert.ok(formula, '必须带库存键前缀 filter');
      assert.equal(options.maxRecords, 200);
      return live;
    },
    listAll: async (key) => {
      listAllCalls.push(key);
      return key === 'sizeManagement' ? SIZES : [];
    },
  };
  const result = await createWorkbenchService(gateway).getLiveInventory({ productRecordId: 'p1' });

  assert.deepEqual(result.rows.map((row) => [row.size, row.quantity]), [[36, 1], [37, 1]], '只返回这一款');
  assert.equal(filteredCalls, 1, '走一次过滤读');
  assert.equal(listAllCalls.includes('liveInventory'), false, '不许再整表读实时库存');
  assert.equal(listAllCalls.includes('product'), false, '不许再整表读货品');
});

test('单双调整：记录 ID 形状不合法 ⇒ 400，不拿坏 id 打飞书', async () => {
  const gateway = { table: (key) => V1_BITABLE_SCHEMA.tables[key], listAll: async () => [] };
  await assert.rejects(
    () => createWorkbenchService(gateway).getLiveInventory({ productRecordId: '../bad' }),
    (error) => error.statusCode === 400,
  );
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

test('批量调整品类走「品类管理」配置表缓存，不读实时库存', async () => {
  resetConfigTableCache();
  let categoryCalls = 0;
  let liveCalls = 0;
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'category') {
        categoryCalls += 1;
        return [
          { record_id: 'c1', fields: { 品类: '男鞋', 类别: 'A' } },
          { record_id: 'c2', fields: { 品类: '女鞋', 类别: 'B' } },
        ];
      }
      if (key === 'liveInventory') liveCalls += 1;
      return [];
    },
  };
  const service = createWorkbenchService(gateway);
  const first = await service.listInventoryCategories();
  const second = await service.listInventoryCategories();
  assert.deepEqual(first.rows.map((row) => row.category), ['男鞋', '女鞋']);
  assert.equal(categoryCalls, 1, '第二次应命中配置表缓存');
  assert.equal(liveCalls, 0, '品类下拉不许再读实时库存');
  assert.equal(second.total, 2);
});

test('实时库存走统一缓存：5 分钟内的第二次读取不再打飞书', async () => {
  resetConfigTableCache();
  let liveCalls = 0;
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'liveInventory') {
        liveCalls += 1;
        return [{ record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_36'] }], 所属状态: '门盒' } }];
      }
      if (key === 'sizeManagement') return SIZES;
      return key === 'product' ? [{ record_id: 'p1', fields: { 编号: '93827黑' } }] : [];
    },
  };
  const service = createWorkbenchService(gateway);
  await service.getLiveInventory();
  await service.getLiveInventory();
  assert.equal(liveCalls, 1, 'TTL 内第二次读取必须命中缓存');
});


test('实时库存读复用配置表快照：同一张表第二次不再整表读', async () => {
  resetConfigTableCache();
  let liveCalls = 0;
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (key === 'liveInventory') {
        liveCalls += 1;
        return [{ record_id: 'l1', fields: { 编号: [{ record_ids: ['p1'] }], 尺码: [{ record_ids: ['size_36'] }], 所属状态: '门盒' } }];
      }
      if (key === 'sizeManagement') return SIZES;
      if (key === 'product') return [{ record_id: 'p1', fields: { 编号: '93827黑' } }];
      return [];
    },
  };
  const service = createWorkbenchService(gateway);
  await service.getLiveInventory();
  await service.getLiveInventory();
  assert.equal(liveCalls, 1, '同一份实时库存快照只读一次');
});

test('库存流水：按创建时间倒序，映射四列并可限制条数', async () => {
  const ledger = [
    { record_id: 'l_old', fields: { 创建时间: 1700000000000, 库存行为: [{ text: '手工调增' }], 编号: [{ text: 'A|黑|男' }], 尺码: [{ text: '38' }], 变动数量: '1' } },
    { record_id: 'l_new', fields: { 创建时间: 1700000003000, 库存行为: [{ text: '销售减少' }], 编号: [{ text: 'B|白|女' }], 尺码: [{ text: '40' }], 变动数量: 2 } },
    { record_id: 'l_mid', fields: { 创建时间: 1700000002000, 库存行为: [{ text: '采购增加' }], 编号: [{ text: 'C|米|男' }], 尺码: [{ text: '42' }], 变动数量: 1 } },
  ];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => (key === 'inventoryLedger' ? ledger : []),
  };
  const service = createWorkbenchService(gateway);
  const all = await service.getInventoryLedger({ from: '2023-11-15', to: '2023-11-15' });
  assert.deepEqual(all.rows.map((row) => row.record_id), ['l_new', 'l_mid', 'l_old']);
  assert.deepEqual(all.rows[0], {
    record_id: 'l_new',
    behavior: '销售减少',
    number: 'B|白|女',
    size: '40',
    quantity_change: 2,
    created_at: new Date(1700000003000).toISOString(),
  });
  assert.equal(all.total, 3);
  assert.equal(all.truncated, false);

  const limited = await service.getInventoryLedger({ from: '2023-11-15', to: '2023-11-15', limit: 2 });
  assert.deepEqual(limited.rows.map((row) => row.record_id), ['l_new', 'l_mid']);
  assert.equal(limited.total, 3);
  assert.equal(limited.truncated, true);
});
