// 退换货第二期：售后卡片的**纯渲染**测试（larkCards 是纯函数，不碰任何 IO）。
//
// 锁的是产品负责人定的两条卡片坑 + 文案：
//   · markdown 元素不能设字号 → 字号必须走 div + lark_md + text_size
//   · 一行多个按钮必须走 column_set（flex_mode:none / horizontal_spacing:8px / 每列 weight 1）
//   · 钱要说人话：退现金 / 存为预存额度 / 补差价 / 不动钱
//   · 钱怎么走**没有默认值**，而且**不用卡片按钮**（业务负责人纠正：「会说的，所以不用再有
//     要卡片按钮的链路了」）—— 没解析出钱怎么走时接线层直接抛错拦住，卡片上不许出现资金按钮
//   · 赔货不回库 → 不给回库按钮

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  afterSalesConfirmationCard,
  afterSalesResultCard,
  afterSalesRetryCard,
  afterSalesStatusCard,
} = require('../src/utils/larkCards');

const candidate = (overrides = {}) => ({
  record_id: 'd_1', date: '2026-10-03', item_no: '6035', color: '黑', size: 38,
  actual_amount: 230, sales_order_no: 'XSD-20261003-0001', sales_entry_record_id: 'e_1',
  ...overrides,
});

const plan = (overrides = {}) => ({
  action: 'return',
  action_label: '退货',
  candidate: candidate(),
  new_lines: [],
  settlement: 'cash',
  diff_amount: -230,
  restock_state: '门盒',
  restock_state_explicit: false,
  requires_restock_state: true,
  ...overrides,
});

const collect = (node, out = []) => {
  if (Array.isArray(node)) { node.forEach((item) => collect(item, out)); return out; }
  if (node && typeof node === 'object') {
    out.push(node);
    Object.values(node).forEach((value) => collect(value, out));
  }
  return out;
};

const buttonsOf = (card) => collect(card)
  .filter((node) => node.tag === 'button')
  .map((node) => ({ action: node.value.action, label: node.text.content, type: node.type, extra: node.value }));

const textOf = (card) => collect(card)
  .flatMap((node) => (typeof node.content === 'string' ? [node.content] : []))
  .join('\n');

test('确认卡片：四行大字（哪一笔 / 动作 / 钱 / 退回的鞋）+ 回库按钮 + 确认取消按钮', () => {
  const card = afterSalesConfirmationCard('task_1', plan());
  assert.equal(card.header.template, 'orange');
  assert.equal(card.header.title.content, '请确认售后');
  const text = textOf(card);
  assert.match(text, /处理这一笔\n2026-10-03 · 6035黑 · 38码 · ￥230/);
  assert.match(text, /动作：退货/);
  assert.match(text, /钱：退现金/);
  assert.match(text, /差价：￥230（退给她）/);
  assert.match(text, /退回的鞋放：门盒（默认，可在下面改）/);
  assert.deepEqual(buttonsOf(card).map((button) => [button.action, button.label]), [
    ['choose_after_sales_restock', '门盒（已选）'],
    ['choose_after_sales_restock', '样品'],
    ['confirm_after_sales', '确认'],
    ['cancel_after_sales', '取消'],
  ]);
});

test('确认卡片：字号只走 div + lark_md；按钮行只走 column_set（手机不竖排）', () => {
  const card = afterSalesConfirmationCard('task_1', plan());
  for (const node of collect(card)) {
    if (node.tag === 'markdown') assert.equal('text_size' in node, false, 'markdown 元素不能设字号');
    if ('text_size' in node) {
      // text_size 只能出现在 div 的 lark_md 文本节点上
      assert.equal(node.tag, 'lark_md');
      assert.equal(['heading', 'normal', 'note'].includes(node.text_size), true);
    }
  }
  for (const element of card.elements) {
    if (element.tag !== 'div') continue;
    assert.equal(element.text.tag, 'lark_md');
    assert.equal('text_size' in element.text, true);
  }
  const rows = card.elements.filter((element) => element.tag === 'column_set');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.flex_mode, 'none');
    assert.equal(row.horizontal_spacing, '8px');
    assert.deepEqual(row.columns.map((column) => [column.width, column.weight]),
      row.columns.map(() => ['weighted', 1]));
  }
});

