'use strict';

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

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS } = require('../src/config/scanPage');
const renderer = require('../src/views/scanPageRenderer');

const RENDERER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js'), 'utf8');
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
  const button = block.match(/<button type="submit" class="btn btn--primary"[^>]*>([^<]*)<\/button>/);
  assert.ok(button, '退货块里要有一颗提交按钮 ✓');
  assert.equal(button[1], NEW_BUTTON,
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
  assert.match(block, /data-multi-add[^>]*href="/, '「＋ 再加一个货品」那颗链接还在 ✓（零 JS 下唯一的"加"法 ✓）');
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
// ⑥ 防扩大范围：补货那一块**逐字不变**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RT6 ⭐ 这一刀**只动退货**：补货那块的三处照旧（她没点它 ✗）', async () => {
  const block = await fetchRealm('replenish');
  assert.equal(block.includes(OLD_HINT), true, `补货块里那句说明必须还在 ✓：${OLD_HINT}`);
  assert.equal(block.includes(OLD_TITLE), true, `补货块里那个标题必须还在 ✓：${OLD_TITLE}`);
  assert.equal(block.includes(OLD_EMPTY), true, `补货块里那句空态必须还在 ✓：${OLD_EMPTY}`);
  assert.equal(block.includes('multi-item__title'), true, '补货块里那个标题元素也在 ✓');
  assert.equal(block.includes('data-view="multi-item-list"'), true, '补货块里那个列表元素也在 ✓');
  // 补货那颗按钮照旧（她 2026-10-14 定的「生成报货订单」✓ 本刀一个字不动 ✗）
  assert.match(block, /生成报货订单/, '补货那颗按钮文案照旧 ✓');
});

test('AC-RT6b 🔴 源码哨兵：`multiItemBlockHtml` 的**调用处**只按退货那一处传 `\'return\'`', () => {
  const calls = RENDERER_SRC.match(/multiItemBlockHtml\(write, view[^)]*\)/g) || [];
  assert.deepEqual(calls,
    ['multiItemBlockHtml(write, view)', "multiItemBlockHtml(write, view, 'return')"],
    '补货那一处**不传 mode**（走缺省 = 逐字不变 ✓）；退货那一处传 `\'return\'` ✓ —— '
    + '把补货也传上 ⇒ 红（那是扩大范围 ✗）');
  // 配置一处定义：那三句中文只该在 **config** 里（渲染层不许散写 ✗）
  assert.equal(RENDERER_SRC.includes(OLD_HINT), false, '渲染层不许散写那句说明 ✗（走配置 ✓）');
  assert.equal(RENDERER_SRC.includes(OLD_EMPTY), false, '渲染层不许散写那句空态 ✗（走配置 ✓）');
  assert.equal(MULTI_ITEM_RENDER_TEXTS.hint, OLD_HINT, '配置里那句说明**仍在**（补货还要用 ✓ 只删渲染 ✓）');
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
