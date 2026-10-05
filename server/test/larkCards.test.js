const test = require('node:test');
const assert = require('node:assert/strict');
const {
  salesConfirmationCard,
  purchaseRequestConfirmationCard,
  purchaseArrivalDetailCard,
  purchaseStatusCard,
  sampleReplacementCard,
  keepOnlyCardButton,
} = require('../src/utils/larkCards');

// 这一组测试锁的是「移动端实测确认过的排版」，不是实现细节：
// 多按钮必须用 column_set（action 在手机上会堆成多行），销售确认卡片必须分字号层级。
// 详见 src/utils/larkCards.js 里 buttonColumns / salesConfirmationCard 的注释。

// 卡片里所有 column_set 按钮（按出现顺序）。
const columnSetButtons = (card) => card.elements
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => element.columns.flatMap((column) => column.elements))
  .filter((child) => child.tag === 'button');

// 卡片里遗留的 action 按钮（多按钮卡片应越来越少见）。
const actionButtons = (card) => card.elements
  .filter((element) => element.tag === 'action')
  .flatMap((element) => element.actions);

// 每个「按钮行」放几个按钮——用来断言"一行最多 3 个"。
const buttonRowWidths = (card) => card.elements
  .filter((element) => element.tag === 'column_set')
  .map((element) => element.columns
    .filter((column) => column.elements.some((child) => child.tag === 'button')).length)
  .filter((width) => width > 0);

// 按钮行的列必须均分（weight: 1），且列里只放一个按钮。
const assertButtonRowsAreEqualWeight = (card) => {
  for (const element of card.elements.filter((item) => item.tag === 'column_set')) {
    if (!element.columns.some((column) => column.elements.some((child) => child.tag === 'button'))) continue;
    assert.equal(element.flex_mode, 'none');
    assert.equal(element.horizontal_spacing, '8px');
    for (const column of element.columns) {
      assert.equal(column.width, 'weighted');
      assert.equal(column.weight, 1);
      assert.equal(column.elements.length, 1, '每列只放一个按钮');
      assert.equal(column.elements[0].tag, 'button');
    }
  }
};

const saleDraft = (overrides = {}) => ({
  items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99 }],
  agreed_total: 99,
  payments: [{ method: '微信', amount: 99 }],
  trade_type: '现货',
  delivery_status: '已交付',
  ...overrides,
});

const sampleSizes = (sizes) => sizes.map((size) =>
  ({ size, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 }));

// —— 问题 1：多按钮一律 column_set ——

test('销售确认卡片：确认/修改/取消用 column_set 一行三列，不再用 action', () => {
  const card = salesConfirmationCard('draft_1', saleDraft());
  assert.deepEqual(actionButtons(card), [], '多按钮不应再有 action 元素（手机端会堆成多行）');
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content), ['确认', '修改', '取消']);
  assert.deepEqual(buttonRowWidths(card), [3]);
  assertButtonRowsAreEqualWeight(card);
});

test('销售确认卡片：颜色候选用 column_set（不再用 action）', () => {
  const colorOptions = ['黑', '白', '红'].map((color, index) =>
    ({ color, recordId: `color_${index}`, number: '66356' }));
  const card = salesConfirmationCard('draft_1', saleDraft({
    items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99,
      needs_color: true, color_options: colorOptions }],
  }));
  assert.deepEqual(actionButtons(card), []);
  assert.deepEqual(columnSetButtons(card).filter((button) => button.value.action === 'choose_sale_color')
    .map((button) => button.text.content), ['黑', '白', '红']);
  assert.deepEqual(buttonRowWidths(card), [3, 3]);
  assertButtonRowsAreEqualWeight(card);
});

test('销售确认卡片：样品补门盒候选用 column_set（不再用 action）', () => {
  const card = salesConfirmationCard('draft_1', saleDraft({
    items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99, uses_sample: true,
      sample_replacement_options: sampleSizes([40, 41]) }],
  }));
  assert.deepEqual(actionButtons(card), []);
  assert.deepEqual(columnSetButtons(card)
    .filter((button) => button.value.action === 'choose_sale_sample_replacement')
    .map((button) => button.text.content), ['选 40码', '选 41码']);
  assert.deepEqual(buttonRowWidths(card), [2, 3]);
  assertButtonRowsAreEqualWeight(card);
});

