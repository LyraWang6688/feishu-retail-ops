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

test('sales matches qualified base colors only within the exact SKU', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    { record_id: 'rec_all_black', fields: { 编号: 'XHB8095|全黑|A', 货号: 'XHB8095', 颜色: [{ text: '全黑' }] } },
    { record_id: 'rec_ink_green', fields: { 编号: 'A200|墨绿|A', 货号: 'A200', 颜色: [{ text: '墨绿' }] } },
    { record_id: 'rec_khaki', fields: { 编号: 'A300|卡其|A', 货号: 'A300', 颜色: [{ text: '卡其' }] } },
  ]));
  assert.equal((await resolver.resolveProduct({ itemNo: 'XHB8095', color: '黑', matchMode: 'sales' })).recordId,
    'rec_all_black');
  assert.equal((await resolver.resolveProduct({ itemNo: 'A200', color: '绿', matchMode: 'sales' })).recordId,
    'rec_ink_green');
  assert.equal((await resolver.resolveProduct({ itemNo: 'A300', color: '卡', matchMode: 'sales' })).recordId,
    'rec_khaki');
  // 该货号没有这个颜色：不跨货号去找别的鞋，也不静默替换，而是把该货号的颜色交给卡片让用户选。
  const mismatched = await resolver.resolveProduct({ itemNo: 'XHB8095', color: '绿', matchMode: 'sales' });
  assert.equal(mismatched.needsColor, true);
  assert.equal(mismatched.spokenColor, '绿');
  assert.deepEqual(mismatched.options.map((option) => option.color), ['全黑']);
});

test('sales asks the card to choose between multiple qualified variants of the same base color', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    { record_id: 'rec_all_black', fields: { 编号: 'A100|全黑|A', 货号: 'A100', 颜色: '全黑' } },
    { record_id: 'rec_dark_black', fields: { 编号: 'A100|深黑|A', 货号: 'A100', 颜色: '深黑' } },
  ]));
  const ambiguous = await resolver.resolveProduct({ itemNo: 'A100', color: '黑', matchMode: 'sales' });
  assert.equal(ambiguous.needsColor, true);
  // 不替用户在两个黑之间做选择——两个候选都摆出来。
  assert.deepEqual(ambiguous.options.map((option) => option.color).sort(), ['全黑', '深黑'].sort());
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
  // 说错颜色：不猜成别的颜色，交给卡片选；但说错货号必须直接拒绝。
  const wrongColor = await resolver.resolveProduct({ itemNo: '8882咖', matchMode: 'sales' });
  assert.equal(wrongColor.needsColor, true);
  assert.equal(wrongColor.spokenColor, '咖');
  await assert.rejects(resolver.resolveProduct({ itemNo: 'HYX-115卡', color: '黑', matchMode: 'sales' }), /颜色.*不一致/);
  await assert.rejects(resolver.resolveProduct({ itemNo: 'HYX-11S', color: '卡其', matchMode: 'sales' }), /找不到货品/);
  assert.equal((await resolver.resolveProduct({ itemNo: 'HYX-11S', color: '卡其' })).recordId, 'rec_hyx_khaki');
});

test('sales hands ambiguous color abbreviations and duplicate categories to the card', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    ...salesProducts,
    { record_id: 'rec_hyx_cardamom', fields: { 编号: 'HYX-115|卡通|B', 货号: 'HYX-115', 颜色: '卡通' } },
  ]));
  const ambiguous = await resolver.resolveProduct({ itemNo: 'HYX-115', color: '卡', matchMode: 'sales' });
  assert.equal(ambiguous.needsColor, true);
  assert.ok(ambiguous.options.length >= 2, '「卡」同时命中多个颜色时应把候选都列出来');
  const duplicate = new V1ReferenceResolver(makeGateway([
    ...salesProducts,
    { record_id: 'rec_hyx_duplicate', fields: { 编号: 'HYX-115|卡其|B', 货号: 'HYX-115', 颜色: '卡其' } },
  ]));
  const duplicated = await duplicate.resolveProduct({ itemNo: 'HYX-115', color: '卡其', matchMode: 'sales' });
  assert.equal(duplicated.needsColor, true);
});

// ─── 真实销售原文里出现过的匹配场景（来自「销售示例」表的 bad case）───

