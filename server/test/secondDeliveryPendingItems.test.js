// 「货号 + 尺码」这几个**事实**从哪来、怎么取（2026-10-07）。
//
// 这份文件盯的是 `secondDeliveryService.listPendingDeliveries({ includeItems: true })`：
//   □ 货号取「货品信息.**货号**」（不是「编号」）；
//   □ 尺码走**共享的尺码解析**（销售明细里是关联「尺码管理」），解析不了退回单元格文本；
//   □ 配品取「其他配品.名称」，**没有尺码**（返回空串，不是 undefined）；
//   □ 缺货号 / 缺名称的那一件**不产出条目**（展示层因此不会拼出「 码」这种空壳）；
//   □ 表**整表各读一次**：货品信息 1 次、「其他配品」配了才读 1 次，
//     **不为了货号尺码再读一遍销售明细**（复用本轮已经读进来的那份）；
//   □ `includeItems` 默认**关**：第二次交付提醒那条路读表与返回形状**一个字都不变**；
//   □ 分区要用的 `tradeTypeCode`（行为编码）照常给。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SecondDeliveryService } = require('../src/services/secondDeliveryService');

const DAY = new Date('2026-10-07T02:00:00.000Z'); // 北京 10:00
const SOLD_AT = Date.parse('2026-10-06T10:00:00+08:00');

// 表定义：语义键与真实 `v1BitableSchema` 一致，只是 tableId 由用例自己给。
const tables = (overrides = {}) => ({
  product: { tableId: 'tbl_product', fields: { itemNo: '货号', number: '编号', color: '颜色' } },
  // ⚠️ 默认**没配**「其他配品」表（有些部署只卖鞋）——要用它的用例显式打开。
  accessory: { tableId: '', fields: { name: '名称' } },
  behavior: { tableId: 'tbl_behavior', fields: { code: '行为编码', name: '行为名称' } },
  salesEntry: {
    tableId: 'tbl_entry',
    fields: { orderNo: '销售单号', tradeType: '交易类型', recordedAt: '录单日', funds: '资金状态' },
  },
  salesDetail: {
    tableId: 'tbl_detail',
    fields: {
      salesEntry: '销售单号', product: '编号', accessory: '配品', size: '尺码',
      soldAt: '销售日', fulfillmentStatus: '履约状态', actualAmount: '成交金额',
    },
  },
  paymentRecord: {
    tableId: 'tbl_payment',
    fields: { salesEntry: '关联销售单', amount: '收款金额', status: '收款状态' },
  },
  sizeManagement: { tableId: 'tbl_size', fields: { size: '尺码' } },
  ...overrides,
});

// 一笔「未付、已入账、尚未成交」的单：主表 1 条 + 收款 1 条（未收款）。
const seed = ({ details, entry = {}, payments = [], products = [], accessories = [], behavior = {} } = {}) => ({
  behavior: [{
    record_id: 'b_unpaid',
    fields: { 行为编码: 'SALE_UNPAID', 行为名称: '未付', ...behavior },
  }],
  salesEntry: [{
    record_id: 'o1',
    fields: { 销售单号: 'XSD-1', 交易类型: ['b_unpaid'], 录单日: SOLD_AT, 资金状态: '已写入', ...entry },
  }],
  salesDetail: details,
  paymentRecord: payments.length ? payments : [
    { record_id: 'r1', fields: { 关联销售单: ['o1'], 收款金额: 100, 收款状态: '未收款' } },
  ],
  product: products,
  accessory: accessories,
});

