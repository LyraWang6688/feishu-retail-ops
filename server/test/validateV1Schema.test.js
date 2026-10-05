const test = require('node:test');
const assert = require('node:assert/strict');
const { validateV1SchemaScope } = require('../scripts/validate_v1_schema');

const sizeLinkedTables = ['salesDetail', 'purchaseRequest', 'purchaseInbound', 'inventoryLedger', 'liveInventory'];
// 幂等键是文本字段：写的是 "purchase_request:<taskId>:<n>" 这类稳定键。
// customerCredit 的键字段语义名不同（businessEventId，中文列「业务事件ID」），
// 它是售后 prepaid 的幂等键，同样必须在 sales 范围里被校验到。
const idempotencyKeyFields = {
  purchaseOrderBatch: '幂等键', purchaseRequest: '幂等键', liveInventory: '库存操作键', customerCredit: '业务事件ID',
};
// 每张表的键字段语义名不同：采购用 idempotencyKey，实时库存用 operationItemKey，往来货款用 businessEventId。
const keyFieldOf = (tableKey) => {
  if (tableKey === 'liveInventory') return 'operationItemKey';
  if (tableKey === 'customerCredit') return 'businessEventId';
  return 'idempotencyKey';
};
const gatewayFor = (overrides = {}) => {
  const seen = [];
  const fields = Object.fromEntries(sizeLinkedTables.map((key) => [key, [
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } },
  ]]));
  for (const [key, fieldName] of Object.entries(idempotencyKeyFields)) {
    fields[key] = [...(fields[key] || []), { field_name: fieldName, type: 1 }];
  }
  fields.sizeManagement = [{ field_name: '尺码', type: 2 }];
  for (const [key, value] of Object.entries(overrides)) fields[key] = value;
  return {
    seen,
    table: (key) => key === 'sizeManagement'
      ? { tableName: '尺码管理', tableId: 'size_table', fields: { size: '尺码' } }
      : { tableName: key, fields: { size: '尺码', name: '行为名称',
        code: '行为编码', stockDirection: '库存方向', enabled: '是否启用',
        [keyFieldOf(key)]: idempotencyKeyFields[key] || '幂等键' } },
    validateTables: async (keys) => { seen.push(...keys); return keys.map((tableKey) => ({ tableKey })); },
    listFields: async (key) => fields[key] || [],
    listAll: async (key) => key === 'behavior' ? [
      { record_id: 'sale', fields: { 行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true } },
      { record_id: 'purchase', fields: { 行为编码: 'STOCK_PURCHASE_INCREASE', 行为名称: '采购增加', 库存方向: '增加', 是否启用: true } },
      // 售后三条（与 inventoryService.STOCK_MOVEMENTS 的方向一致）：validateStockBehaviors 会全表核对。
      { record_id: 'return', fields: { 行为编码: 'SALE_RETURN', 行为名称: '销售退货', 库存方向: '增加', 是否启用: true } },
      { record_id: 'compensation', fields: { 行为编码: 'SALE_COMPENSATION', 行为名称: '销售赔货', 库存方向: '减少', 是否启用: true } },
      { record_id: 'cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货销售', 库存方向: '减少', 是否启用: true } },
    ] : [],
  };
};

test('inventory and all CLI scopes check the size-management link contract', async () => {
  for (const scope of ['inventory', 'all']) {
    const gateway = gatewayFor();
    const result = await validateV1SchemaScope({ gateway, scope });
    assert.equal(result.scope, scope);
    assert.ok(gateway.seen.includes('sizeManagement'));
  }
});

test('inventory and all CLI scopes reject numeric, multi-link and wrong-target size fields', async () => {
  const invalidFields = [
    { field_name: '尺码', type: 2 },
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: true } },
    { field_name: '尺码', type: 18, property: { table_id: 'other_table', multiple: false } },
  ];
  for (const scope of ['inventory', 'all']) {
    for (const invalid of invalidFields) {
      const gateway = gatewayFor({ purchaseInbound: [invalid] });
      await assert.rejects(validateV1SchemaScope({ gateway, scope }), /单选关联“尺码管理”/);
    }
  }
});

test('all CLI scope also checks the purchase-request size relation', async () => {
  const gateway = gatewayFor({ purchaseRequest: [{ field_name: '尺码', type: 2 }] });
  await assert.rejects(validateV1SchemaScope({ gateway, scope: 'all' }), /单选关联“尺码管理”/);
});