test('采购申请确认卡片：确认/取消用 column_set，不再用 action', () => {
  const card = purchaseRequestConfirmationCard('draft_1', {
    items: [{ item_no: 'A100', color: '黑', size: 40, quantity: 2 }],
  });
  assert.deepEqual(actionButtons(card), []);
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content),
    ['确认生成采购申请', '取消']);
  assert.deepEqual(buttonRowWidths(card), [2]);
  assertButtonRowsAreEqualWeight(card);
});

test('采购到货明细卡片：确认/取消用 column_set，不再用 action', () => {
  const card = purchaseArrivalDetailCard('draft_1', { batch_no: 'BATCH-1', actual: [] });
  assert.deepEqual(actionButtons(card), []);
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content), ['确认入库', '取消']);
  // 鞋盒总数那块 column_set 只有文字，不算按钮行。
  assert.deepEqual(buttonRowWidths(card), [2]);
  assertButtonRowsAreEqualWeight(card);
});

// 差异卡片已按产品负责人要求删除（未来架构：到货在采购申请基础上修改，不再比对差异），
// 这里只钉住"明细卡片上不会出现差异文案"。
test('采购到货明细卡片不再展示任何差异信息', () => {
  const card = purchaseArrivalDetailCard('draft_1', {
    batch_no: 'BATCH-1',
    actual: [{ item_no: '8088', color: '灰', size: 36, quantity: 1, product_number: '8088灰' }],
  });
  const cardText = JSON.stringify(card);
  assert.ok(!cardText.includes('差异'), `卡片不应再出现差异文案：${cardText}`);
  assert.ok(!cardText.includes('实到'), `卡片不应再出现「申请/实到」对比：${cardText}`);
});

test('采购到货明细卡片：货号+颜色命中多条时标注「匹配到 N 条，已取 XXX」', () => {
  const card = purchaseArrivalDetailCard('draft_1', {
    batch_no: 'BATCH-1',
    actual: [{
      item_no: '8088-26', color: '棕', size: 36, quantity: 1, product_number: '8088-26棕女鞋',
      ambiguous_match: { count: 2, color: '棕', number: '8088-26棕女鞋' },
    }],
  });
  const cardText = JSON.stringify(card);
  assert.ok(cardText.includes('匹配到 2 条'), `要写清匹配到几条：${cardText}`);
  assert.ok(cardText.includes('已取 8088-26棕女鞋'), `要写清取了哪条：${cardText}`);
});

test('样品补选卡片：候选尺码用 column_set；单个「刷新」保持 action', () => {
  const card = sampleReplacementCard('task_1', {
    productNumber: 'A100', remainingSizes: sampleSizes([40, 41, 42]),
  });
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content),
    ['选 40 码', '选 41 码', '选 42 码']);
  assert.deepEqual(buttonRowWidths(card), [3]);
  // 单个按钮没有换行问题，刻意保持 action 元素。
  assert.deepEqual(actionButtons(card).map((button) => button.text.content), ['刷新可选尺码']);
  assertButtonRowsAreEqualWeight(card);
});

test('按钮超过 3 个：折成多个 column_set，每行都不超过 3 个', () => {
  const colorOptions = ['黑', '白', '红', '蓝', '绿'].map((color, index) =>
    ({ color, recordId: `color_${index}`, number: '66356' }));
  const card = salesConfirmationCard('draft_1', saleDraft({
    items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99,
      needs_color: true, color_options: colorOptions }],
  }));
  // 颜色 5 个 → 3 + 2；再加上确认/修改/取消那一行 3 个。
  assert.deepEqual(buttonRowWidths(card), [3, 2, 3]);
  for (const width of buttonRowWidths(card)) {
    assert.ok(width <= 3, `手机一行最多放 3 个按钮，实际放了 ${width} 个`);
  }
  assertButtonRowsAreEqualWeight(card);
});

test('样品补选卡片：候选尺码超过 3 个也折成多个 column_set', () => {
  const card = sampleReplacementCard('task_1', {
    productNumber: 'A100', remainingSizes: sampleSizes([40, 41, 42, 43, 44]),
  });
  assert.deepEqual(buttonRowWidths(card), [3, 2]);
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content),
    ['选 40 码', '选 41 码', '选 42 码', '选 43 码', '选 44 码']);
  assertButtonRowsAreEqualWeight(card);
});

// —— 问题 2：销售确认卡片的字号层级（V3） ——

