'use strict';

/**
 * multiItemCurrentItemDup.test.js —— 修掉 `#721`（已进 main）里那条**静默丢值**的判据（task-59 收尾）。
 *
 * ## 病是什么（**已用 #721 自己的代码 + 真引擎复核过**）
 *
 * `#721` 的隐藏字段渲的是 `[首件, ...view.multi_items]`，而 `view.multi_items` 来自
 * `routes/scanPage.js` 的 `readMultiItemPending(openId, chain)` —— 那个函数**只拿得到 (openId, chain)**，
 * **它不知道"当前是哪一件"** ⇒ 草稿里的 items **一件都没排**（那段注释写的
 * 「由路由半保证"不含当前这一件"」**当时并没有实现** ✗）。
 *
 * ⇒ 只要**当前这一件已经在草稿里**（她点过一次「＋ 再加一个货品」之后回到**同一款**那一页，
 *   或她重新扫同一款再点一次），当前这件就在载荷里**出现两次**：
 *   `[{A, entries: []}, {A, entries: [{40,2}]（草稿旧值）}]` ⇒ 提交时 `addItem` 按顺序跑、
 *   **后写的赢** ⇒ **她刚填的尺码/数量被旧值静默覆盖** ✗✗（正是"填了值，点一下，值没了"那一类）。
 *
 * ## 判据（每条都能真红 ✓）
 *   · **AC-CID-1** 载荷里当前这件**只许出现一次**，且**不许带着草稿那份旧 `entries`** ✓
 *   · **AC-CID-2** ⭐⭐ **端到端（真渲染器 + 真路由纯函数 + 真引擎）**：
 *     她这次在表单里勾 **41 码 × 1** ⇒ 引擎最后拿到的**就是 41×1**（旧的 40×2 **不许赢** ✗）
 *   · **AC-CID-3** **探针**：把**修复前**那份载荷（`[首件, ...草稿全部]`）喂进同一条链 ⇒
 *     引擎最后拿到的是**旧值 40×2** ⇒ 证明 AC-CID-2 **真能红**（不是空跑 ✓）
 *   · **AC-CID-4** 列表照旧画**全部**已加的（她刚加的那一件**必须看得见** ✓ 只排载荷、不排列表 ✗）
 *     ＋ `groups.length` 不许被这一件平白撑大（N=1 的那一单仍是 1 组 ✓）
 *
 * ⚠️ 全部**只读**：不联网、不写任何 Base、不碰 `services/**`（引擎只被**调用**）✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_cid';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_cid_secret';
// ⭐ 把「＋ 再加一个货品」那颗入口**接线**（= `#721` 设计里的"上线态"；缺省关着 ⇒ 那颗仍是链接）
process.env.SCAN_MULTI_ITEM_ADD_WIRE = 'true';

const serverRoot = path.resolve(__dirname, '..');
const { MULTI_ITEM_ORDER, resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');
const { parseMultiItemGroups, mergeFirstItemEntries } = require('../src/routes/scanPage');
const renderer = require('../src/views/scanPageRenderer');

const clone = (value) => JSON.parse(JSON.stringify(value));
const FIELD = MULTI_ITEM_ORDER.field;
const WIRE = MULTI_ITEM_ORDER.wire;

const A = Object.freeze({
  product_record_id: 'rec_A', number: 'K1|黑色|A', item_no: 'K1', color: '黑色', supplier_record_id: 'sup_A',
});
/** 草稿里**已经存着**的那一份（旧值：40 码 × 2）—— 她先点过一次「＋ 再加一个货品」 */
const DRAFT_A = Object.freeze({ ...A, entries: [{ size: '40', quantity: 2 }] });

const writeContext = () => ({
  postAction: '/s/K1', texts: {},
  multiItem: { addAction: WIRE.addAction, addValue: WIRE.addValue, removeField: WIRE.removeField },
});

/** 那块 HTML 里的 hidden 载荷（**真渲染器的产物** ✓ 不是测试自己拼的形状 ✗） */
const payloadOf = (html) => {
  const match = html.match(new RegExp(`name="${FIELD}" value="([^"]*)"`));
  assert.ok(match, `页面上必须有 hidden \`${FIELD}\` ✓`);
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
};

