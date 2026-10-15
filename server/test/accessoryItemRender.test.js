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
//   ① （2026-10-12 3b：原来还有「请确认销售订单」那张卡，它随销售草稿卡片退场 ⇒ 本文件改走 ②）
//   ② 结果卡 `salesStatusCard`（已入账 / 取消 / 待修正）
//   ③ 处理中卡 `salesProcessingCard`（点确认后立刻刷新那张）
// 所以这三张卡都在这里钉一遍。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
  const content = firstText(salesStatusCard(MIXED_DRAFT, '已成交', '已经写好了'));

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
  const content = firstText(salesStatusCard(ACCESSORY_ONLY_DRAFT, '已成交', '已经写好了'));
  // 单件不显示金额（既有口径）；关键是**没有那个凭空拼出来的「码」**。
  assert.match(content, /1\. 腰带 × 1(?: |$)/, `实际：${content}`);
  assert.doesNotMatch(content, /码/, `纯配品单里一个「码」字都不该有，实际：${content}`);
});

// ⭐⭐ 2026-10-15（清理死代码）**成对改指向**：
//   改前逐字：`test('结果卡与处理中卡的配品行同样不含「码」（三张卡共用同一个明细渲染器）', …)`
//            ＋ 里面用 `salesProcessingCard(…)` 渲染的那半
//   改后逐字：`test('结果卡（两档）的配品行同样不含「码」（共用同一个明细渲染器）', …)`
//            ＋ 用**另一张活卡分支**（`salesStatusCard` 的「部分交付」）渲染同一份 draft
//   依据：这条判据的本意 =「**共用同一个明细渲染器** ⇒ 配品行在**哪张卡**上都不含硬拼出来的『码』」
//     ⇒ 处理中卡退场后，用**两张活卡分支**钉**同一件事** ✓（判据没放宽 ✗）
test('结果卡（两档）的配品行同样不含「码」（共用同一个明细渲染器）', () => {
  const statusContent = firstText(salesStatusCard(MIXED_DRAFT, '已入账', '销售单号：XSD-1'));
  assert.match(statusContent, /2\. 腰带 × 1 ￥140/, `结果卡实际：${statusContent}`);
  assert.doesNotMatch(statusContent, /腰带\s*码/);

  // ⚠️ 原来这里是 `salesProcessingCard`（处理中卡，已随死代码清理退场 ✗）——
  //    换成**另一张活卡分支**：同一份 mixed draft 走「部分交付」那一档。
  const partialContent = firstText(salesStatusCard(MIXED_DRAFT, '部分已交付', '销售单号：XSD-1', 'blue'));
  assert.match(partialContent, /2\. 腰带 × 1 ￥140/, `部分交付卡实际：${partialContent}`);
  assert.doesNotMatch(partialContent, /腰带\s*码/);
});

test('没有尺码的鞋（数据不齐）也不硬拼「码」——只写数量', () => {
  const content = firstText(salesStatusCard({
    agreed_total: 100,
    payments: [{ method: '微信', amount: 100 }],
    trade_type: '现货',
    items: [{ item_no: '6A637-7', quantity: 1, actual_amount: 100 }],
  }, '已成交', '已经写好了'));
  // 单件不显示金额（既有口径），也**没有**那个凭空拼出来的「码」。
  assert.match(content, /1\. 6A637-7 × 1(?: |$)/, `实际：${content}`);
  assert.doesNotMatch(content, /码/);
});

test('有尺码的件渲染逐字不变（原确认卡「单件不显示金额」的口径已随它退场 ⇒ 活卡片照旧显示金额）', () => {
  // ⚠️ 2026-10-12（3b）：原来这条钉的是"**单件**不显示金额"——那是**已退场那张确认卡片**
  //    独有的做法（它给 `itemLines` 传了 `{ showAmount: items.length > 1 }`）。
  //    仍在跑的卡片（销售状态卡片 / 处理中卡）都用 `itemLines` 的默认值（逐件都显示金额）
  //    ⇒ 那条口径**没有活的卡片需要它**，随卡片一起退场；这里改钉"逐字不变 + 金额照旧在"。
  const content = firstText(salesStatusCard({
    items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99 }], agreed_total: 99,
  }, '已成交', '已经写好了'));
  assert.match(content, /1\. 66356 42码 × 1 ￥99/, `实际：${content}`);
});