test('销售确认卡片：明细行是 heading 大字', () => {
  const card = salesConfirmationCard('draft_1', saleDraft());
  const detail = card.elements[0];
  assert.equal(detail.tag, 'div', 'markdown 元素不能自定义字号，必须用 div + lark_md');
  assert.equal(detail.text.tag, 'lark_md');
  assert.equal(detail.text.text_size, 'heading');
});

test('销售确认卡片：成交/收款行与交易类型行是 heading 且不加粗（内容不含 **）', () => {
  const card = salesConfirmationCard('draft_1', saleDraft());
  const headings = card.elements
    .filter((element) => element.tag === 'div' && element.text?.text_size === 'heading');
  assert.equal(headings.length, 3, '明细、成交/收款、交易类型三行是 heading');
  // [0] 明细行、[1] 成交/收款行、[2] 交易类型行
  assert.match(headings[1].text.content, /^成交总额 ￥99/);
  assert.match(headings[1].text.content, /本次已收 微信 ￥99/);
  assert.doesNotMatch(headings[1].text.content, /\*\*/, '大字已经够重，再加粗在手机上会糊');
  assert.match(headings[2].text.content, /^交易类型：现货 · 已交付$/);
  assert.doesNotMatch(headings[2].text.content, /\*\*/, '大字已经够重，再加粗在手机上会糊');
});

test('销售确认卡片：补货品信息是 note 小字（层级最低）', () => {
  const card = salesConfirmationCard('draft_1', saleDraft({
    product_info_gaps: [{ label: '66356米', missing: ['成本'], url: 'https://example.com/product/1' }],
  }));
  const notes = card.elements.filter((element) => element.tag === 'div' && element.text?.text_size === 'note');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text.content, /补货品信息/);
  assert.match(notes[0].text.content, /66356米.*还差：成本/);
});

test('销售确认卡片：颜色选择/补样品提示也是 note 小字', () => {
  const card = salesConfirmationCard('draft_1', saleDraft({
    items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99, needs_color: true,
      color_options: [{ color: '黑', recordId: 'color_0', number: '66356' }] }],
  }));
  const notes = card.elements.filter((element) => element.tag === 'div' && element.text?.text_size === 'note');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text.content, /请选择颜色/);
});

test('销售确认卡片：单件不显示金额（下一行就是成交总额，重复）', () => {
  const card = salesConfirmationCard('draft_1', saleDraft());
  assert.equal(card.elements[0].text.content, '1. 66356 42码 × 1');
});

test('销售确认卡片：一单超过一件时必须逐件显示金额（否则她无法逐件核对）', () => {
  const card = salesConfirmationCard('draft_1', saleDraft({
    items: [
      { item_no: '66356', size: 42, quantity: 1, actual_amount: 99 },
      { item_no: '66357', size: 40, quantity: 1, actual_amount: 128 },
    ],
    agreed_total: 227,
  }));
  const content = card.elements[0].text.content;
  assert.match(content, /1\. 66356 42码 × 1 ￥99/);
  assert.match(content, /2\. 66357 40码 × 1 ￥128/);
});

// —— 重试卡片：只收窄"含目标按钮"的那一组 ——

test('重试卡片：只留确认按钮，颜色/补样品选择组原样保留', () => {
  const colorOptions = ['黑', '白'].map((color, index) =>
    ({ color, recordId: `color_${index}`, number: '66356' }));
  const card = salesConfirmationCard('draft_1', saleDraft({
    items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99,
      needs_color: true, color_options: colorOptions }],
  }));
  keepOnlyCardButton(card, 'confirm_sale');
  assert.deepEqual(columnSetButtons(card).map((button) => button.value.action),
    ['choose_sale_color', 'choose_sale_color', 'confirm_sale']);
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content),
    ['黑', '白', '确认']);
});

// —— 到货确认卡：尺码网格每行 6 个 + 货号 → 颜色 → 尺码 三层分组 ——
//
// 锁的是产品负责人 2026-10-05 提的两条：
//   1. 尺码网格每行至少 6 个（现在是 6，超过换行，且每行都恰好 6 列）；
//   2. 明细先按货号、再按颜色、颜色下面是尺码，顺序稳定。
// 6 列 / 短文本 / column_set 都有移动端实测依据，见 src/utils/larkCards.js 的注释。

