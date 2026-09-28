const test = require('node:test');
const assert = require('node:assert/strict');
const { validateV1SchemaScope } = require('../scripts/validate_v1_schema');

const sizeLinkedTables = ['salesDetail', 'purchaseRequest', 'purchaseInbound', 'inventoryLedger', 'liveInventory'];
const gatewayFor = (overrides = {}) => {
  const seen = [];
  const fields = Object.fromEntries(sizeLinkedTables.map((key) => [key, [
    { field_name: '尺码', type: 18, property: { table_id: 'size_table', multiple: false } },
  ]]));
  fields.sizeManagement = [{ field_name: '尺码', type: 2 }];
  for (const [key, value] of Object.entries(overrides)) fields[key] = value;
  return {
    seen,
    table: (key) => key === 'sizeManagement'
      ? { tableName: '尺码管理', tableId: 'size_table', fields: { size: '尺码' } }
      : { tableName: key, fields: { size: '尺码', name: '行为名称',
        stockDirection: '库存方向', enabled: '是否启用' } },
    validateTables: async (keys) => { seen.push(...keys); return keys.map((tableKey) => ({ tableKey })); },
    listFields: async (key) => fields[key] || [],
    listAll: async (key) => key === 'behavior' ? [
      { record_id: 'sale', fields: { 行为名称: '销售减少', 库存方向: '减少', 是否启用: true } },
      { record_id: 'purchase', fields: { 行为名称: '采购增加', 库存方向: '增加', 是否启用: true } },
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
