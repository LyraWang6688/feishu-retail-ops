// 「点了确认必须一眼看得出来」那张**处理中卡片**的回归测试（业务负责人 2026-10-07 拍板的 ⓐ 方案）
// —— **这张卡已随死代码清理退场（2026-10-15 她拍板「清掉吧」）**，本文件只剩**一条**还用得着的判据：
//
//   ⭐ **「已入账」终态卡（`salesStatusCard`）逐字未变 —— 这是她满意的那张，不许动** ✓
//
// 🔴 这一刀删了什么、为什么删（**不是丢口径**）：
//   · 删掉的 4 条：**处理中卡自己的配置 / 渲染**（默认配置、环境变量覆盖、逐字渲染、
//     颜色与处理中行配空串不留壳）—— 它们测的是**要一起删掉的那份配置**（`config/salesProcessingCard`）
//     与**只有那张卡才有的排布** ⇒ 卡没了 ⇒ 判据无载体 ✗。
//   · ⭐ 她那两条口径**一个字都没丢**，只是**载体换了**：
//     ① 「**中间态也应该有提示**」（2026-10-07 ③）现在由**她真能看到的 toast** 承载，
//        已由 `test/terminalCardConfirmDeal.test.js` `:498` `:563`（同一断言）
//        ＋ `:772`（逐字 `config.shortStock === '这批还没到，先去入库再回来点'`）钉住 ✓；
//     ② 「**不留空壳**」这条原则在活卡上由 `productInfoGapsElements`（无缺口 ⇒ 返回 `[]`）
//        承载，已由 `test/productInfoGapsCardPlacement.test.js`「无缺口时…不多出空元素」钉住 ✓。
//   · ⚠️ 原来本文件第 ⑤ 条「`stage` 仍是 `processing`」的**链路级**断言也随那张卡退场
//     （它验的是"点确认后先 patch 一次处理中卡"那一步 —— 那一步已不存在 ✗）。
//
// ⚠️ 本文件里那条留着的断言是**整卡精确 `deepEqual`**（没有一个字节放宽 ✗）。

const assert = require('node:assert/strict');
const test = require('node:test');

const { salesStatusCard } = require('../src/utils/larkCards');

// 两件明细：多件时 `salesStatusCard` **逐件显示金额**（这一段是下面那条断言的输入）。
const TWO_ITEMS = [
  { item_no: 'A100', size: 38, quantity: 1, actual_amount: 99 },
  { item_no: 'A100', size: 39, quantity: 1, actual_amount: 99 },
];

test('「已入账」终态卡（salesStatusCard）逐字未变 —— 这是她满意的那张，不许动', () => {
  const card = salesStatusCard({ items: TWO_ITEMS }, '销售订单已入账',
    '销售单号：XSD-001；2 条明细已写入。尚未交付，库存未扣减。', 'green');
  // 逐字钉住：元素类型仍是 markdown（没有 <font> 包裹）、note 仍是她熟悉的那句。
  //
  // ⚠️ 2026-10-07：这张卡片的 `config` **有意多了一个 `update_multi: true`**。
  //    断言仍然是**整卡精确 deepEqual**（没有放宽成分字段断言），只是把多出来的那个
  //    字段写进期望值 —— header / elements 一个字节都没动。
  //    为什么必须加（详见 utils/larkCards.js 的 `patchableCardConfig` 注释）：
  //      飞书 `im.v1.message.patch` 要求「更新**前后**卡片的 config 中均显式声明
  //      `update_multi: true`」，否则更新**只有操作用户自己可见** ——
  //      这正是线上"点了确认、接口成功、卡片纹丝不动"的根因。
  //    ⇒ **对她可见的内容（header / elements）逐字不变**（= 她满意的部分）；
  //      `config` 加字段只是"更新能不能被她看见"的必要条件，与显示内容无关。
  assert.deepEqual(card, {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '销售订单已入账' } },
    elements: [
      { tag: 'markdown', content: '1. A100 38码 × 1 ￥99\n2. A100 39码 × 1 ￥99' },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: '销售单号：XSD-001；2 条明细已写入。尚未交付，库存未扣减。' }] },
    ],
  });
  // ⭐⭐ 2026-10-15（清理死代码）**成对改指向**：
  //   改前逐字：`const processing = salesProcessingCard(…); assert.notDeepEqual(processing, card);`
  //     （判据 = "处理中卡与终态卡**结构上不是一张卡**"）
  //   改后逐字：**删掉那两行**（处理中卡已退场 ⇒ 那条对照无从表达 ✗）；
  //     本用例**真正的判据**（上面那条整卡 `deepEqual` = 她满意的那张逐字未变 ✓）**一个字没动**。
  //   依据：2026-10-15 她拍板清理死代码；她那条「中间态也要有提示」的口径现由 toast 承载
  //     （见文件头）⇒ 删的是**无载体的死卡对照**，不是她的口径 ✓
});