// 尺码网格行：6 列的 column_set（其它 column_set 是"鞋盒总数"3 列和按钮行 2 列）。
const sizeGridRows = (card) => card.elements
  .filter((element) => element.tag === 'column_set')
  .filter((element) => element.columns.length === 6)
  .map((element) => element.columns.map((column) => column.elements[0].content));

const markdownLines = (card) => card.elements
  .filter((element) => element.tag === 'markdown')
  .map((element) => element.content);

// 把卡片读成「分组骨架」：[货号:X, 颜色:Y, 尺码:36,37, ...]。
// 只关心排版结构，不关心每个格子里的数量/价格。
// ⚠️ 用 alternation 而不是字符类：🏷 是增补平面字符，塞进 [...] 只会匹配到半个代理对。
const ITEM_NO_HEADING = /^\*\*(?:🏷️?|⚠️?)/u;
const groupingSkeleton = (card) => {
  const layout = [];
  for (const element of card.elements) {
    if (element.tag === 'markdown' && ITEM_NO_HEADING.test(element.content)) {
      layout.push(`货号:${element.content.replace(/^\*\*(?:🏷️?|⚠️?)\s*/u, '').replace(/\*\*$/, '')}`);
      continue;
    }
    if (element.tag === 'markdown' && element.content.startsWith('▸ ')) {
      layout.push(`颜色:${element.content.slice(2)}`);
      continue;
    }
    if (element.tag === 'column_set' && element.columns.length === 6) {
      const sizes = element.columns
        .map((column) => column.elements[0].content)
        .filter((content) => content.trim() !== '')
        .map((content) => content.match(/\*\*(\d+)\*\*/)[1]);
      layout.push(`尺码:${sizes.join(',')}`);
    }
  }
  return layout;
};

const arrivalItem = (itemNo, color, size, quantity = 1, extra = {}) => ({
  product_record_id: `prod_${itemNo}_${color}`,
  item_no: itemNo,
  color,
  size,
  quantity,
  ...extra,
});

test('到货明细尺码网格：每行恰好 6 列，超过 6 个换行（产品负责人要求每行至少 6 个）', () => {
  const sizes = [36, 37, 38, 39, 40, 41, 42, 43];
  const card = purchaseArrivalDetailCard('draft_grid', {
    batch_no: 'BATCH-1',
    actual: sizes.map((size) => arrivalItem('1366-31', '棕色', size)),
  });
  const rows = sizeGridRows(card);
  assert.equal(rows.length, 2, '8 个尺码要折成 2 行');
  for (const row of rows) {
    assert.equal(row.length, 6, '每一行都必须是 6 列：不足要补空列，否则最后一行在手机上宽度对不齐');
  }
  assert.deepEqual(rows[0], ['**36**\n×1', '**37**\n×1', '**38**\n×1', '**39**\n×1', '**40**\n×1', '**41**\n×1']);
  assert.deepEqual(rows[1].slice(0, 2), ['**42**\n×1', '**43**\n×1']);
  assert.deepEqual(rows[1].slice(2), [' ', ' ', ' ', ' '], '第二行只剩 2 个尺码，补 4 个空列');
  // 尺码网格是纯文字 column_set，绝不能退化成 action（action 在手机上会竖向堆叠）。
  assert.deepEqual(actionButtons(card), []);
});

test('到货明细尺码格：用「尺码 + ×数量」短文本，不写会撑破 6 列格子的「码」字', () => {
  const card = purchaseArrivalDetailCard('draft_cell', {
    batch_no: 'BATCH-1',
    actual: [arrivalItem('1366-31', '棕色', 37, 2, { unit_cost: 199 })],
  });
  const row = sizeGridRows(card)[0];
  assert.equal(row[0], '**37**\n×2\n￥199');
  assert.doesNotMatch(row[0], /码/, '6 列下「37码 × 2」会换行撑破格子（移动端实测），别改回长写法');
  // 只有 1 个尺码也要 6 列
  assert.equal(row.length, 6);
});

