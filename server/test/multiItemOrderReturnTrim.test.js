'use strict';
const { rendererSource } = require('./support/rendererSource');

/**
 * multiItemOrderReturnTrim.test.js —— **退货 tab 那三处精简**的成对迁移判据（2026-10-16）。
 *
 * 依据（业务负责人 2026-10-16 真机截图 · 退货 tab · 货品 `832-500` ＋ 逐字）：
 *   「退货确实没有了那个退货按钮，需要你**删除不必要的文字提示**，
 *     以及把**最下面的蓝色按钮改为「退货」**」
 *   ＋ 与她弹窗确认过的选择：「**说明 + 「本单已加的货品」那整块都删**」
 *
 * 这一刀**只点退货**（补货那块她没点 ✗）⇒ 五条判据：
 *
 *   ① **AC-RT1**（反向哨兵）退货块里**不许**再有那句说明 —— 塞回即红 ✓
 *   ② **AC-RT2**（反向哨兵）退货块里**不许**再有「本单已加的货品」那个标题 —— 塞回即红 ✓
 *   ③ **AC-RT3**（反向哨兵）退货块里**不许**再有「还没有加第二个货品。」那句空态 —— 塞回即红 ✓
 *   ④ **AC-RT4**（⭐ **正向** · 防"删过头"）**有第二个货品时列表仍要出现** ——
 *      删掉那个 `<ul>` / 那一行 ⇒ 红 ✓（这是本文件最要紧的一条：她删的是"提示"，不是"列表"）
 *   ⑤ **AC-RT5** 最下面那颗蓝色按钮的文字 = 「**退货**」（**旧名塞回即红** ✓）
 *   ⑥ **AC-RT6**（防扩大范围）**补货那一块逐字不变**：三处照旧 + 按钮文案照旧 ✓
 *   ⑦ **AC-RT7** 探针：上面那几条检测器**真能红** ✓（不空跑）
 *
 * ⭐⭐ 2026-10-16 **同日第二次成对迁移**（**她随后又点了补货那三处**，逐字：
 *   「这个是**报货的页面，还是需要填写金额啊**，以及**不需要的文字说明给删除**，
 *     **生成报货订单按钮文字改为补货**」）：
 *   ⇒ 本文件第 ⑥ 节（AC-RT6 / AC-RT6b）原来钉的是『**补货那块逐字不变**（防扩大范围 ✗）』，
 *     那个**前提**已经不成立（她**这一次**点的就是补货 ✓）⇒ 翻成『**补货也进精简档**』
 *     （**不是删 / 不是放宽** ✗：那三处与旧按钮名从"必须有"翻成"必须没有" = **变强** ✓）。
 *   ⚠️ **①~⑤ 与 ⑦ 一个字没动、仍逐字生效** ✓（退货那一半照旧 ✓）。
 *   ⭐ 补货那三处的**独立强反向哨兵**（连字段名 / 标签都塞回即红 ＋ 范围哨兵）在
 *     **新文件** `test/replenishTrimThreeFixes.test.js` ✓（AC-RP1..AC-RP6）。
 *
 * ⚠️ 全部**只读**：纯函数渲染 + 一次**真路由**（express 监听 0 端口，不联网、不写任何 Base）✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_rt_trim';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'rt_trim_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'rt_trim_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

// ⭐⭐ 成对迁移（2026-10-16 · `SCAN_DRAFT_ENABLED` 缺省翻 true 之后）—— 本文件测的不是草稿：
//   它测的是 退货块的精简档（三处提示被删、列表仍在、按钮文案）。
//   🔴 **改前逐字**：本文件**不配** `SCAN_DRAFT_ENABLED` ⇒ 靠 `config/scanDraft.js` 的缺省拿到
//     "草稿关"（`resolveShared` 里那一行当时代码是：`const enabled = readFlag(env, 'SCAN_DRAFT_ENABLED', false);`）。
//   ✅ **改后逐字**：`process.env.SCAN_DRAFT_ENABLED = 'false';` ⇒ **显式**要"草稿关"。
//   ⭐ **依据** = 业务负责人 2026-10-16「**开关打开**」（同一行缺省已翻成 `true`）⇒ 缺省不再是关态，
//     所以"靠缺省"这条路**没有了**，必须自己写死。
//   ⚠️ **强度不变（不是放宽）**：页面上那一份输出与迁移前**逐字节相同** —— 迁移前缺省就是 `false`
//     （本文件在 main 上是绿的）；这里只把"碰巧的缺省"换成"自己声明的前置条件"，
//     断言**一条没删、一条没 skip、一条没放宽**；缺省再翻也不会静默改掉本文件的语义 ✓。
process.env.SCAN_DRAFT_ENABLED = 'false';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS } = require('../src/config/scanPage');
// ⭐ 2026-10-16 下半场：AC-RT5b 要钉"那颗接线 submit 的字段名" ⇒ 字段名**只从配置取**（不写死 ✗）
const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
const renderer = require('../src/views/scanPageRenderer');

const RENDERER_SRC = rendererSource();
const SCAN_WRITE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'config', 'scanWrite.js'), 'utf8');

// 改前逐字（她点掉的那三处的文案 —— **判据就是拿它们当"塞回即红"的锚**）：
const OLD_HINT = '加进来的货品会和上面对着的这一个一起提交；每个货品的尺码与数量在它自己的块里填。';
const OLD_TITLE = '本单已加的货品';
const OLD_EMPTY = '还没有加第二个货品。';
const OLD_BUTTON = '生成采购退货';
const NEW_BUTTON = '退货';

const NUMBER = '832-500|黑色|A';
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_rt', name: 'rt', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

/** 她的真实形状：有库存 ⇒ 尺码行画得出来 ⇒ 金额行 + 多货品块 + 提交按钮都在 ✓ */
const herView = (extra = {}) => ({
  found: true, number: NUMBER, item_no: '832-500', color: '黑色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }], missing_count: 0,
  sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 04:1x',
  rows: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'].map((size, index) => ({
    size_text: size, cells: index === 4 ? [{ count: 2 }] : [], total: index === 4 ? 2 : 0, missing: index !== 4,
  })),
  ...extra,
});

