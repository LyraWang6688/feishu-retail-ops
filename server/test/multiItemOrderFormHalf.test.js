'use strict';

/**
 * multiItemOrderFormHalf.test.js —— 「一单多货品」**表单半**（`views/**`）的判据（2026-10-16）。
 *
 * 她的需求（Lead 转述 · 2026-10-16「一单多货 GET 半」）：
 *   · 她填好第一件的**尺码 + 数量** ⇒ 点「＋ 再加一个货品」⇒ **第一件的值不许丢** ✓
 *   · 已加的货品列成一张表 ⇒ 每行一颗**删除**按钮 ✓
 *
 * 🔴 为什么必须做成「同一张表单里的第二个 submit 按钮」（前一位执行者已验证的结论 ①）
 *   —— 改前那颗入口是 `<a href="…?add=1">`：**GET 链接天生带不走她填的尺码/数量** ✗。
 *      只有**同表单的 submit**（POST）才把 `sizes` / `qty_<尺码>` 一起发出去 ⇒ 值不丢 ✓。
 *
 * ⭐ **接线是配置门（本刀缺省 ⇒ 逐字不变 ⇒ 零回归）**
 *   渲染层不自己拍板要不要变成 POST —— 它只认 `write.multiItem?.addAction`
 *   （= **路由半接住那个 POST**之后才给的接线位）。没给 ⇒ 保留今天的 `<a href>` ✓：
 *   `test/multiItemOrderRender.test.js:73` 与 `test/multiItemOrderReturnTrim.test.js:166`
 *   那两条「必须是链接」的既有判据**一个字都不改、仍然绿** ✓（本文件不改它们 ✗）。
 *
 * 判据（每条都能真红）：
 *   · **AC-MI-F1** 接线后：入口**不再是链接**，而是**同一张 `<form>` 里的 `<button type="submit">`**
 *   · **AC-MI-F2** ⭐⭐ 那颗 submit 与她的 `sizes` / `qty_<尺码>` 在**同一张 `<form>` 里**
 *     （把按钮挪出 form ⇒ 红 —— 这正是"值不丢"的物理保证 ✓）
 *   · **AC-MI-F3** ⭐⭐ 隐藏字段 = `[首件, ...已加]`（**已加的那几件带着自己的 `entries`**）
 *     —— 改前只渲首件 ⇒ 点一下"加"就**只剩当前这件**（已加的全丢 ✗）⇒ 去掉拼接 ⇒ 红
 *   · **AC-MI-F4** 列表每行一颗**删除**按钮（`name` = 接线给的删除字段 · `value` = 该件 record_id）
 *   · **AC-MI-F5** 🔴 **零 JS 哨兵未动**（本刀**不加任何 `<script>`**）＋ 接线关 ⇒ 与今天逐字一致 ✓
 *
 * ⚠️ 全部**只读**：纯函数渲染 + 一次**真路由**（express 监听 0 端口，不联网、不写任何 Base）✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_form_half';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_form_half_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'mi_form_half_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
const renderer = require('../src/views/scanPageRenderer');

const RENDERER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js'), 'utf8');

const NUMBER = '832-500|黑色|A';
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_mifh', name: 'mifh', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

/** 接线（= **路由半接住那个 POST** 之后才给的位；缺省**没有**它 ⇒ 今天那份渲染 ✓）。 */
const WIRE = Object.freeze({
  addAction: 'multi_item_add',
  addValue: 'add',
  removeField: 'multi_item_remove',
});

const herView = (extra = {}) => ({
  found: true, number: NUMBER, item_no: '832-500', color: '黑色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }], missing_count: 0,
  sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 06:4x',
  rows: ['40', '41', '42'].map((size, index) => ({
    // ⚠️ 单元格必须带 `key: '门盒'` —— `sellableCountOf` 只认「门盒 / 样品」那两格 ✓
    //   （退货那张表**只列有数量的码** ⇒ key 缺了 ⇒ 一个尺码行都画不出来 ⇒ 假红 ✗）
    size_text: size, cells: index === 0 ? [{ key: '门盒', count: 2 }] : [], total: index === 0 ? 2 : 0,
    missing: index !== 0,
  })),
  ...extra,
});

/**
 * 真路由取那一块（与 `multiItemOrderReturnTrim.test.js` 同一套夹具口径 ✓）。
 * `wire` / `extra` 决定：**接线开不开** + 页面上有没有"已加的货品"。
 */
const fetchRealm = async (from, { wire: wireOn = false, ...extra } = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => herView(extra) }, gateway: {},
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'mifh', saveSaleProgress: async () => ({ ok: true }) },
      listAccessories: async () => [],
    },
    // ⭐ 接线位**注入**（= 路由半将来会传的那一份；缺省不传 ⇒ 今天那份渲染 ✓）
    multiItemWire: wireOn ? WIRE : null,
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

