// ⭐ 真机案例（2026-10-07）：**配品行不许渲染出「码」**。
//
// 她的原话（逐字）：「400 元微信卖了一双 6A637-7，43码（赠了一双袜子，260 元），
//                     然后 140 元微信卖了一条 158 元的腰带」
// 卡片上实际显示的配品行是「**腰带 码 × 1**」—— 配品没有尺码，模板却硬拼了一个「码」，
// 于是那句话读起来像残句。
//
// 口径（业务负责人）：**配品（`kind: 'accessory'`）/ 没有 `size` 的件，不要拼「码」**。
// 🔴 这一条**只改渲染**：写库 / 业务逻辑一个字不动（配品本来就不写尺码、不碰库存，
//    见 `services/salesOrderService.js` 与 `test/salesMvp.test.js` 里那些用例）。
//
// 明细行的渲染器是 `utils/larkCards.js` 的 `itemLines`，三个调用点都走它：
//   ① 销售确认卡片 `salesConfirmationCard`（她看到的"请确认销售订单"那张）
//   ② 结果卡 `salesStatusCard`（已入账 / 取消 / 待修正）
//   ③ 处理中卡 `salesProcessingCard`（点确认后立刻刷新那张）
// 所以这三张卡都在这里钉一遍。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  salesConfirmationCard,
  salesStatusCard,
  salesProcessingCard,
} = require('../src/utils/larkCards');

// 一单里混着鞋与配品：鞋 43 码、腰带没有尺码（与真机案例同形状，金额用改后的正确值）。
const MIXED_DRAFT = {
  agreed_total: 400,
  payments: [{ method: '微信', amount: 400 }],
  trade_type: '现货',
  items: [
    { item_no: '6A637-7', size: 43, quantity: 1, actual_amount: 260, gift: true, gift_description: '袜子一双' },
    { kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 140 },
  ],
};

// 纯配品单（她说"卖了一条腰带"）也要能渲染 —— 这种单**一个尺码都没有**。
const ACCESSORY_ONLY_DRAFT = {
  agreed_total: 140,
  payments: [{ method: '微信', amount: 140 }],
  trade_type: '现货',
  items: [{ kind: 'accessory', accessory_name: '腰带', quantity: 1, actual_amount: 140 }],
};

const firstText = (card) => card.elements[0].text?.content || card.elements[0].content || '';

test('配品 + 鞋混在一单：鞋照旧「43码 × 1」，配品行**不含「码」**（真机那行「腰带 码 × 1」必须消失）', () => {
  const content = firstText(salesConfirmationCard('draft-1', MIXED_DRAFT));

  // ① 有尺码的鞋：逐字不变（既有断言钉着的写法）。
  assert.match(content, /1\. 6A637-7 43码 × 1 ￥260/);
  // ② 配品：只写名字与数量，绝不出现「码」，也不出现「码 × 1」这种残句。
  assert.match(content, /2\. 腰带 × 1 ￥140/, `配品行应为「腰带 × 1」，实际整段：${content}`);
  assert.doesNotMatch(content, /腰带\s*码/, `配品行不许拼「码」，实际整段：${content}`);
  assert.doesNotMatch(content, /码 × 1 ￥140/, `「码 × 1」这种残句必须消失，实际整段：${content}`);
  // ③ 赠品那一行照旧。
  assert.match(content, /赠品：袜子一双/);
});

test('纯配品单（一个尺码都没有）：渲染成「腰带 × 1」，不含「码」', () => {
  const content = firstText(salesConfirmationCard('draft-2', ACCESSORY_ONLY_DRAFT));
  // 单件不显示金额（既有口径）；关键是**没有那个凭空拼出来的「码」**。
  assert.match(content, /1\. 腰带 × 1(?: |$)/, `实际：${content}`);
  assert.doesNotMatch(content, /码/, `纯配品单里一个「码」字都不该有，实际：${content}`);
});

test('结果卡与处理中卡的配品行同样不含「码」（三张卡共用同一个明细渲染器）', () => {
  const statusContent = firstText(salesStatusCard(MIXED_DRAFT, '已入账', '销售单号：XSD-1'));
  assert.match(statusContent, /2\. 腰带 × 1 ￥140/, `结果卡实际：${statusContent}`);
  assert.doesNotMatch(statusContent, /腰带\s*码/);

  const processingContent = firstText(salesProcessingCard(MIXED_DRAFT, {
    title: '处理中', note: '已收到确认，正在写入销售记录和收款；请勿重复点击。',
  }));
  assert.match(processingContent, /2\. 腰带 × 1 ￥140/, `处理中卡实际：${processingContent}`);
  assert.doesNotMatch(processingContent, /腰带\s*码/);
});

test('没有尺码的鞋（数据不齐）也不硬拼「码」——只写数量', () => {
  const content = firstText(salesConfirmationCard('draft-3', {
    agreed_total: 100,
    payments: [{ method: '微信', amount: 100 }],
    trade_type: '现货',
    items: [{ item_no: '6A637-7', quantity: 1, actual_amount: 100 }],
  }));
  // 单件不显示金额（既有口径），也**没有**那个凭空拼出来的「码」。
  assert.match(content, /1\. 6A637-7 × 1(?: |$)/, `实际：${content}`);
  assert.doesNotMatch(content, /码/);
});

test('有尺码的件渲染逐字不变（既有口径不放宽）', () => {
  // 三张卡里都有这条既有断言；这里把「单件不显示金额 / 多件显示金额」的既有口径一起复核。
  const oneItem = firstText(salesConfirmationCard('draft-4', {
    agreed_total: 99, payments: [{ method: '微信', amount: 99 }], trade_type: '现货',
    items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99 }],
  }));
  assert.equal(oneItem, '1. 66356 42码 × 1');

  const twoItems = firstText(salesConfirmationCard('draft-5', {
    agreed_total: 198, payments: [{ method: '微信', amount: 198 }], trade_type: '现货',
    items: [
      { item_no: '66356', size: 42, quantity: 1, actual_amount: 99 },
      { item_no: '66357', size: 40, quantity: 1, actual_amount: 99 },
    ],
  }));
  assert.equal(twoItems, '1. 66356 42码 × 1 ￥99\n2. 66357 40码 × 1 ￥99');
});