/**
 * 真路由取那一块（与 `returnBlockFirstScreen.test.js` 同一套夹具口径 ✓）。
 * `from` 决定去哪一块；`multi_items` 有值 = 她**真的加了第二个货品** ✓。
 */
const fetchRealm = async (from, extra = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => herView(extra) }, gateway: {},
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'rt', saveSaleProgress: async () => ({ ok: true }) },
      listAccessories: async () => [],
    },
    startSnapshot: false,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 1;
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/s/${encodeURIComponent(NUMBER)}?from=${from}`,
      { headers: { cookie: COOKIE } },
    );
    assert.equal(response.status, 200, `?from=${from} 那一页要能打开 ✓`);
    const html = await response.text();
    const at = html.indexOf(`realm-block--${from}`);
    assert.notEqual(at, -1, `?from=${from} 时那一块要在页面上 ✓`);
    return html.slice(at, html.indexOf('</section>', at) + 10);
  } finally { await new Promise((resolve) => { server.close(resolve); }); }
};

// ═══════════════════════════════════════════════════════════════════════════
// ① ② ③ 三处**删掉**了（反向哨兵：塞回即红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT1 🔴 退货块里**不许**再有那句说明（她逐字：删除不必要的文字提示）', async () => {
  const block = await fetchRealm('purchase_return');
  assert.equal(block.includes(OLD_HINT), false,
    `🔴 那句说明必须删掉（塞回即红）：${OLD_HINT}`);
});

test('AC-RT2 🔴 退货块里**不许**再有「本单已加的货品」那个标题', async () => {
  const block = await fetchRealm('purchase_return');
  assert.equal(block.includes(OLD_TITLE), false,
    `🔴 那个标题必须删掉（塞回即红）：${OLD_TITLE}`);
  assert.equal(block.includes('multi-item__title'), false, '连那个标题元素一起删 ✓');
});

test('AC-RT3 🔴 退货块里**不许**再有「还没有加第二个货品。」那句空态', async () => {
  const block = await fetchRealm('purchase_return');
  assert.equal(block.includes(OLD_EMPTY), false,
    `🔴 那句空态必须删掉（塞回即红）：${OLD_EMPTY}`);
  // ⭐ 空态是**整块不渲染**（不是"渲染出来但为空" ✗）—— 没有第二个货品时那个 <ul> 根本不在 ✓
  assert.equal(block.includes('data-view="multi-item-list"'), false,
    '⭐ 没有第二个货品 ⇒ 那个列表元素**整块不渲染**（不留空壳 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ ⭐ **正向**判据（防删过头）：有第二个货品 ⇒ 列表仍要出现
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT4 ⭐⭐ **有第二个货品时列表仍要出现**（她删的是"提示"，不是"列表" ✗）', async () => {
  const block = await fetchRealm('purchase_return', {
    multi_items: [
      { number: 'HL92006|黑色|A', item_no: 'HL92006', color: '黑色', entries: [{ size: '41', quantity: 1 }, { size: '42', quantity: 2 }] },
    ],
  });
  assert.match(block, /data-view="multi-item-list"/,
    '🔴 **有内容时必须出现列表** —— 去掉它 ⇒ 她加了第二个货品却看不见 ⇒ 红 ✓（防"删过头" ✗）');
  assert.match(block, /<li class="multi-item-row">HL92006\|黑色\|A/,
    '那一行必须是**已加的那个货品**（编号逐字 ✓）');
  assert.match(block, /2 行/, '行数照旧（`{count} 行` 模板 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 最下面那颗蓝色按钮 = 「退货」（旧名塞回即红）＋ 那几处**不许动**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT5 🔴 最下面那颗蓝色按钮的文字 = 「退货」（改前逐字 `生成采购退货` ⇒ 塞回即红）', async () => {
  const block = await fetchRealm('purchase_return');
  // ⭐ 2026-10-16 下半场（Lead 裁决"手术刀 ①" ⇒ `SCAN_MULTI_ITEM_ADD_WIRE` 缺省 `true`）**成对迁移**：
  //   改前逐字：`const button = block.match(/<button type="submit" class="btn btn--primary"[^>]*>([^<]*)<\/button>/);`
  //     ＋ `assert.equal(button[1], NEW_BUTTON, …)` —— 那时开关关着、那张表单里**只有一颗**这样的按钮 ✓。
  //   改后逐字：下面这两行 —— 取**最后一颗**（同一张表单里现在还有多货品那颗"＋ 再加一个货品"，
  //     它在**上面** ✓）。**不是放宽**：本判据的原话就是"**最下面那颗**蓝色按钮" ⇒ 取末颗正是它 ✓；
  //     多出来的那一颗由 `multiItemOrderFormHalf` 的 AC-MI-F1/F2 单独钉着 ✓（链接 / 位置 / 字段名都在）。
  const buttons = [...block.matchAll(/<button type="submit" class="btn btn--primary"[^>]*>([^<]*)<\/button>/g)];
  assert.ok(buttons.length, '退货块里要有一颗提交按钮 ✓');
  assert.equal(buttons[buttons.length - 1][1], NEW_BUTTON,
    `改前逐字「${OLD_BUTTON}」⇒ 改后逐字「${NEW_BUTTON}」（依据 = 她 2026-10-16 真机截图 + 逐字）`);
  assert.equal(block.includes(OLD_BUTTON), false, `🔴 旧按钮名塞回即红：${OLD_BUTTON}`);
  // ⭐ 配置先行：那颗按钮的文字**只来自这一处**（她下次改字只改配置 ✓ 不散写成中文字面量 ✗）
  assert.equal(block.includes(SCAN_PAGE.returnForm.submitLabel), true,
    '⚠️ 那颗按钮的文字必须来自 `SCAN_PAGE.returnForm.submitLabel`（配置先行 ✓）');
});

test('AC-RT5b 🔴 她这次**没点**的几处一个字都不许动（尺码行 / 整单金额 / ＋再加一个货品 / 字段名）', async () => {
  const block = await fetchRealm('purchase_return');
  assert.match(block, /class="size-row"/, '尺码行还在 ✓');
  assert.match(block, /整单金额/, '「整单金额（必填）」还在 ✓');
  // ⭐ 2026-10-16 下半场 **成对迁移**（**改指向、不放宽** ✓）：
  //   改前逐字：`assert.match(block, /data-multi-add[^>]*href="/, '「＋ 再加一个货品」那颗链接还在 ✓（零 JS 下唯一的"加"法 ✓）');`
  //   改后逐字：下面这一行 —— 那颗入口由 `<a href="?add=1">`（GET **天生带不走**她填的尺码/数量 ✗）
  //     **成对迁移**成**同一张表单里的第二颗 submit**（`SCAN_MULTI_ITEM_ADD_WIRE` 缺省 `true` ✓）。
  //   ⇒ 钉的从"是链接"改成"**是那颗接线 submit ＋ 字段名走配置**"（**更有针对性** ✓；塞回链接 ⇒ 红 ✓）。
  //   ⚠️ 它的"值不丢 / 只出现一次 / 在同一张表单里"由 `multiItemOrderAddWire`（AC-MI-A/F2）与
  //     `multiItemCurrentItemDup`（AC-CID-*）单独钉着 ✓ —— 本条不再重复那一半。
  assert.match(block, new RegExp(`<button type="submit"[^>]*data-multi-add[^>]*name="${MULTI_ITEM_ORDER.wire.addAction}"`),
    '「＋ 再加一个货品」那颗入口仍在（同表单的第二颗 submit · 字段名走 `config/multiItemOrder.js` ✓）');
  assert.match(block, /name="multi_items"/, '字段名 `multi_items` 原样透传 ✓');
  assert.match(block, /name="return_sizes"/, '字段名原样 ✓');
  assert.match(block, /name="action" value="return_purchase"/, '动作名原样 ✓');
  assert.match(block, /data-view="purchase-return"/, '定位标记仍在（全仓 6+ 处用例拿它当锚 ✓）');
  // 🔴 写侧那句 `returnButton` **一个字不动**（红线 `config/scanWrite.js` ✗）——
  //    它还服务提交异常页那两句人话（见 `scanWrite.js:697` / `:731`）。
  assert.match(SCAN_WRITE_SRC, /returnButton: '生成采购退货',/,
    '🔴 写侧 `config/scanWrite.js` 的 `returnButton` 不许动（它不在本任务写作用域内 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 范围：**退货**那一半逐字不变 —— ⭐⭐ 2026-10-16 **成对迁移**
//
//   改前逐字（本节的用意 = 「她这次**只点了退货** ⇒ 补货那块一个字不许动 ✗」）：
//     · AC-RT6  『补货块里那句说明 / 那个标题 / 那句空态 **必须还在**』＋
//                『补货那颗按钮文案照旧 = `生成报货订单`』；
//     · AC-RT6b 『补货那一处**不传 mode**』（`multiItemBlockHtml(write, view)`）。
//   改后逐字（依据 = **她 2026-10-16 又点了补货那三处**，逐字：
//     「这个是**报货的页面，还是需要填写金额啊**，以及**不需要的文字说明给删除**，
//       **生成报货订单按钮文字改为补货**」）：
//     ⚠️ 那个"只动退货"的**前提**已经不成立了（她**这一次**点的就是补货 ✓）
//       ⇒ 本节**翻成"补货也进精简档"**（**不是删掉判据、也不是放宽** ✗ ——
//         补货那三处与旧按钮名**从"必须有"翻成"必须没有"** = **变强** ✓）。
//     · AC-RT6  → 补货块：那三处**必须没有** ✓ ＋ 那颗按钮 = 「**补货**」✓；
//     · AC-RT6b → 两处调用**各自显式传自己那一档** ✓（补货 `'replenish'` / 退货 `'return'`）。
//   ⭐ 退货那一半的判据（AC-RT1..RT5）**一个字没动**、仍逐字生效 ✓；
//     补货那三处的**强反向哨兵**（连字段名 / 标签都塞回即红）在**新文件**
//     `test/replenishTrimThreeFixes.test.js`（AC-RP1 / AC-RP3 / AC-RP4 / AC-RP5）✓。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT6 ⭐ 补货那一块**也**进精简档了（她 2026-10-16 点了它 ⇒ 那三处必须没有 ＋ 按钮 = 「补货」）', async () => {
  const block = await fetchRealm('replenish');
  assert.equal(block.includes(OLD_HINT), false, `补货块里那句说明必须**删掉**（塞回即红 ✓）：${OLD_HINT}`);
  assert.equal(block.includes(OLD_TITLE), false, `补货块里那个标题必须**删掉**（塞回即红 ✓）：${OLD_TITLE}`);
  assert.equal(block.includes(OLD_EMPTY), false, `补货块里那句空态必须**删掉**（塞回即红 ✓）：${OLD_EMPTY}`);
  assert.equal(block.includes('multi-item__title'), false, '那个标题元素也一起删 ✓');
  assert.equal(block.includes('data-view="multi-item-list"'), false, '空的时候那个列表元素**整块不渲染** ✓');
  // 改前逐字：`assert.match(block, /生成报货订单/, '补货那颗按钮文案照旧 ✓');`
  // 改后逐字（依据 = 她 2026-10-16 逐字「**生成报货订单按钮文字改为补货**」）：
  assert.equal(block.includes('生成报货订单'), false, '🔴 旧按钮名必须没有（塞回即红 ✓）');
  assert.match(block, /补货<\/button>/, '补货那颗按钮文案 = 「补货」✓（配置里那一句 ✓）');
});