/** 真引擎（假会话 store；只验"它最后拿到什么"，不写任何业务表 ✓） */
const makeEngine = async () => {
  const records = new Map();
  const idOf = (openId) => `scan_session_${openId}`;
  const store = {
    get: async (id) => (records.has(id) ? clone(records.get(id)) : null),
    update: async (id, patchOrMutator) => {
      const current = records.has(id) ? clone(records.get(id)) : null;
      const patch = typeof patchOrMutator === 'function' ? await patchOrMutator(current) : patchOrMutator;
      const next = { ...(current || {}), ...(patch || {}) };
      records.set(id, next);
      return clone(next);
    },
  };
  const engine = createMultiItemOrderService({
    sessions: {
      idOf,
      store,
      ensure: async (openId) => {
        if (!records.has(idOf(openId))) records.set(idOf(openId), { session_id: idOf(openId) });
        return clone(records.get(idOf(openId)));
      },
    },
    config: resolveMultiItemOrderConfig({}), writers: {},
  });
  const openId = 'ou_cid';
  const chain = 'replenish';
  const opened = await engine.openDraft({ openId, chain });
  return { engine, openId, chain, orderKey: opened.orderKey };
};

/**
 * **端到端那条链**（每一步都是**真的**）：
 *   真渲染器渲的 hidden 载荷 → 真路由的 `parseMultiItemGroups` ＋ `mergeFirstItemEntries`
 *   → 真引擎 `addItem` 逐件 → 读回草稿。
 */