const ALREADY = Object.freeze([
  {
    product_record_id: 'recAdded1', number: 'HL92007|白色|A', item_no: 'HL92007', color: '白色',
    supplier_record_id: 'recSupplier', entries: [{ size: '41', quantity: 2 }],
  },
  {
    product_record_id: 'recAdded2', number: 'HL92008|红色|A', item_no: 'HL92008', color: '红色',
    supplier_record_id: 'recSupplier', entries: [{ size: '42', quantity: 1 }],
  },
]);

const payloadOf = (block) => {
  const match = block.match(new RegExp(`name="${MULTI_ITEM_ORDER.field}" value="([^"]*)"`));
  assert.ok(match, `那一块必须有 hidden 字段 \`${MULTI_ITEM_ORDER.field}\` ✓`);
  return JSON.parse(match[1].replace(/&quot;/g, '"'));
};

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ AC-MI-F1 / F2 —— 那颗入口**必须是同一张表单里的 submit**（这是"值不丢"的物理保证）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-F1 ⭐ 接线后：入口**不再是链接**，而是 submit 按钮（塞回 href ⇒ 红）', async () => {
  for (const realm of ['replenish', 'purchase_return']) {
    const block = await fetchRealm(realm, { wire: true });
    assert.match(block, /<button type="submit"[^>]*data-multi-add/,
      `${realm}：那颗入口必须是一颗 **submit 按钮** ✓`);
    assert.equal(/data-multi-add[^>]*href="/.test(block), false,
      `🔴 ${realm}：接线后**不许再有 href** —— GET 链接带不走她填的尺码/数量 ✗（塞回链接 ⇒ 红）`);
    assert.match(block, /data-multi-add[^>]*name="multi_item_add"[^>]*value="add"/,
      '按钮名 / 值**只从接线配置取**（路由半据此分派 ✓ 不写死 ✗）');
  }
});