test('确认卡片：钱怎么说人话（退现金 / 存预存 / 补差价 / 不动钱）', () => {
  const cash = textOf(afterSalesConfirmationCard('t', plan()));
  assert.match(cash, /钱：退现金/);
  assert.match(cash, /差价：￥230（退给她）/);

  const prepaid = textOf(afterSalesConfirmationCard('t', plan({ settlement: 'prepaid' })));
  assert.match(prepaid, /钱：存为预存额度/);

  const topUp = textOf(afterSalesConfirmationCard('t', plan({ diff_amount: 70 })));
  assert.match(topUp, /钱：收现金/);
  assert.match(topUp, /差价：￥70（她补）/);

  const free = textOf(afterSalesConfirmationCard('t', plan({ settlement: null, diff_amount: 0 })));
  assert.match(free, /钱：不动钱/);
  assert.match(free, /差价：￥0/);

  // 要动钱但钱还没说定：**不能**写成"不动钱"（那会让人以为这笔不动账）
  const pending = textOf(afterSalesConfirmationCard('t', plan({ settlement: null, requires_settlement: true })));
  assert.match(pending, /钱：还没定/);
  assert.equal(pending.includes('钱：不动钱'), false);
});

// 业务负责人 2026-10-05 的纠正：「会说的，所以不用再有要卡片按钮的链路了」。
// 这组按钮**整条链路**都不许回来——她说了什么就写什么，她没说就由接线层回一句文字问她。
test('确认卡片：**没有**资金选择按钮（纠正后不许加回来）', () => {
  const cases = [
    ['她没说、要动钱', { settlement: null, requires_settlement: true }],
    ['她说了退现金', { settlement: 'cash', requires_settlement: false }],
    ['她说了存预存', { settlement: 'prepaid', requires_settlement: false }],
    ['差价 0 不动钱', { settlement: null, diff_amount: 0, requires_settlement: false }],
  ];
  for (const [label, overrides] of cases) {
    const card = afterSalesConfirmationCard('t', plan(overrides));
    assert.deepEqual(
      buttonsOf(card).filter((button) => button.action === 'choose_after_sales_settlement'), [],
      `${label}：卡片上不应有资金选择按钮`,
    );
    assert.deepEqual(
      buttonsOf(card).filter((button) => button.extra?.settlement !== undefined), [],
      `${label}：卡片上不应有任何带 settlement 的按钮`,
    );
    // 整张卡片里连这个动作名都不该出现（防止换个写法又溜回来）
    assert.equal(JSON.stringify(card).includes('choose_after_sales_settlement'), false);
    assert.equal(JSON.stringify(card).includes('settlement'), false);
  }
  // 差价 0 仍然如实写「不动钱」，她说了什么就写什么
  assert.match(textOf(afterSalesConfirmationCard('t', plan({ settlement: null, diff_amount: 0 }))), /钱：不动钱/);
  assert.match(textOf(afterSalesConfirmationCard('t', plan({ settlement: 'prepaid' }))), /钱：存为预存额度/);
});

test('确认卡片：确认 / 取消 / 回库按钮照旧（钱那块不参与）', () => {
  const card = afterSalesConfirmationCard('t', plan({ settlement: 'cash' }));
  assert.deepEqual(buttonsOf(card).map((button) => [button.action, button.label]), [
    ['choose_after_sales_restock', '门盒（已选）'],
    ['choose_after_sales_restock', '样品'],
    ['confirm_after_sales', '确认'],
    ['cancel_after_sales', '取消'],
  ]);
});

test('确认卡片：她说了回库状态就按她说的写，不给"默认"字样', () => {
  const card = afterSalesConfirmationCard('t', plan({ restock_state: '样品', restock_state_explicit: true }));
  assert.match(textOf(card), /退回的鞋放：样品/);
  assert.equal(textOf(card).includes('默认'), false);
});

test('确认卡片：赔货不回库、没有回库按钮；换货把"换成什么"写清楚', () => {
  const compensation = afterSalesConfirmationCard('t', plan({
    action: 'compensation', action_label: '赔货', requires_restock_state: false,
    restock_state: null, settlement: null, diff_amount: 0,
    new_lines: [{ productId: 'p2', sizeId: 'size_40', amount: 300, label: '1366-33黑 40码' }],
  }));
  assert.match(textOf(compensation), /动作：赔货（换成 1366-33黑 40码）/);
  assert.match(textOf(compensation), /退回的鞋放：不回库/);
  assert.deepEqual(buttonsOf(compensation).map((button) => button.action),
    ['confirm_after_sales', 'cancel_after_sales']);

  const exchange = afterSalesConfirmationCard('t', plan({
    action: 'exchange', action_label: '换货', diff_amount: 70,
    new_lines: [{ productId: 'p2', sizeId: 'size_40', amount: 300, label: '1366-33黑 40码' }],
  }));
  assert.match(textOf(exchange), /动作：换货（换成 1366-33黑 40码）/);
});

