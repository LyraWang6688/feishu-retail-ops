const test = require('node:test');
const assert = require('node:assert/strict');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');

const schema = {
  appToken: 'app_v1',
  tables: {
    sample: {
      tableName: '测试表',
      tableId: 'tbl_sample',
      fields: { name: '名称', quantity: '数量' },
    },
  },
};

test('V1 gateway maps semantic keys to current Chinese field names', () => {
  const gateway = new V1BitableGateway({ schema, client: {} });
  assert.deepEqual(gateway.fields('sample', { name: 'A', quantity: 2 }), { 名称: 'A', 数量: 2 });
  assert.throws(() => gateway.fields('sample', { missing: 'x' }), /未配置语义字段/);
});

test('V1 gateway schema validation reports renamed or missing fields', async () => {
  const client = {
    bitable: {
      appTableField: {
        list: async () => ({ code: 0, data: { items: [{ field_name: '名称' }], has_more: false } }),
      },
    },
  };
  const gateway = new V1BitableGateway({ schema, client });
  await assert.rejects(() => gateway.validateTable('sample'), /缺少 V1 字段: 数量/);
});

test('relation and display helpers support Feishu record field shapes', () => {
  assert.deepEqual(linkedRecordIds(['rec_1', { record_id: 'rec_2' }, { id: 'rec_3' }]), [
    'rec_1',
    'rec_2',
    'rec_3',
  ]);
  assert.deepEqual(linkedRecordIds({ link_record_ids: ['rec_4'] }), ['rec_4']);
  assert.deepEqual(linkedRecordIds([{ record_ids: ['rec_5'], table_id: 'tbl_order',
    text: 'XSD-20260925-0062', type: 'text' }]), ['rec_5']);
  assert.deepEqual(linkedRecordIds({ record_ids: ['rec_6', 'rec_7'] }), ['rec_6', 'rec_7']);
  assert.equal(textValue([{ text: 'A' }, { name: 'B' }]), 'A,B');
});