test('AC-MI-F2 ⭐⭐ 那颗 submit 与她的尺码/数量在**同一张 `<form>` 里**（挪出去 ⇒ 红）', async () => {
  // 补货那张：`sizes` + `qty_41`（她要填的）；退货那张：`return_sizes` + `return_qty_41` ✓
  const cases = [
    ['replenish', ['name="sizes"', 'name="qty_41"', 'name="qty_40"']],
    ['purchase_return', ['name="return_sizes"', 'name="return_qty_40"']],
  ];
  for (const [realm, needles] of cases) {
    const block = await fetchRealm(realm, { wire: true });
    const formStart = block.indexOf('<form');
    const formEnd = block.indexOf('</form>', formStart);
    assert.ok(formStart >= 0 && formEnd > formStart, `${realm} 必须有那张表单`);
    const form = block.slice(formStart, formEnd);
    assert.ok(form.includes('data-multi-add'),
      `🔴 ${realm}：那颗入口必须在**表单里**（挪到表单外 ⇒ POST 不带她的值 ⇒ 红）`);
    for (const needle of needles) {
      assert.ok(form.includes(needle),
        `🔴 ${realm}：表单里必须有 ${needle}（她填的那些 —— 与按钮同一张表单才不丢 ✓）`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ AC-MI-F3 —— 隐藏字段 = `[首件, ...已加]`（只渲首件 ⇒ 点一下"加"就丢已加的 ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-F3 ⭐⭐ 隐藏字段 = `[首件, ...已加]`，已加那几件**带着自己的 entries**（去掉拼接 ⇒ 红）', async () => {
  const block = await fetchRealm('replenish', { wire: true, multi_items: [...ALREADY] });
  const payload = payloadOf(block);
  assert.equal(payload.length, 3, '🔴 必须是 `[首件, ...已加]` = 3 件（只渲首件 ⇒ 已加的全丢 ✗）');
  assert.deepEqual(payload[0].entries, [],
    '首件的 `entries` 仍是空（由路由在提交时合并本次表单 ✓ 既有判据不放宽 ✗）');
  assert.equal(payload[0].number, NUMBER, '首件 = 当前这一款（`view.number` ✓ 形状照旧）');
  assert.deepEqual(payload[1].entries, [{ size: '41', quantity: 2 }],
    '🔴 已加那件必须**带着它自己的 entries**（否则重渲染后它填的数量丢 ✗）');
  assert.equal(payload[1].product_record_id, 'recAdded1', '第 2 件 = 已加的第一件 ✓');
  assert.equal(payload[2].product_record_id, 'recAdded2', '第 3 件逐字透传 ✓');
});

test('AC-MI-F3b ⭐ 接线关上时：隐藏字段**仍只渲首件**（接线半的语义不许泄漏到缺省页 ✓）', async () => {
  const block = await fetchRealm('replenish', { multi_items: [...ALREADY] });
  const payload = payloadOf(block);
  assert.equal(payload.length, 1, '🔴 没接线 ⇒ 只渲首件（与今天逐字一致 ✓ 零回归）');
  assert.deepEqual(payload[0].entries, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ AC-MI-F4 —— 每行一颗删除按钮
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-F4 ⭐ 每行一颗删除按钮：`name` 走接线 · `value` = 该件 record_id（去掉 ⇒ 红）', async () => {
  for (const realm of ['replenish', 'purchase_return']) {
    const block = await fetchRealm(realm, { wire: true, multi_items: [...ALREADY] });
    assert.match(block,
      /<button type="submit"[^>]*data-multi-remove[^>]*name="multi_item_remove"[^>]*value="recAdded1"/,
      `🔴 ${realm}：第一行那颗删除按钮：\`name\` = 接线字段 · \`value\` = 该件 \`product_record_id\` ✓`);
    assert.match(block, /data-multi-remove[^>]*value="recAdded2"/, '第二行同样有一颗、value 各是各的 ✓');
    assert.equal(block.includes('移除'), true,
      '按钮文字来自既有的 `MULTI_ITEM_RENDER_TEXTS.remove`（配置先行 ✓）');
  }
  // 接线关 ⇒ 一个删除按钮都不许有（零回归 ✓）
  const off = await fetchRealm('replenish', { multi_items: [...ALREADY] });
  assert.equal(off.includes('data-multi-remove'), false, '接线关 ⇒ 不渲染删除按钮 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 AC-MI-F5 —— 零 JS 哨兵未动 + 缺省逐字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-F5 🔴 零 JS 哨兵**未动**：本刀不加任何 `<script>`（接线开/关都一样）', () => {
  // ① 纯函数两版都不许有脚本（扫码页既有哨兵 `AC-W2` / `AC-6R5` ✓ 一个字节不放宽）
  const on = renderer.multiItemBlockHtml(
    { postAction: '/s/x', multiItem: WIRE }, { number: 'K1', multi_items: [...ALREADY] },
  );
  const off = renderer.multiItemBlockHtml({ postAction: '/s/x' }, { number: 'K1' });
  assert.doesNotMatch(on, /<script/i, '🔴 接线那一版里也不许有 `<script>` ✓');
  assert.doesNotMatch(off, /<script/i, '🔴 缺省那一版里同样不许有 `<script>` ✓');
  // ② ⚠️ **零 JS 哨兵的准确口径**（既有 `AC-W2` / `AC-6R5` 钉的是**那一块**）：
  //   扫码页别处**本来就有**两段既有脚本（`submit-feedback` / `annotate`，另有哨兵钉着 ✓）
  //   ⇒ 本刀要证的是「**多货品这一块**一个 `<script>` 都不新增」✓（不是"整个文件没有 script" ✗）。
  const blockSrc = RENDERER_SRC.slice(
    RENDERER_SRC.indexOf('const multiItemBlockHtml'),
    RENDERER_SRC.indexOf('const replenishFormHtml'),
  );
  assert.equal((blockSrc.match(/<script/gi) || []).length, 0,
    '🔴 `multiItemBlockHtml` 里一个 `<script>` 都不许有（零 JS 哨兵 ✓ 本刀不动它 ✓）');
  // ⭐ 本刀**没有引入任何脚本承载的交互**：接线靠的是**第二颗 submit 按钮**（不是 JS ✓）
  assert.match(blockSrc, /type="submit" class="btn btn--primary" data-multi-add/,
    '那颗入口是 **submit 按钮**（不是脚本 ✓）');
});

test('AC-MI-F5b ⭐ 接线关 ⇒ 与今天**逐字一致**：入口仍是链接、没有删除按钮（零回归 ✓）', async () => {
  const block = await fetchRealm('replenish');
  assert.match(block, /data-multi-add[^>]*href="/,
    '⭐ 接线关 ⇒ 入口仍是那颗链接（既有判据 `Render:73` / `ReturnTrim:166` 原样绿 ✓ 零迁移 ✓）');
  assert.equal(block.includes('data-multi-remove'), false, '接线关 ⇒ 没有删除按钮 ✓');
  assert.equal(block.includes('multi_item_add'), false, '接线关 ⇒ 页面上不出现接线字段名 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 探针 —— 上面几条**真能红**（不是空跑 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-MI-F6 ⭐ 探针：缺 `addAction` ⇒ 退回链接；缺 `removeField` ⇒ 没有删除按钮 ✓', () => {
  const onlyRemove = renderer.multiItemBlockHtml(
    { postAction: '/s/x', multiItem: { removeField: 'r' } }, { number: 'K1' },
  );
  assert.match(onlyRemove, /data-multi-add[^>]*href="/,
    '探针：缺 `addAction` ⇒ **退回链接** ✓（说明 F1 考的正是那个位）');
  const onlyAdd = renderer.multiItemBlockHtml(
    { postAction: '/s/x', multiItem: { addAction: 'a', addValue: 'v' } }, { number: 'K1' },
  );
  assert.equal(onlyAdd.includes('data-multi-remove'), false,
    '探针：缺 `removeField` ⇒ 没有删除按钮 ✓（说明 F4 考的正是那个位）');
  // 接线缺 `addValue` ⇒ 也不变成 POST（宁可不渲染那颗按钮，也不发一个认不出的动作 ✗）
  const noValue = renderer.multiItemBlockHtml(
    { postAction: '/s/x', multiItem: { addAction: 'a' } }, { number: 'K1' },
  );
  assert.match(noValue, /data-multi-add[^>]*href="/, '探针：缺 `addValue` ⇒ 退回链接 ✓');
});
