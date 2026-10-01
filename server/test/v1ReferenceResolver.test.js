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

// ─── 销售只看货号：颜色一律交给确认卡片 ───
//
// 用户录单时只给货号，不再说颜色。所以这里没有任何「用户说了颜色」的分支：
// 货号唯一就直接用，不唯一就把该货号的颜色候选交给卡片让用户选。

const salesProducts = [
  { record_id: 'rec_8882_card', fields: { 编号: '8882|卡|B', 货号: '8882', 颜色: [{ text: '卡' }] } },
  { record_id: 'rec_hyx_khaki', fields: { 编号: 'HYX-115|卡其|A', 货号: 'HYX-115', 颜色: [{ text: '卡其' }] } },
  { record_id: 'rec_xhb_black', fields: { 编号: 'XHB8095|全黑|A', 货号: 'XHB8095', 颜色: [{ text: '全黑' }] } },
  { record_id: 'rec_8035_mi', fields: { 编号: '8035|米牛仔|A', 货号: '8035', 颜色: '米牛仔' } },
  { record_id: 'rec_8035_black', fields: { 编号: '8035|黑牛仔|A', 货号: '8035', 颜色: '黑牛仔' } },
];

test('sales resolves a single-color SKU by item number alone', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));
  const result = await resolver.resolveProduct({ itemNo: 'XHB8095', matchMode: 'sales' });
  assert.equal(result.recordId, 'rec_xhb_black');
});

test('sales hands every color of a multi-color SKU to the card', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));
  const result = await resolver.resolveProduct({ itemNo: '8035', matchMode: 'sales' });

  assert.equal(result.needsColor, true);
  assert.equal(result.itemNo, '8035');
  assert.deepEqual(result.options.map((option) => option.color).sort(), ['米牛仔', '黑牛仔'].sort());
});

test('sales ignores any color the message happened to carry', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));

  // 说了颜色也不参与判定：单色的直接定，多色的照样给候选。
  assert.equal((await resolver.resolveProduct({ itemNo: 'XHB8095', color: '黑色', matchMode: 'sales' })).recordId,
    'rec_xhb_black');
  assert.equal((await resolver.resolveProduct({ itemNo: 'XHB8095', color: '配色不存在', matchMode: 'sales' })).recordId,
    'rec_xhb_black');
  assert.equal((await resolver.resolveProduct({ itemNo: '8035', color: '黑牛仔', matchMode: 'sales' })).needsColor, true);
});

test('sales refuses an item number carrying extra characters instead of peeling them off', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));

  // 货号对不上就明确报错让用户核对，不做"剥掉后面的字再试一次"这种自作聪明的事。
  await assert.rejects(resolver.resolveProduct({ itemNo: 'XHB8095黑色', matchMode: 'sales' }), /找不到货品/);
  await assert.rejects(resolver.resolveProduct({ itemNo: '8035米牛仔', matchMode: 'sales' }), /找不到货品/);
});

test('sales never corrects a misspelled item number into a different shoe', async () => {
  const resolver = new V1ReferenceResolver(makeGateway(salesProducts));

  // 字母顺序写反、缺前缀、多打一位——都不许猜成另一双鞋。
  for (const itemNo of ['HXY-115', '6858', '226632']) {
    await assert.rejects(resolver.resolveProduct({ itemNo, matchMode: 'sales' }), /找不到货品/);
  }
});