const gatewayFor = (records, tableDefs = tables()) => {
  const map = new Map(Object.entries(records).map(([key, rows]) =>
    [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  const calls = [];
  const gateway = {
    calls,
    table: (key) => tableDefs[key],
    validateTables: async () => [],
    listAll: async (key) => {
      calls.push(key);
      return map.get(key) || [];
    },
    get: async (key, id) => (map.get(key) || []).find((row) => row.record_id === id) || null,
  };
  return gateway;
};

// 共享尺码解析的桩：和真实现一样，「尺码关联字段为空」= 抛错（调用方据此留空）。
const sizeStub = (byRecordId = { sz37: 37, sz43: 43 }) => ({
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    const recordId = typeof id === 'object' ? (id?.record_ids || [])[0] : id;
    if (!recordId || byRecordId[recordId] === undefined) throw new Error('尺码关联字段为空或格式无效');
    return { recordId, size: byRecordId[recordId] };
  },
});

const shoe = (recordId, productId, sizeCell) => ({
  record_id: recordId,
  fields: { 销售单号: ['o1'], 编号: [productId], 尺码: sizeCell, 履约状态: '已交付', 成交金额: 228, 销售日: SOLD_AT },
});
const accessoryRow = (recordId, accessoryId) => ({
  record_id: recordId,
  fields: { 销售单号: ['o1'], 配品: [accessoryId], 履约状态: '已交付', 成交金额: 39, 销售日: SOLD_AT },
});

const run = (records, options = {}) => new SecondDeliveryService({
  gateway: gatewayFor(records, options.tableDefs),
  sizeReferences: options.sizeReferences || sizeStub(),
  store: {},
  client: {},
}).listPendingDeliveries({ now: DAY, ...options.query });

// ─────────────────────────────────────────────────────────────────────────────

test('货号取「货品信息.货号」、尺码走共享解析；配品取「名称」且**没有尺码**', async () => {
  const gatewayRecords = seed({
    details: [
      shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }]),
      accessoryRow('d2', 'a1'),
    ],
    products: [{ record_id: 'p1', fields: { 货号: 'B26002-52', 编号: 'N-1', 颜色: '黑色' } }],
    accessories: [{ record_id: 'a1', fields: { 名称: '腰带' } }],
  });
  const orders = await run(gatewayRecords, {
    tableDefs: tables({ accessory: { tableId: 'tbl_accessory', fields: { name: '名称' } } }),
    query: { includeItems: true },
  });

  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].items, [
    { kind: 'shoe', itemNo: 'B26002-52', size: '37' }, // 货号，不是「编号」N-1
    { kind: 'accessory', itemNo: '腰带', size: '' }, // 配品没有尺码：空串
  ]);
  assert.equal(orders[0].tradeTypeCode, 'SALE_UNPAID');
});

test('表整表各读一次：货品信息 1 次、配品 1 次、销售明细**不重复读**', async () => {
  const gatewayRecords = seed({
    details: [shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }]), shoe('d2', 'p2', [{ record_ids: ['sz43'], text: '43' }])],
    products: [
      { record_id: 'p1', fields: { 货号: 'B26002-52' } },
      { record_id: 'p2', fields: { 货号: '6A637-7' } },
    ],
  });
  const gateway = gatewayFor(gatewayRecords, tables({ accessory: { tableId: 'tbl_accessory', fields: { name: '名称' } } }));
  const orders = await new SecondDeliveryService({
    gateway, sizeReferences: sizeStub(), store: {}, client: {},
  }).listPendingDeliveries({ now: DAY, includeItems: true });

  assert.equal(orders[0].items.length, 2, '一单两件逐件给事实');
  const count = (key) => gateway.calls.filter((call) => call === key).length;
  assert.equal(count('salesDetail'), 1, '销售明细只读一次（复用候选筛选那次）');
  assert.equal(count('product'), 1, '货品信息整表只读一次');
  assert.equal(count('accessory'), 1, '其他配品整表只读一次');
});

test('没配「其他配品」表：不去读它（只卖鞋的部署照样工作）', async () => {
  const gatewayRecords = seed({
    details: [shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }])],
    products: [{ record_id: 'p1', fields: { 货号: 'B26002-52' } }],
  });
  const gateway = gatewayFor(gatewayRecords, tables());
  const orders = await new SecondDeliveryService({
    gateway, sizeReferences: sizeStub(), store: {}, client: {},
  }).listPendingDeliveries({ now: DAY, includeItems: true });

  assert.deepEqual(orders[0].items, [{ kind: 'shoe', itemNo: 'B26002-52', size: '37' }]);
  assert.equal(gateway.calls.includes('accessory'), false);
});

