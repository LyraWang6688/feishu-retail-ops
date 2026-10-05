const test = require('node:test');
const assert = require('node:assert/strict');
const { saleLookupCard } = require('../src/utils/larkCards');

// 这一组测试锁的是「产品负责人定的交互」：卡片**只展示、没有任何按钮**。
// 任何人在卡片里加 button / action / column_set（可能藏按钮）都会在这里挂掉。

// 递归找卡片里所有元素 tag，用来断言"没有交互元素"。
const collectTags = (node, tags = []) => {
  if (Array.isArray(node)) {
    for (const item of node) collectTags(item, tags);
    return tags;
  }
  if (node && typeof node === 'object') {
    if (typeof node.tag === 'string') tags.push(node.tag);
    for (const value of Object.values(node)) collectTags(value, tags);
  }
  return tags;
};

const allTags = (card) => collectTags(card);
const lineText = (card) => card.elements[0].text.content;

const candidate = (overrides = {}) => ({
  record_id: 'rec_1',
  date: '2026-10-03',
  item_no: '6035',
  color: '黑',
  size: 38,
  actual_amount: 230,
  sales_order_no: 'XSD-20261003-0001',
  ...overrides,
});

test('销售记录卡片：一条候选也列出来，带序号和四个字段', () => {
  const card = saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates: [candidate()] });
  assert.equal(card.header.title.content, '最近 5 天的销售记录');
  assert.equal(lineText(card), '1. 2026-10-03 · 6035黑 · 38码 · ￥230');
  // 一条时不要提示"回我第 2 笔"这种对不上的话。
  assert.match(card.elements[1].elements[0].content, /只有这 1 笔/);
});

test('销售记录卡片：多条按传入顺序编号，顺序就是 task.pending_candidates 的顺序', () => {
  const candidates = [
    candidate({ record_id: 'rec_2', date: '2026-10-04', size: 39 }),
    candidate({ record_id: 'rec_1', date: '2026-10-03', size: 38 }),
  ];
  const card = saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates });
  const lines = lineText(card).split('\n');
  assert.deepEqual(lines, [
    '1. 2026-10-04 · 6035黑 · 39码 · ￥230',
    '2. 2026-10-03 · 6035黑 · 38码 · ￥230',
  ]);
  assert.match(card.elements[1].elements[0].content, /共 2 笔/);
});

test('销售记录卡片：0 条时说明没查到，并给出"哪天买的"的出路', () => {
  const card = saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates: [] });
  assert.equal(card.header.title.content, '最近 5 天的销售记录');
  assert.equal(lineText(card), '5 天内没查到 6035黑 的销售记录。\n你记得大概是哪天买的吗？');
});

test('销售记录卡片：任何情况下都没有按钮 / action / column_set 交互元素', () => {
  const cards = [
    saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates: [candidate()] }),
    saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates: [candidate(), candidate({ record_id: 'rec_2' })] }),
    saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates: [] }),
  ];
  for (const card of cards) {
    const tags = allTags(card);
    assert.equal(tags.includes('button'), false, '卡片不能有按钮');
    assert.equal(tags.includes('action'), false, '卡片不能有 action 元素');
    assert.equal(tags.includes('column_set'), false, '卡片不能有 column_set（按钮行的容器）');
    // 卡片结构里也不该出现任何 action 字段（老式按钮的 value.action）。
    assert.equal(JSON.stringify(card).includes('"action"'), false);
  }
});

test('销售记录卡片：候选行用 div + lark_md（markdown 元素不能设字号）', () => {
  const card = saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates: [candidate()] });
  assert.equal(card.elements[0].tag, 'div');
  assert.equal(card.elements[0].text.tag, 'lark_md');
  assert.equal(card.elements[0].text.text_size, 'heading');
  // 空卡片同理：字号层级不能靠 markdown 元素。
  const empty = saleLookupCard({ days: 5, itemNo: '6035', color: '黑', candidates: [] });
  assert.equal(empty.elements[0].tag, 'div');
  assert.equal(empty.elements[0].text.text_size, 'heading');
});
