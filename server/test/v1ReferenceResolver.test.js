const test = require('node:test');
const assert = require('node:assert/strict');
const { V1ReferenceResolver } = require('../src/services/v1ReferenceResolver');

const makeGateway = (records) => ({
  table: () => ({
    // 与生产 schema 一致：销售口述路径也要认「货品状态」（飞书公式：在售 / 下架）。
    fields: { number: '编号', itemNo: '货号', color: '颜色', status: '货品状态' },
  }),
  listAll: async () => records,
});

// ─── 采购到货：货号 + 颜色 是主路径（产品负责人 2026-10-05 定稿的临时简化规则）───
//
// 拿识别出的「货号 + 颜色」去货品信息表匹配：命中就用它，没命中就交给到货链路建档。
// 命中多条不再报错，取第一条继续，但要把条数带回去让卡片标注。

test('product resolver prefers the complete configured 编号 when the document carries it', async () => {
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

test('采购：货号+颜色 命中恰 1 条就用现有记录，且 编号 缺类别也不影响', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      {
        record_id: 'rec_alias',
        // 表里的「编号」是公式拼的「货号|颜色|类别」；单据上常常没有类别，
        // 识别出来的只有 货号+颜色，主路径必须能匹配上。
        fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' },
      },
    ]),
  );

  const result = await resolver.resolveProduct({ itemNo: '8088-26', color: '棕' });

  assert.equal(result.recordId, 'rec_alias');
  assert.equal(result.ambiguousCount, 1);
});

test('采购：货号+颜色 命中多条时取第一条、不报错，并带回条数供卡片标注', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      { record_id: 'rec_women', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' } },
      { record_id: 'rec_men', fields: { 编号: '8088-26|棕|男鞋', 货号: '8088-26', 颜色: '棕' } },
    ]),
  );

  // 男/女鞋常共用同一货号+颜色：产品负责人要求"取第一条，不报错、不停下"。
  const result = await resolver.resolveProduct({ itemNo: '8088-26', color: '棕' });

  assert.equal(result.recordId, 'rec_women', '取第一条');
  assert.equal(result.ambiguousCount, 2, '条数要带回去，卡片才能写「匹配到 2 条」');
  assert.equal(result.selectedColor, '棕');
  assert.equal(result.selectedNumber, '808826棕女鞋', '已取哪条也要能标出来');
});

test('采购：货号命中多条颜色、又没识别出颜色时同样取第一条', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      { record_id: 'rec_brown', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' } },
      { record_id: 'rec_black', fields: { 编号: '8088-26|黑|女鞋', 货号: '8088-26', 颜色: '黑' } },
    ]),
  );

  // 不再有「请补充颜色」这种保护分支：识别不出颜色也照样取第一条，把条数带回去。
  const result = await resolver.resolveProduct({ itemNo: '8088-26' });

  assert.equal(result.recordId, 'rec_brown');
  assert.equal(result.ambiguousCount, 2);
});

test('颜色归一：「棕」和「棕色」算同一件', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      { record_id: 'rec_brown', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' } },
    ]),
  );

  const result = await resolver.resolveProduct({ itemNo: '8088-26', color: '棕色' });

  assert.equal(result.recordId, 'rec_brown');
});

test('采购：货号在、颜色对不上 → 判为找不到，让到货链路去建档（不做「提示核对」的保护）', async () => {
  const resolver = new V1ReferenceResolver(
    makeGateway([
      { record_id: 'rec_brown', fields: { 编号: '8088-26|棕|女鞋', 货号: '8088-26', 颜色: '棕' } },
    ]),
  );

  await assert.rejects(
    resolver.resolveProduct({ itemNo: '8088-26', color: '红' }),
    (error) => error.code === 'PRODUCT_NOT_FOUND',
  );
});

test('采购：货号+颜色命中 0 条 → 判为找不到，由到货链路自动建档', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([]));

  await assert.rejects(
    resolver.resolveProduct({ itemNo: '3602', color: '黑' }),
    (error) => error.code === 'PRODUCT_NOT_FOUND',
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

// ⭐ 2026-10-07 第四刀：候选要**顺手带出「货品状态」**（现货 / 未付按它过滤候选）——
//    「谁给候选、谁带状态」：这张表本来就整表读过了，带出来零新增请求。
test('候选带上「货品状态」（在售 / 下架）；这一列读不到时留空串（空 ≠ 下架）', async () => {
  const products = [
    { record_id: 'rec_a', fields: { 编号: '8035|黑牛仔|A', 货号: '8035', 颜色: '黑牛仔', 货品状态: '在售' } },
    { record_id: 'rec_b', fields: { 编号: '8035|白牛仔|A', 货号: '8035', 颜色: '白牛仔', 货品状态: '下架' } },
    // 这一条**没有**「货品状态」列（公式没算出来 / 列缺失）。
    { record_id: 'rec_c', fields: { 编号: '8035|灰牛仔|A', 货号: '8035', 颜色: '灰牛仔' } },
  ];
  const result = await new V1ReferenceResolver(makeGateway(products)).resolveProduct({
    itemNo: '8035', matchMode: 'sales',
  });
  const statusByColor = Object.fromEntries(result.options.map((option) => [option.color, option.status]));
  assert.deepEqual(statusByColor, { 黑牛仔: '在售', 白牛仔: '下架', 灰牛仔: '' });
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