test('到货明细分组：货号 → 颜色 → 尺码，各组按字典序稳定排序、内容正确归位', () => {
  const draft = {
    batch_no: 'BATCH-1',
    actual: [
      arrivalItem('B200', '白', 39),
      arrivalItem('A100', '黑', 40),
      arrivalItem('B200', '白', 38),
      arrivalItem('A100', '黑', 38),
      arrivalItem('A100', '红', 41),
      arrivalItem('A100', '红', 40),
    ],
  };
  const card = purchaseArrivalDetailCard('draft_group', draft);
  assert.deepEqual(groupingSkeleton(card), [
    '货号:A100',
    '颜色:红',
    '尺码:40,41',
    '颜色:黑',
    '尺码:38,40',
    '货号:B200',
    '颜色:白',
    '尺码:38,39',
  ]);
  // 同一份输入渲染两次，顺序必须完全一样（不能跟着模型返回的顺序跳）。
  const again = purchaseArrivalDetailCard('draft_group', {
    batch_no: 'BATCH-1',
    actual: [...draft.actual].reverse(),
  });
  assert.deepEqual(groupingSkeleton(again), groupingSkeleton(card), '分组顺序必须与输入顺序无关');
});

test('到货明细分组：没匹配到货品表的货号标 ⚠️；单据上没颜色就不编一个颜色标题', () => {
  const card = purchaseArrivalDetailCard('draft_colorless', {
    batch_no: 'BATCH-1',
    actual: [
      { product_record_id: '', item_no: 'A100', color: '', size: 38, quantity: 1 },
    ],
  });
  const lines = markdownLines(card);
  assert.ok(lines.some((line) => line.includes('⚠️') && line.includes('A100')), '未匹配的货号要用 ⚠️ 标出来');
  assert.equal(lines.filter((line) => line.startsWith('▸ ')).length, 0, '没有颜色就不要写颜色小标题');
  assert.deepEqual(sizeGridRows(card), [['**38**\n×1', ' ', ' ', ' ', ' ', ' ']]);
});

test('采购申请确认卡片：供应商分组保留，供应商内也是 货号 → 颜色 → 尺码', () => {
  const card = purchaseRequestConfirmationCard('draft_supplier', {
    items: [
      { item_no: 'A1', color: '黑', size: 40, quantity: 1, supplier: '金猴' },
      { item_no: 'A1', color: '黑', size: 41, quantity: 1, supplier: '金猴' },
      { item_no: 'B1', color: '白', size: 38, quantity: 1, supplier: '奥康' },
    ],
  });
  const lines = markdownLines(card);
  assert.ok(lines.some((line) => line.includes('供应商：金猴')), '非批量卡片仍要按供应商分区');
  assert.ok(lines.some((line) => line.includes('供应商：奥康')));
  assert.deepEqual(groupingSkeleton(card), [
    '货号:A1', '颜色:黑', '尺码:40,41',
    '货号:B1', '颜色:白', '尺码:38',
  ]);
});

// —— 采购到货：新品（货号级）与「发完卡片之后才建档」的卡片约定 ——
//
// 产品负责人 2026-10-05 的四条决定：删掉独立的新品段 / 新品按**货号级**标在明细里 /
// 卡片上不写"还差什么字段" / 建档挪到发完卡片之后（链接只给确认之后的结果卡片）。

test('到货明细卡片：不再有独立的「🆕 有 N 个新品」那段（清单/颜色/缺口/链接一律不出现）', () => {
  const card = purchaseArrivalDetailCard('draft_new_section', {
    batch_no: 'BATCH-1',
    actual: [{ item_no: '6035', color: '黑', size: 36, quantity: 1, created_product: true }],
    // 把旧那段要用的字段全部塞进来：卡片必须一个都不显示（这是删段的回归护栏）。
    created_products: [{
      product_record_id: 'rec_1',
      item_no: '6035',
      color: '黑',
      label: '6035黑',
      supplier: '一代千金',
      color_created: true,
      missing: ['成本'],
      missing_sample_image: true,
      completeness_readable: true,
      url: 'https://example.feishu.cn/base/app_token?table=tbl_1&record=rec_1',
    }],
    created_colors: ['香芋紫'],
  });
  const cardText = JSON.stringify(card.elements);
  for (const gone of [
    '还差', '点记录去补', '资料已经齐了', '颜色表原本没有', '我给你加了一条',
    '香芋紫', '一代千金', 'record=rec_1',
  ]) {
    assert.ok(!cardText.includes(gone), `独立新品段已整体删除，不该再出现「${gone}」：${cardText}`);
  }
  assert.ok(cardText.includes('已建好基础资料'), `只留一句「已建好」的结论：${cardText}`);
});