test('确认卡片：出货货品在货品表命中多条时要看得见', () => {
  const card = afterSalesConfirmationCard('t', plan({
    action: 'exchange', action_label: '换货', diff_amount: 70,
    new_lines: [{ productId: 'p2', sizeId: 'size_40', amount: 300, label: '1366-33黑 40码', ambiguous_count: 2 }],
  }));
  assert.match(textOf(card), /匹配到多条/);
});

test('结果卡片：说清写了什么（明细 / 钱 / 库存）', () => {
  const card = afterSalesResultCard(plan(), {
    masterRecordId: 'rec_1', detailRecordIds: ['rec_2'],
    money: { route: 'cash', direction: '退回', amount: 230 },
    stock: [{ behaviorCode: 'SALE_RETURN', state: '门盒', quantity: 1 }],
  });
  assert.equal(card.header.template, 'green');
  assert.equal(card.header.title.content, '退货已完成');
  const text = textOf(card);
  assert.match(text, /已写入\n明细 1 条\n收款明细 1 笔（退回 ￥230）\n库存：退回入库 门盒 ×1/);

  // 不动钱 / 库存未变（配品）也要如实写，而不是写"收款 0 笔"糊过去
  const free = afterSalesResultCard(plan({ settlement: null, diff_amount: 0 }), {
    detailRecordIds: ['rec_3'], money: { route: 'none' }, stock: [],
  });
  assert.match(textOf(free), /没动钱/);
  assert.match(textOf(free), /库存未变/);

  // 预存走的是「客户往来货款」，不是收款明细
  const prepaid = afterSalesResultCard(plan({ settlement: 'prepaid' }), {
    detailRecordIds: ['rec_4'],
    money: { route: 'prepaid', direction: '要退', amount: 230, changeType: '退货退款' },
    stock: [],
  });
  assert.match(textOf(prepaid), /客户往来货款 1 笔（退货退款 ￥230）/);

  // ⭐ 2026-10-08 退货口径：钱**不新建记录**，而是把**原收款记录**改成 已退款 / 已留存
  //    —— 卡片必须如实说"改了哪几笔、改成什么"，**绝不能**显示成"没动钱"（那是记错账的展示）。
  const originalStatus = afterSalesResultCard(plan(), {
    detailRecordIds: ['rec_5'],
    money: { route: 'originalPaymentStatus', status: '已退款', amount: 250, recordIds: ['pay_1'] },
    stock: [{ behaviorCode: 'SALE_RETURN', state: '门盒', quantity: 1 }],
  });
  assert.match(textOf(originalStatus), /原收款 1 笔改为「已退款」（￥250）/);
  assert.doesNotMatch(textOf(originalStatus), /没动钱/);

  // 一笔可改的收款行都没有（例如原单全是「未收款」占位）：如实提示人工核对，不谎报"已改"。
  const nothingChanged = afterSalesResultCard(plan(), {
    detailRecordIds: ['rec_6'],
    money: { route: 'originalPaymentStatus', status: '已退款', amount: 250, recordIds: [] },
    stock: [],
  });
  assert.match(textOf(nothingChanged), /原收款没有可改的行/);
});

test('失败卡片 / 状态卡片：必须把原因写出来，并**保留可重试的按钮**', () => {
  const failed = afterSalesRetryCard('task_1', plan(), '原单号对不上：主表记录上是「XSD-OTHER」');
  assert.equal(failed.header.template, 'red');
  assert.equal(failed.header.title.content, '退货没做成');
  assert.match(textOf(failed), /原因：原单号对不上/);
  assert.match(textOf(failed), /点「确认」重试；同一笔不会重复写/);
  // 原因在最上面，确认/取消按钮原封不动还在（不然"在原卡片重试"是空话）
  assert.match(textOf(failed.elements[0]), /原因：/);
  assert.deepEqual(buttonsOf(failed).map((button) => button.action), [
    'choose_after_sales_restock', 'choose_after_sales_restock', 'confirm_after_sales', 'cancel_after_sales']);

  const cancelled = afterSalesStatusCard({ title: '已取消售后', message: '这一笔没有执行，也没有写任何记录。' });
  assert.equal(cancelled.header.template, 'blue');
  assert.match(textOf(cancelled), /没有执行，也没有写任何记录/);
});
