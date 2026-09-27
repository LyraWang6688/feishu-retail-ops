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

test('product resolver treats a trailing color suffix as presentation only', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      { record_id: 'rec_brown', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' } },
    ]),
  );

  const result = await resolver.resolveProduct({ itemNo: '8088-26', color: '棕色' });

  assert.equal(result.recordId, 'rec_brown');
});

test('product resolver asks for color when one item number has multiple configured products', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      { record_id: 'rec_brown', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' } },
      { record_id: 'rec_black', fields: { 编号: '8088-26|黑|女鞋', 货号: '8088-26', 颜色: '黑' } },
    ]),
  );

  await assert.rejects(
    resolver.resolveProduct({ itemNo: '8088-26' }),
    /请补充颜色（棕、黑）/,
  );
});

const salesProducts = [
  { record_id: 'rec_8882_card', fields: { 编号: '8882|卡|B', 货号: '8882', 颜色: [{ text: '卡' }] } },
  { record_id: 'rec_hyx_khaki', fields: { 编号: 'HYX-115|卡其|A', 货号: 'HYX-115', 颜色: [{ text: '卡其' }] } },
  { record_id: 'rec_hyx_black', fields: { 编号: 'HYX-115|黑色|A', 货号: 'HYX-115', 颜色: [{ text: '黑色' }] } },
];

test('sales splits a Chinese color suffix only after finding a configured SKU', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));
  assert.equal((await resolver.resolveProduct({ itemNo: '8882卡', matchMode: 'sales' })).recordId, 'rec_8882_card');
  assert.equal((await resolver.resolveProduct({ itemNo: 'HYX-115卡', matchMode: 'sales' })).recordId, 'rec_hyx_khaki');
});

test('sales uniquely expands a color abbreviation under the exact SKU', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));
  assert.equal((await resolver.resolveProduct({ itemNo: 'HYX-115', color: '卡', matchMode: 'sales' })).recordId, 'rec_hyx_khaki');
  assert.equal((await resolver.resolveProduct({ itemNo: 'HYX-115', color: '黑', matchMode: 'sales' })).recordId, 'rec_hyx_black');
});

test('sales prefers an exact color over a longer color beginning with the same character', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    ...salesProducts,
    { record_id: 'rec_8882_khaki', fields: { 编号: '8882|卡其|B', 货号: '8882', 颜色: '卡其' } },
  ]));
  assert.equal((await resolver.resolveProduct({ itemNo: '8882卡', matchMode: 'sales' })).recordId, 'rec_8882_card');
});

test('sales never guesses a different color or corrects a spoken SKU', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));
  await assert.rejects(resolver.resolveProduct({ itemNo: '8882咖', matchMode: 'sales' }), /找不到货品/);
  await assert.rejects(resolver.resolveProduct({ itemNo: 'HYX-115卡', color: '黑', matchMode: 'sales' }), /颜色.*不一致/);
  await assert.rejects(resolver.resolveProduct({ itemNo: 'HYX-11S', color: '卡其', matchMode: 'sales' }), /找不到货品/);
  assert.equal((await resolver.resolveProduct({ itemNo: 'HYX-11S', color: '卡其' })).recordId, 'rec_hyx_khaki');
});

test('sales rejects ambiguous color abbreviations and duplicate product categories', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    ...salesProducts,
    { record_id: 'rec_hyx_cardamom', fields: { 编号: 'HYX-115|卡通|B', 货号: 'HYX-115', 颜色: '卡通' } },
  ]));
  await assert.rejects(resolver.resolveProduct({ itemNo: 'HYX-115', color: '卡', matchMode: 'sales' }), /多个货品/);
  const duplicate = new V1ReferenceResolver(makeGateway([
    ...salesProducts,
    { record_id: 'rec_hyx_duplicate', fields: { 编号: 'HYX-115|卡其|B', 货号: 'HYX-115', 颜色: '卡其' } },
  ]));
  await assert.rejects(duplicate.resolveProduct({ itemNo: 'HYX-115', color: '卡其', matchMode: 'sales' }), /多个货品/);
});