test('缺货号 / 缺配品名称 / 鞋缺尺码：这些件**不产出**（展示层因此拼不出空壳）', async () => {
  const gatewayRecords = seed({
    details: [
      shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }]), // 货号缺失
      accessoryRow('d2', 'a1'), // 名称缺失
      shoe('d3', 'p3', []), // 尺码缺失（关联为空，单元格也没文本）
      shoe('d4', 'p4', [{ record_ids: ['sz43'], text: '43' }]), // 正常
      { record_id: 'd5', fields: { 销售单号: ['o1'], 履约状态: '已交付', 成交金额: 1 } }, // 既非鞋也非配品
    ],
    products: [
      { record_id: 'p1', fields: { 编号: 'N-1' } },
      { record_id: 'p3', fields: { 货号: 'NO-SIZE' } },
      { record_id: 'p4', fields: { 货号: '6A637-7' } },
    ],
    accessories: [{ record_id: 'a1', fields: {} }],
  });
  const orders = await run(gatewayRecords, {
    tableDefs: tables({ accessory: { tableId: 'tbl_accessory', fields: { name: '名称' } } }),
    query: { includeItems: true },
  });

  assert.deepEqual(orders[0].items, [
    { kind: 'shoe', itemNo: 'NO-SIZE', size: '' }, // 鞋缺尺码：留空串（不拼「码」）
    { kind: 'shoe', itemNo: '6A637-7', size: '43' },
  ]);
  // 一条空壳都没有：没有 itemNo 为空的条目。
  assert.equal(orders[0].items.some((item) => !item.itemNo), false);
});

test('尺码解析不出来时退回单元格自带的文本；两个都没有就留空', async () => {
  const gatewayRecords = seed({
    details: [
      shoe('d1', 'p1', [{ record_ids: ['sz_unknown'], text: '37' }]), // 解析器不认识 → 用单元格文本
      shoe('d2', 'p2', ['sz_also_unknown']), // 单元格也没有文本 → 空
    ],
    products: [
      { record_id: 'p1', fields: { 货号: 'A-1' } },
      { record_id: 'p2', fields: { 货号: 'A-2' } },
    ],
  });
  const orders = await run(gatewayRecords, { query: { includeItems: true } });
  assert.deepEqual(orders[0].items, [
    { kind: 'shoe', itemNo: 'A-1', size: '37' },
    { kind: 'shoe', itemNo: 'A-2', size: '' },
  ]);
});

test('includeItems 默认关：不多读表，返回对象里**没有** items 键（第二次交付那条路一字不变）', async () => {
  const gatewayRecords = seed({
    details: [shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }])],
    products: [{ record_id: 'p1', fields: { 货号: 'B26002-52' } }],
  });
  const gateway = gatewayFor(gatewayRecords, tables());
  const orders = await new SecondDeliveryService({
    gateway, sizeReferences: sizeStub(), store: {}, client: {},
  }).listPendingDeliveries({ now: DAY });

  assert.deepEqual(Object.keys(orders[0]).sort(), [
    'fulfillmentStatus', 'orderNo', 'paymentStatus', 'pendingAmount', 'pendingDeliveryQuantity',
    'platformPendingAmount', 'quantity', 'saleDate', 'salesEntryRecordId', 'tradeTypeCode',
    'tradeTypeLabel',
  ]);
  assert.equal(gateway.calls.includes('product'), false, '关着时一次货品表都不读');
  assert.equal(gateway.calls.includes('accessory'), false);
  assert.equal(gateway.calls.filter((call) => call === 'salesDetail').length, 1);
});

test('候选口径没变：已入账 + 未付/预付 + 7 天内 + 未完成，一条都不多一条都不少', async () => {
  const records = seed({
    details: [shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }])],
    products: [{ record_id: 'p1', fields: { 货号: 'B26002-52' } }],
  });
  const included = await run(records, { query: { includeItems: true } });
  assert.equal(included.length, 1);

  // 已经收清的（收款状态=已收款）→ 不算候选（与口径一致：尚未成交才推）。
  const settled = await run(seed({
    details: [shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }])],
    payments: [{ record_id: 'r1', fields: { 关联销售单: ['o1'], 收款金额: 228, 收款状态: '已收款' } }],
  }), { query: { includeItems: true } });
  assert.deepEqual(settled, []);

  // 没入账的 → 不算候选。
  const unposted = await run(seed({
    details: [shoe('d1', 'p1', [{ record_ids: ['sz37'], text: '37' }])],
    entry: { 资金状态: '未写入' },
  }), { query: { includeItems: true } });
  assert.deepEqual(unposted, []);
});