const runChain = async ({ payload, formEntries }) => {
  const { engine, openId, chain, orderKey } = await makeEngine();
  // 草稿里先有旧值（她先点过一次「加货」）
  await engine.addItem({ openId, chain, orderKey, item: DRAFT_A });
  const groups = mergeFirstItemEntries(
    parseMultiItemGroups({ [FIELD]: JSON.stringify(payload) }, MULTI_ITEM_ORDER),
    formEntries,
  );
  for (const group of groups) await engine.addItem({ openId, chain, orderKey, item: group });
  const draft = (await engine.readDraft({ openId, chain, orderKey })).draft;
  const a = draft.items.find((item) => item.product_record_id === 'rec_A') || { entries: [] };
  return { groups, entries: a.entries };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-CID-1 载荷里"当前这一件"只许出现一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-CID-1 🔴 当前这一件**只许出现一次**，且不许带草稿那份旧 `entries`（改前逐字：`[first, ...already]`）', () => {
  const html = renderer.multiItemBlockHtml(writeContext(), { ...A, multi_items: [DRAFT_A] }, 'replenish');
  const payload = payloadOf(html);
  // 改前逐字：`const payload = wired ? [first, ...already] : [first];` ⇒ 这里会数到 **2**（红 ✓）
  // 改后逐字：`const others = currentKey ? already.filter((item) => keyOf(item) !== currentKey) : already;`
  //          `const payload = wired ? [first, ...others] : [first];`
  // 依据 = 业务负责人 2026-10-16 本 bug（填了值点一下 ⇒ 值没了）＋ 引擎 `addItem` 的**覆盖 / 后写赢**语义
  //   （`test/multiItemOrderAddWire.test.js` 的 AC-MI-A2 只管"**另一款**那一页带着已加的" ✓ 本文件补它没管的这一格）。
  assert.equal(payload.filter((item) => item.product_record_id === 'rec_A').length, 1,
    '🔴 当前这件**只许在载荷里出现一次**（出现两次 ⇒ 提交时草稿那份旧值会**覆盖她刚填的** ✗✗）');
  assert.deepEqual(payload[0].entries, [],
    '首件的 `entries` 仍空（本次表单的由路由在提交时合并 ✓）—— 草稿那份旧的**一个字都不许进来** ✗');
  assert.equal(payload.length, 1, '🔴 顺带：这一页的载荷就**一件**（N=1 的那一单不许被平白撑成"多货品" ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CID-2 ⭐⭐ 端到端：她这次填的 41×1 **必须赢**（不许被草稿旧值 40×2 覆盖）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-CID-2 ⭐⭐ 她在表单里勾 41 码 × 1 ⇒ 引擎最后拿到的**就是 41×1**（旧的 40×2 不许赢 ✗）', async () => {
  const html = renderer.multiItemBlockHtml(writeContext(), { ...A, multi_items: [DRAFT_A] }, 'replenish');
  const { groups, entries } = await runChain({
    payload: payloadOf(html),
    formEntries: [{ size: '41', quantity: '1' }],   // = `parseReplenishEntries` 在这次表单上的产物形状 ✓
  });
  assert.equal(groups.length, 1, '路由那一步合出来就 **1 组**（当前这一件 ✓ 不是两组 ✗）');
  assert.deepEqual(entries, [{ size: '41', quantity: '1' }],
    '🔴 **她这次填的 41 码 × 1 必须在草稿里**（被旧的 40×2 覆盖 ⇒ 红 ✓ —— 那正是"填了值，点一下，值没了"）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CID-3 探针：把**修复前**那份载荷喂进同一条链 ⇒ 旧值赢（证明 AC-CID-2 真能红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-CID-3 ⭐⭐ 探针（修复前的载荷形状）⇒ 引擎最后拿到**旧值 40×2**（所以上面那条不是空跑 ✓）', async () => {
  const first = {
    product_record_id: A.product_record_id, number: A.number, item_no: A.item_no,
    color: A.color, supplier_record_id: A.supplier_record_id, entries: [],
  };
  // 改前逐字那份载荷：`[first, ...already]`（当前这件被带了**两次**）
  const broken = JSON.parse(renderer.multiItemPayloadJson([first, DRAFT_A]));
  assert.equal(broken.filter((item) => item.product_record_id === 'rec_A').length, 2,
    '探针：这就是**修复前**渲染器真实渲出来的那一份（同一件两次 ✓）');
  const { groups, entries } = await runChain({ payload: broken, formEntries: [{ size: '41', quantity: '1' }] });
  assert.equal(groups.length, 2, '探针：修复前 ⇒ 合成 **2 组**（明明只有一款 ✗）');
  assert.deepEqual(entries, [{ size: '40', quantity: 2 }],
    '🔴 探针：引擎最后拿到的是**草稿旧值**（`addItem` 后写的赢）⇒ 她刚填的 41×1 **静默没了** ✗✗'
    + '（⚠️ 这一份的 `quantity` 是**数字 2** —— 它来自草稿里那份（渲染成载荷时过了一次 `Number` ✓），'
    + '而"她这次表单填的"那一份是**字符串**（`parseReplenishEntries` 只做形状转换 ✓）—— 两种都在 ✓）');
  assert.equal(JSON.stringify(entries).includes('41'), false, '探针：她填的 41 一个字节都没进去 ✓（读得出来）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-CID-4 只排**载荷**、不许排**列表**（她刚加的那一件必须看得见 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-CID-4 ⭐ 列表照旧画**全部**已加的（她刚加的那一件看得见 ✓）；只有载荷把它排掉', () => {
  const html = renderer.multiItemBlockHtml(writeContext(), { ...A, multi_items: [DRAFT_A] }, 'replenish');
  assert.match(html, /data-view="multi-item-list"/, '已加货品列表要出现 ✓');
  assert.match(html, /<li class="multi-item-row">K1\|黑色\|A/, '🔴 她刚加的那一件**必须看得见**（排列表 ⇒ 她以为没加上 ✗）');
  assert.match(html, new RegExp(`data-multi-remove[^>]*name="${WIRE.removeField}"[^>]*value="rec_A"`),
    '那一行那颗删除按钮照旧带着该件 record_id ✓');
  // 🔴 零 JS 哨兵**未动**（既有 AC-W2 / AC-6R5 / RT5b 同口径）
  assert.doesNotMatch(html, /<script/i, '这一块里不许有 `<script>` ✗');
});