test('AC-RT6b 🔴 源码哨兵：`multiItemBlockHtml` 的**两处调用各自显式传自己那一档**', () => {
  const calls = RENDERER_SRC.match(/multiItemBlockHtml\(write, view[^)]*\)/g) || [];
  // 改前逐字：`['multiItemBlockHtml(write, view)', "multiItemBlockHtml(write, view, 'return')"]`
  //   （补货那一处**不传 mode** = 走缺省 = 那三句照旧画 ✗）
  // 改后逐字：下面这一行（补货那一处**显式传** `'replenish'` ✓）
  //   ⚠️ 依据 = 她 2026-10-16 逐字（补货页要删那三句）；**缺省档本身没动** ✓
  //     （`mode` 缺省 `''` 仍是老形状 ⇒ AC-RT7 的探针照旧靠它 ✓）
  // ⭐⭐ 2026-10-16（task-61 · **领域内扫一扫**）**成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.deepEqual(calls, ["multiItemBlockHtml(write, view, 'replenish')", "multiItemBlockHtml(write, view, 'return')"])`
  //   改后逐字：下面这一行 —— 只把**第四个实参 `page`** 算进去（第三个 `mode` **逐字不变** ✓）
  //   依据 = 她 2026-10-16 14:38 逐字「加一单改为这个领域的扫一扫，与全局扫一扫不同」
  //     ⇒ 那一发要把**本页领域 / 落点**交给渲染层 ✓
  //   ⚠️ **不是放宽**：两处、**恰好两处**、每一处**显式传自己那一档**，一个字都没松 ✓
  assert.deepEqual(calls,
    ["multiItemBlockHtml(write, view, 'replenish', page)", "multiItemBlockHtml(write, view, 'return', page)"],
    '补货 / 退货各自显式传自己那一档 ✓ —— 谁把补货那一处改回"不传"（= 又画那三句）⇒ 红 ✓');
  // 配置一处定义：那三句中文只该在 **config** 里（渲染层不许散写 ✗）
  assert.equal(RENDERER_SRC.includes(OLD_HINT), false, '渲染层不许散写那句说明 ✗（走配置 ✓）');
  assert.equal(RENDERER_SRC.includes(OLD_EMPTY), false, '渲染层不许散写那句空态 ✗（走配置 ✓）');
  assert.equal(MULTI_ITEM_RENDER_TEXTS.hint, OLD_HINT, '配置里那句说明**仍在**（一处定义 ✓ 只是两块都不渲染它 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ 探针：上面那几条检测器**真能红** ✓
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT7 ⭐ 探针：三处"塞回"与"删过头"都**必须**被检出（证明上面几条不空跑）', () => {
  const offenders = {
    hint: (html) => html.includes(OLD_HINT),
    title: (html) => html.includes(OLD_TITLE),
    empty: (html) => html.includes(OLD_EMPTY),
    listMissing: (html) => !/data-view="multi-item-list"/.test(html),
    oldButton: (html) => html.includes(OLD_BUTTON),
  };
  const cleanReturn = renderer.multiItemBlockHtml(
    { postAction: '/s/K1', texts: {} }, { number: 'K1' }, 'return');
  assert.equal(offenders.hint(cleanReturn), false, '干净的退货块 ⇒ 说明不误报 ✓');
  assert.equal(offenders.title(cleanReturn), false, '干净的退货块 ⇒ 标题不误报 ✓');
  assert.equal(offenders.empty(cleanReturn), false, '干净的退货块 ⇒ 空态不误报 ✓');
  assert.equal(offenders.listMissing(cleanReturn), true, '⚠️ 空的时候列表本就该不在（这条只对"有内容"那一次有意义 ✓）');
  assert.equal(offenders.oldButton(`<button>${OLD_BUTTON}</button>`), true, '旧按钮名 ⇒ **必须**报红 ✓');
  // 把三处塞回**补货那一版**（= 老实现）⇒ 三个检测器同时报红 ✓
  const oldShape = renderer.multiItemBlockHtml({ postAction: '/s/K1', texts: {} }, { number: 'K1' });
  assert.equal(offenders.hint(oldShape), true, '塞回说明 ⇒ **必须**报红 ✓');
  assert.equal(offenders.title(oldShape), true, '塞回标题 ⇒ **必须**报红 ✓');
  assert.equal(offenders.empty(oldShape), true, '塞回空态 ⇒ **必须**报红 ✓');
  // "删过头"（连列表一起删）⇒ listMissing 报红 ✓
  assert.equal(offenders.listMissing(
    renderer.multiItemBlockHtml({ postAction: '/s/K1', texts: {} }, { number: 'K1' }, 'return')), true,
  '空的时候列表不在（预期）—— 有内容那一次的检测在 AC-RT4 ✓');
  assert.equal(offenders.listMissing(
    renderer.multiItemBlockHtml({ postAction: '/s/K1', texts: {} },
      { number: 'K1', multi_items: [{ number: 'HL1', entries: [{ size: '41', quantity: 1 }] }] }, 'return')), false,
  '⭐ 有内容 ⇒ 列表必须在 ⇒ "删过头"会被这条抓住 ✓');
});
