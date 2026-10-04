const test = require('node:test');
const assert = require('node:assert/strict');
const {
  salesConfirmationCard,
  purchaseRequestConfirmationCard,
  purchaseArrivalComparisonCard,
  purchaseArrivalDetailCard,
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

test('采购到货差异卡片：确认/取消用 column_set，不再用 action', () => {
  const card = purchaseArrivalComparisonCard('draft_1', {
    batch_no: 'BATCH-1', differences: [],
  });
  assert.deepEqual(actionButtons(card), []);
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content), ['确认入库', '取消']);
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
