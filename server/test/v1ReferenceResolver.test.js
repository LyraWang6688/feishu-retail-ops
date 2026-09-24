const test = require('node:test');
const assert = require('node:assert/strict');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');

const makeGateway = (records) => ({
  table: () => ({
    fields: { number: '编号', itemNo: '货号', color: '颜色' },
  }),
  listAll: async () => records,
});

test('product resolver prefers the complete configured product number', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      {
        record_id: 'rec_exact',
        fields: { 编号: '8088-26|棕|女鞋', 货号: 'other', 颜色: '黑' },
      },
    ]),
  );

  const result = await resolver.resolveProduct({ productNumber: '8088-26|棕|女鞋' });

  assert.equal(result.recordId, 'rec_exact');
});

test('product resolver accepts spoken item number plus color when display number includes category', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      {
        record_id: 'rec_alias',
        fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' },
      },
    ]),
  );

  const result = await resolver.resolveProduct({ productNumber: '8088-26棕' });

  assert.equal(result.recordId, 'rec_alias');
});

test('product resolver rejects a non-unique spoken item number plus color', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      { record_id: 'rec_1', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' } },
      { record_id: 'rec_2', fields: { 编号: '8088-26|棕|男鞋', 货号: '8088-26', 颜色: '棕' } },
    ]),
  );

  await assert.rejects(
    resolver.resolveProduct({ productNumber: '8088-26棕' }),
    /货品匹配不唯一/,
  );
});