test('到货明细卡片：新品按货号级标一次（多行/多颜色不重复），颜色级不标', () => {
  const card = purchaseArrivalDetailCard('draft_new_item', {
    batch_no: 'BATCH-1',
    actual: [
      // 同一货号：两个颜色、三个尺码，全部是新品 → 只在货号标题上标一次。
      { item_no: '6035', color: '黑', size: 36, quantity: 1, created_product: true },
      { item_no: '6035', color: '黑', size: 37, quantity: 1, created_product: true },
      { item_no: '6035', color: '白', size: 36, quantity: 1, created_product: true },
      // 该货号只有一行是新品（另一行已匹配上老货品）→ 货号照标一次。
      { item_no: '6036', color: '灰', size: 36, quantity: 1, product_record_id: 'prod_6036' },
      { item_no: '6036', color: '黑', size: 36, quantity: 1, created_product: true },
      // 老货品不带 🆕。
      { item_no: '8088', color: '灰', size: 36, quantity: 1, product_record_id: 'prod_8088' },
    ],
  });
  const lines = markdownLines(card);
  // 只取货号标题上的标记：那句「🆕 本批有 N 个新品…」是 ③ 的结论句，不属于"标题重复标"。
  const marked = lines.filter((line) => line.includes('🆕 新品'));
  assert.deepEqual(marked, ['**🏷 6035 · 🆕 新品**', '**🏷 6036 · 🆕 新品**'],
    `🆕 是货号级判断，一个货号只标一次：${JSON.stringify(marked)}`);
  // 新品在发卡片时还没建档（没有 product_record_id），但它不是"没匹配上"，仍然用 🏷 而不是 ⚠️。
  assert.ok(!marked.some((line) => line.includes('⚠️')), '待建档的新品不是"未匹配"，不能标 ⚠️');
  assert.ok(lines.includes('**🏷 8088**'), '老货品不带 🆕');
  // 颜色行只有颜色本身，不夹带新品标记。
  const colors = lines.filter((line) => line.startsWith('▸ '));
  assert.ok(colors.length > 0);
  assert.ok(colors.every((line) => !line.includes('🆕')), '新品不细到颜色：颜色级不能标 🆕');
});

test('到货结果卡片：确认之后给创建好的链接；正在建档/建档失败都要说话', () => {
  const created = [{
    product_record_id: 'rec_1',
    item_no: '6035',
    color: '黑',
    label: '6035黑',
    url: 'https://example.feishu.cn/base/app_token?table=tbl_1&record=rec_1',
  }];
  const done = purchaseStatusCard(
    { actual: [], created_products: created, creation_state: 'done' },
    '采购到货已入库', '入库完成，库存已更新。', 'green', { showNewProducts: true },
  );
  const doneText = JSON.stringify(done.elements);
  assert.ok(doneText.includes('record=rec_1'), `结果卡片要给到创建好的链接：${doneText}`);
  assert.ok(doneText.includes('已建好'), `结果卡片要说清已建好：${doneText}`);

  const pending = purchaseStatusCard(
    { actual: [], created_products: [], pending_creation: [{ item_no: '6035', color: '黑' }], creation_state: 'pending' },
    '采购到货已入库', '入库完成，库存已更新。', 'green', { showNewProducts: true },
  );
  // 产品负责人定死的原话（照抄，别改措辞）。
  assert.ok(JSON.stringify(pending.elements).includes('正在入库，如有新品，稍后把链接给你'),
    '还没跑完要按她定的那句话明说，不能静默');

  const failed = purchaseStatusCard(
    {
      actual: [], created_products: [], pending_creation: [{ item_no: '6035', color: '黑' }],
      creation_state: 'failed', creation_error: '模拟建档失败',
    },
    '采购到货未完成', '已停止自动处理：模拟建档失败', 'red', { showNewProducts: true },
  );
  const failedText = JSON.stringify(failed.elements);
  assert.ok(failedText.includes('模拟建档失败'), `建档失败要告诉她原因：${failedText}`);
  assert.ok(failedText.includes('再点一次'), '要告诉她可以重试，不能卡死');

  // 其他状态卡片（处理中/已取消/采购申请）没到给链接的时候，不能夹带新品块。
  const plain = purchaseStatusCard(
    { actual: [], created_products: created, creation_state: 'done' },
    '采购到货已取消', '用户已取消本次采购到货。', 'grey',
  );
  assert.ok(!JSON.stringify(plain.elements).includes('record=rec_1'), '没开开关的状态卡不给链接');
});