test('all checks size links even when an unrelated table has a missing field', async () => {
  const gateway = gatewayFor({ liveInventory: [{ field_name: '尺码', type: 2 }] });
  gateway.validateTables = async () => { throw new Error('其他表缺少字段'); };
  await assert.rejects(validateV1SchemaScope({ gateway, scope: 'all' }), /单选关联“尺码管理”/);
});

test('inventory CLI scope rejects a non-numeric size-management source', async () => {
  const gateway = gatewayFor({ sizeManagement: [{ field_name: '尺码', type: 1 }] });
  await assert.rejects(validateV1SchemaScope({ gateway, scope: 'inventory' }), /必须是数字字段/);
});

// 销售和采购范围同样落在真实录入链路上：跑各自的 schema-check 时，
// 尺码字段是数字、多选或指错表都必须直接失败，而不是报成功。
test('sales CLI scope validates the sales-detail size relation', async () => {
  const invalidFields = [
    { field_name: '尺码', type: 2 },
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: true } },
    { field_name: '尺码', type: 18, property: { table_id: 'other_table', multiple: false } },
  ];
  for (const invalid of invalidFields) {
    await assert.rejects(validateV1SchemaScope({ gateway: gatewayFor({ salesDetail: [invalid] }), scope: 'sales' }),
      /单选关联“尺码管理”/);
  }
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ sizeManagement: [{ field_name: '尺码', type: 1 }] }), scope: 'sales' }),
    /必须是数字字段/,
  );
});

// 售后 prepaid 写「客户往来货款」时用「业务事件ID」当幂等键：它必须真的存在于 sales 范围，
// 且是文本字段。否则这张表改名/缺列部署门槛查不出来，只会在用户确认售后时才炸。
test('sales CLI scope 校验「客户往来货款」的幂等键列', async () => {
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ customerCredit: [] }), scope: 'sales' }),
    /缺少「业务事件ID」字段/,
  );
  await assert.rejects(
    validateV1SchemaScope({
      gateway: gatewayFor({ customerCredit: [{ field_name: '业务事件ID', type: 2 }] }), scope: 'sales',
    }),
    /「业务事件ID」必须是文本字段/,
  );
  const gateway = gatewayFor();
  await validateV1SchemaScope({ gateway, scope: 'sales' });
  assert.ok(gateway.seen.includes('customerCredit'));
});

test('purchase CLI scope validates both intake size relations', async () => {
  for (const tableKey of ['purchaseRequest', 'purchaseInbound']) {
    await assert.rejects(
      validateV1SchemaScope({ gateway: gatewayFor({ [tableKey]: [{ field_name: '尺码', type: 2 }] }), scope: 'purchase' }),
      /单选关联“尺码管理”/,
    );
  }
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ sizeManagement: [{ field_name: '尺码', type: 1 }] }), scope: 'purchase' }),
    /必须是数字字段/,
  );
});

// 幂等依赖的字段必须真实存在且是文本：列名对了但类型是数字/单选，
// 幂等键会写成空值，重试照旧会重复创建采购事实。
test('幂等键字段缺失时 schema-check 直接失败，而不是等到确认采购才报错', async () => {
  const cases = {
    purchaseOrderBatch: [
      { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } }],
    purchaseRequest: [
      { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } }],
    liveInventory: [
      { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } }],
  };
  for (const [tableKey, fields] of Object.entries(cases)) {
    const scope = tableKey === 'liveInventory' ? 'inventory' : 'purchase';
    await assert.rejects(validateV1SchemaScope({ gateway: gatewayFor({ [tableKey]: fields }), scope }),
      /缺少「(幂等键|库存操作键)」字段/);
  }
});

test('幂等键字段类型不是文本时 schema-check 直接失败', async () => {
  const asNumber = (fieldName) => [
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } },
    { field_name: fieldName, type: 2 },
  ];
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ purchaseRequest: asNumber('幂等键') }), scope: 'purchase' }),
    /「幂等键」必须是文本字段/,
  );
  await assert.rejects(
    validateV1SchemaScope({ gateway: gatewayFor({ liveInventory: asNumber('库存操作键') }), scope: 'inventory' }),
    /「库存操作键」必须是文本字段/,
  );
});