test('sales normalizes the color suffix it splits out of a spoken SKU', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    { record_id: 'rec_black', fields: { 编号: 'XHB8095|全黑|A', 货号: 'XHB8095', 颜色: '全黑' } },
  ]));

  // AI 偶尔把颜色并进货号：XHB8095黑色。切出颜色后必须和「直接传颜色」一样归一化，
  // 否则「黑色」命中不了配置里的「全黑」，而单独写成 color=黑色 却能命中——同一个意思两条路径不一致。
  const result = await resolver.resolveProduct({ itemNo: 'XHB8095黑色', color: '', matchMode: 'sales' });
  assert.equal(result.recordId, 'rec_black');

  const sameColorPassedSeparately = await resolver.resolveProduct({
    itemNo: 'XHB8095', color: '黑色', matchMode: 'sales',
  });
  assert.equal(sameColorPassedSeparately.recordId, 'rec_black');
});

test('sales still refuses to pick a color no configured product carries', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    { record_id: 'rec_grey', fields: { 编号: '23666|灰|A', 货号: '23666', 颜色: '灰' } },
    { record_id: 'rec_black', fields: { 编号: '23666|黑|A', 货号: '23666', 颜色: '黑' } },
  ]));

  // 「灰黑」把两种颜色拼在一起，不是任何一个在售颜色：不挑一个，也不猜，交给卡片让用户选。
  const merged = await resolver.resolveProduct({ itemNo: '23666灰黑', color: '', matchMode: 'sales' });
  assert.equal(merged.needsColor, true);
  assert.equal(merged.spokenColor, '灰黑');
  assert.deepEqual(merged.options.map((option) => option.color).sort(), ['灰', '黑'].sort());
});

test('sales never resolves a misspelled product number into a different shoe', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    { record_id: 'rec_hyx', fields: { 编号: 'HYX-115|黑色|A', 货号: 'HYX-115', 颜色: '黑色' } },
    { record_id: 'rec_jxn', fields: { 编号: 'JXN-6858|黑色|B', 货号: 'JXN-6858', 颜色: '黑色' } },
    { record_id: 'rec_26632', fields: { 编号: '26632|黑色|B', 货号: '26632', 颜色: '黑色' } },
  ]));

  // 这三种都是真实发生过的写法错误：字母顺序写反、缺前缀、多打一位数字。
  // 解析器必须拒绝，绝不能猜成另一双鞋——那是记错账。
  for (const itemNo of ['HXY-115黑', '6858黑', '226632黑']) {
    await assert.rejects(
      resolver.resolveProduct({ itemNo, color: '', matchMode: 'sales' }),
      /找不到货品/,
    );
  }
});

test('sales matches a color whose base character sits at the end, like 孔雀蓝 for 蓝', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    { record_id: 'r_peacock', fields: { 编号: '149|孔雀蓝|A', 货号: '149', 颜色: '孔雀蓝' } },
  ]));

  // 颜色字在后（孔雀蓝、灰紫、荧光绿、白雾蓝）以前完全匹配不到，用户只能报全名。
  const result = await resolver.resolveProduct({ itemNo: '149', color: '蓝', matchMode: 'sales' });
  assert.equal(result.recordId, 'r_peacock');
});

test('sales resolves 烟灰 and 枪紫 from the base characters inside the same SKU', async () => {
  const records = [
    { record_id: 'r_smoke', fields: { 编号: '5801-73|烟灰|B', 货号: '5801-73', 颜色: '烟灰' } },
    { record_id: 'r_gun', fields: { 编号: '5801-73|枪紫|B', 货号: '5801-73', 颜色: '枪紫' } },
  ];
  const grey = await new V1ReferenceResolver(makeGateway(records))
    .resolveProduct({ itemNo: '5801-73', color: '灰', matchMode: 'sales' });
  const purple = await new V1ReferenceResolver(makeGateway(records))
    .resolveProduct({ itemNo: '5801-73', color: '紫', matchMode: 'sales' });

  assert.equal(grey.recordId, 'r_smoke');
  assert.equal(purple.recordId, 'r_gun');
});

test('sales hands the SKU color options to the card when the base characters match several colors', async () => {
  const resolver = new V1ReferenceResolver(makeGateway([
    { record_id: 'r_grey', fields: { 编号: '8035|灰牛仔|A', 货号: '8035', 颜色: '灰牛仔' } },
    { record_id: 'r_black', fields: { 编号: '8035|黑牛仔|A', 货号: '8035', 颜色: '黑牛仔' } },
    { record_id: 'r_mi', fields: { 编号: '8035|米牛仔|A', 货号: '8035', 颜色: '米牛仔' } },
  ]));

  // 三个颜色都沾「牛仔」，不靠限定词白名单去猜，而是把三个候选交给卡片。
  const ambiguous = await resolver.resolveProduct({ itemNo: '8035', color: '牛仔', matchMode: 'sales' });
  assert.equal(ambiguous.needsColor, true);
  assert.deepEqual(ambiguous.options.map((option) => option.color).sort(),
    ['灰牛仔', '米牛仔', '黑牛仔'].sort());
});
