/**
 * task-46「一单多货品」**路由半**的判据 RT1..RT8 —— **只动 `server/test/**`** ✓
 *
 * 形状依据：`docs/multi-item-route-anchors-2026-10-16.md`（§2/§3，已核过 `7ec5d6b` + `97808b6` 复算 ✓）
 *   · 隐藏字段渲的是 **首件 + `entries: []`（空）** ⇒ **路由必须把本次的尺码/数量并进「首件」** ✗ 否则丢第一件数量
 *   · `view.multi_items` ⇒ GET 渲染时要把草稿里**已加的货品**塞进去
 *   · ⭐ **N=1 ⇒ 原样调老函数、参数逐字不变**（等价靠"代码路径同一条"✓）
 *   · JSON 坏 / 非数组 / ≤1 组 ⇒ **回落老路径、引擎 0 次** ✓ · 拒单 ⇒ `respondWriteFailure` 人话 + 零写入 ✓
 *   · **零 JS 哨兵**（`AC-W2` / `AC-6R5`）⇒ 路由半**也不许**加 `<script>` ✗
 *
 * 🔴 **分阶段**（照 Lead 刚合的先例 `test/successPageAcceptance.test.js` 的 **AC-SP1c/SP1d** 手法 ✓）：
 *   · 今天**已经能真钉**的 ⇒ **真判据** ✓（RT2-静态 / RT5 / RT8 / 零 JS + 首件形状）
 *   · 需要**接线后才成立**的 ⇒ **待激活闸门**：**不假装通过** ✗（只打 `[待激活]` 一行 + `return` 主干），
 *     并配 **探针**证明"检测器**真能红**"✓（不是空跑 ✓）—— 接线后闸门**自动变真判据** ✓
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_route';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_route_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_mi_route';

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ROUTE_SRC = read('src/routes/scanPage.js');
const RENDERER_SRC = read('src/views/scanPageRenderer.js');

const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');
const { resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { multiItemPayloadJson, multiItemBlockHtml } = require('../src/views/scanPageRenderer');

// ═══════════════════════════════════════════════════════════════════════════
// 共用：把"老调用"的参数块抽出来（RT2-静态用它钉"参数逐字不变"）
// ═══════════════════════════════════════════════════════════════════════════
const argKeysOf = (source, callee) => {
  const at = source.indexOf(callee);
  if (at < 0) return null;
  const open = source.indexOf('({', at);
  const close = source.indexOf('});', open);
  if (open < 0 || close < 0) return null;
  const block = source.slice(open + 2, close);
  // 只取**顶层**键名（`key:` 出现在行首缩进处；跳过 `?? ''` 里的内容）
  return block
    .split('\n')
    .map((line) => line.trim())
    // ⚠️ 老调用里**两种写法都有**：`submitKey: body[...]`（带值）与 `entries,`（简写）⇒ 两种都要认 ✓
    .filter((line) => /^[a-zA-Z_$][\w$]*\s*[:,]/.test(line))
    .map((line) => line.match(/^([a-zA-Z_$][\w$]*)/)[1])
    .sort();
};

// ═══════════════════════════════════════════════════════════════════════════
// RT2-静态 ✅ 今天就是真判据：老调用的**参数名清单逐字不变**（N=1 等价的护栏）
// ═══════════════════════════════════════════════════════════════════════════

test('RT2-static ⭐⭐ 老调用（`submitReplenish` / `submitPurchaseReturn`）的**参数名逐字不变**', () => {
  // 🔴 能真红：在路由里给老调用**改一个键名 / 删一个键** ⇒ 红 ✓
  //    ⚠️ 这条钉的是"**N=1 走的就是这条路、就是这组参数**"（`main = 97808b6` 的实际值，逐字抄 ✓）
  assert.deepEqual(argKeysOf(ROUTE_SRC, 'writeService.submitReplenish'), [
    'entries', 'number', 'openId', 'productRecordId', 'requestId', 'submitKey',
  ], '补货老调用的参数名不许变 ✗（改了 ⇒ N=1 的"逐字等价"就没了）');
  assert.deepEqual(argKeysOf(ROUTE_SRC, 'writeService.submitPurchaseReturn'), [
    'entries', 'number', 'openId', 'orderAmount', 'productRecordId', 'requestId', 'submitKey',
  ], '退货老调用的参数名不许变 ✗（含 `orderAmount` ✓）');
});

test('RT2-static-probe ⭐ **探针**：上面那个抽取器**真能发现**改过的参数名（不是空跑 ✓）', () => {
  const fake = 'await writeService.submitReplenish({\n  openId,\n  number,\n  entries,\n  OOPS,\n});';
  assert.deepEqual(argKeysOf(fake, 'writeService.submitReplenish'), ['OOPS', 'entries', 'number', 'openId'],
    '探针：抽取器能看见键名 ✓ ⇒ 它**不是空跑** ✓');
  assert.notDeepEqual(argKeysOf(fake, 'writeService.submitReplenish'), [
    'entries', 'number', 'openId', 'productRecordId', 'requestId', 'submitKey',
  ], '探针：改过的键名 ⇒ 与真清单**不等** ✓（证明 RT2-static 能红）');
});

// ═══════════════════════════════════════════════════════════════════════════
// RT5 ✅ 今天就是真判据：`routes/*` 不许出现写链路服务名 · 不许有 `<script>`
// ═══════════════════════════════════════════════════════════════════════════

const WRITE_CHAIN_NAMES = ['purchaseWebhookService', 'purchaseReturnService', 'PurchaseWebhookService'];

/**
 * 🔴 **先剥注释再扫** —— 与仓库既有源码哨兵同一口径 ✓
 *   起因（2026-10-16 真发现）：`routes/scanPage.js` 里**本来就有**一句注释提到
 *   `scanWriteService.submitPurchaseReturn` → `purchaseReturnService`（讲"写库在既有构件里"✓）
 *   ⇒ 不剥注释的话，这条哨兵**今天就是红的**（那是**假红** ✗ —— 违规的是"代码里 require/调它"，不是注释）
 *   ⚠️ 剥法用**行位锚定**（只丢"整行就是注释"的行）—— 不用 `[\s\S]*?` 那种多字符清洗
 *   （CodeQL `js/incomplete-multi-character-sanitization` 会点名 ✗，本会话已吃过一次亏 ✓）
 */
const stripCommentLines = (source) => source
  .split('\n')
  .filter((line) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
  })
  .join('\n');

const writesChainOffenders = (source) => WRITE_CHAIN_NAMES.filter((name) => stripCommentLines(source).includes(name));

test('RT5 🔴 `routes/scanPage.js` **不出现写链路服务名**（只用 `writeService.multiItemWriters()` ✓）', () => {
  assert.ok(ROUTE_SRC.includes('require('), '先确认读到的确实是路由源码（防空文件假绿 ✗）');
  assert.deepEqual(writesChainOffenders(ROUTE_SRC), [],
    '🔴 路由里**一个写链路服务名都不许有** ✗（新链路也要走 `writeService.multiItemWriters()` ✓）');
});

test('RT5b 🔴 **零 JS 哨兵**：路由与多货品块里都**不许**有 `<script>`（`AC-W2` / `AC-6R5` 同口径 ✓）', () => {
  assert.equal(/<script/i.test(ROUTE_SRC), false, '路由源码里不许有 `<script>` ✗');
  // 把多货品块**真渲一次**（渲染器已导出它 ✓）⇒ 渲出来的 HTML 也不许有脚本 ✓
  const html = multiItemBlockHtml(
    { postAction: '/s/K1', texts: {} },
    { product_record_id: 'rec_x', number: 'K1|黑色|A', item_no: 'K1', color: '黑色', supplier_record_id: 'sup_x' },
  );
  assert.ok(html.length > 0, '多货品块应当渲得出来（`enabled=true` ✓ 字段名有值 ✓）');
  assert.equal(/<script/i.test(html), false, '多货品块**零 JS** ✓（AC-6R5 同口径）');
  assert.equal(/on(click|change|submit)=/i.test(html), false, '也不许内联事件处理器 ✗（等价于 JS）');
});

test('RT5c ⭐ **探针**：上面两个检测器**真能红** ✓', () => {
  assert.notDeepEqual(writesChainOffenders("const x = require('../services/purchaseReturnService');"), [],
    '代码里 require 写链路服务 ⇒ **必须**报红 ✓');
  assert.deepEqual(writesChainOffenders("// 写库在既有构件里：scanWriteService.submitPurchaseReturn → purchaseReturnService"), [],
    '⚠️ 口径：**整行注释**里提到它 ⇒ **不算违规** ✓（与仓库既有哨兵同口径 ✓ —— 今天路由里就有这么一句）');
  assert.notDeepEqual(writesChainOffenders("  const y = new PurchaseWebhookService({ gateway });"), [],
    '代码里 `new PurchaseWebhookService(...)` ⇒ **必须**报红 ✓');
  assert.equal(/<script/i.test('<div><script>1</script></div>'), true, '塞进 `<script>` ⇒ **必须**命中 ✓');
  assert.equal(/<script/i.test('<div class="multi-item">ok</div>'), false, '干净 HTML ⇒ 不命中 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 「首件 + 空 entries」的形状 ✅ 今天就是真判据（**路由必须把 entries 并进首件**）
// ═══════════════════════════════════════════════════════════════════════════

test('RT-shape ⭐⭐ 隐藏字段渲的是【首件 + `entries: []`（空）】⇒ 路由**必须**把本次尺码/数量并进首件', () => {
  const payload = JSON.parse(multiItemPayloadJson([{
    product_record_id: 'rec_x', number: 'K1|黑色|A', item_no: 'K1', color: '黑色',
    supplier_record_id: 'sup_x', entries: [],
  }]));
  assert.equal(payload.length, 1, '隐藏字段只装**首件**一个 ✓');
  assert.deepEqual(Object.keys(payload[0]).sort(), [
    'color', 'entries', 'item_no', 'number', 'product_record_id', 'supplier_record_id',
  ], '形状 = 设计 §4.3（键名逐字 ✓）');
  assert.deepEqual(payload[0].entries, [],
    '🔴 **首件的 `entries` 是空的** —— 渲染器把"并进去"这件事**留给路由**（`scanPageRenderer.js:1259` 逐字注明了 ✓）'
    + ' ⇒ 路由半**必须**把这次的尺码/数量塞进首件 ✗ 否则多货品单会**丢掉第一个货品的数量** ✗');
  // `quantity` 是 Number、`size` 是字符串（渲染器的口径 ✓）
  const withEntry = JSON.parse(multiItemPayloadJson([{ entries: [{ size: '40', quantity: 2 }] }]));
  assert.equal(typeof withEntry[0].entries[0].quantity, 'number', '`quantity` 是**数字** ✓');
  assert.equal(typeof withEntry[0].entries[0].size, 'string', '`size` 是**字符串** ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// RT8 ✅ 今天就是真判据：明细的**「采购行为」两列**真的会进**落库载荷**
// ═══════════════════════════════════════════════════════════════════════════

test('RT8 ⭐⭐ 走路由将来那条路（`multiItemWriters().behavior(chain)` ⇒ 引擎载荷）⇒ **两列真有值**', async () => {
  // ① 假 `references`（`scanWriteService.js` 支持 `options.references` ✓）⇒ 拿到"解析好的行为"
  const fake = { resolveBehavior: async (code) => ({ recordId: `rec_behavior_${code}`, kind: 'purchase_request' }) };
  const write = createScanWriteService({ gateway: {}, config: SCAN_WRITE, references: fake });
  const writers = write.multiItemWriters();
  const behavior = await writers.behavior('replenish');
  assert.equal(behavior.recordId, `rec_behavior_${SCAN_WRITE.replenish.behaviorCode}`,
    '行为来自**配置里的编码** ✓（不是自己查表 / 写死 ✗）');

  // ② 引擎按路由的用法算载荷 ⇒ **落库载荷**（= 交给既有写入件的那份）里两列必须在 ✓
  const engine = createMultiItemOrderService({
    sessions: { idOf: (o) => `s_${o}`, store: { get: async () => null, update: async () => null }, ensure: async () => ({}) },
    config: resolveMultiItemOrderConfig({}),
  });
  const groups = [{ productRecordId: 'rec_K1', number: 'K1|黑色|A', itemNo: 'K1', color: '黑色', supplierRecordId: 'sup_K1', entries: [{ size: '40', quantity: '2' }] }];
  const items = engine.groupPayload({ groups }).items;
  const checked = engine.validateDraft({
    draft: { items, order_amount: '399' }, chainConfig: engineConfigChains().replenish,
  });
  assert.equal(checked.ok, true);
  const plan = engine.planSubmission({
    draft: { items: checked.normalized.items, open_id: 'ou_me' },
    chainConfig: engineConfigChains().replenish, submitKey: 'scan_replenish:s:1', behavior,
  });
  const line = plan.payload.items[0];
  assert.equal(line.behavior_record_id, behavior.recordId,
    '🔴 **落库载荷**里必须有「采购行为」记录列 ✓（不是"引擎返回值里有" ✓）⇒ 去掉 `behavior` 传参 ⇒ 红 ✓');
  assert.equal(line.behavior_kind, 'purchase_request', '「行为类型」列也要有 ✓');
  // 退货那条链**不写**这两列（`withBehavior: false` ✓ 与老路径同口径）
  const retPlan = engine.planSubmission({
    draft: { items: checked.normalized.items, open_id: 'ou_me' },
    chainConfig: engineConfigChains().return, submitKey: 'scan_return:s:1', behavior,
  });
  assert.equal('behavior_record_id' in retPlan.payload.items[0], false,
    '退货那条链**明细致列不带行为** ✓（与 `AC-R2` 同口径 ✓）');
});

const engineConfigChains = () => resolveMultiItemOrderConfig({}).chains;

// ═══════════════════════════════════════════════════════════════════════════
// ⏳ 待激活闸门（接线后**自动变真判据** ✓ 今天**不假装通过** ✗）
// ═══════════════════════════════════════════════════════════════════════════

const isWired = (source) => /multi_items/.test(source) && /multiItemWriters\(\)/.test(source);

test('RT1/RT2-运行时 ⏳ 分组 >1 ⇒ 引擎；`≤1` ⇒ 原样老函数（引擎 0 次）', () => {
  if (!isWired(ROUTE_SRC)) {
    // 🔴 不假装通过 ✗：只记一句"待激活"，并靠 RT1-probe 证明检测器**真能红** ✓
    console.log('[RT1/RT2] 待激活：`routes/scanPage.js` 还没接多货品（未出现 `multi_items` / `multiItemWriters()`）');
    return;
  }
  // 接线后 ⇒ 从这里开始是**真判据** ✓
  assert.ok(/groups\.length\s*>\s*1/.test(ROUTE_SRC), '要有「>1 组才走引擎」的分流 ✓');
  assert.ok(ROUTE_SRC.includes('multiItemWriters()'), '引擎写入件要经 `writeService.multiItemWriters()` ✓（RT5 ✓）');
  assert.ok(/openDraft|addItem|submitDraft/.test(ROUTE_SRC), '要真调引擎（`openDraft`/`addItem`/`submitDraft` ✓）');
});

test('RT1-probe ⭐ **探针**：接线检测器与分流正则**真能红** ✓（证明 RT1/RT2 那半不是空跑）', () => {
  assert.equal(isWired('const field = "multi_items"; writeService.multiItemWriters();'), true,
    '探针：出现接线标记 ⇒ 检测器**认得** ✓');
  assert.equal(isWired('const x = 1;'), false, '探针：没有标记 ⇒ 检测器**不认** ✓');
  assert.equal(/groups\.length\s*>\s*1/.test('if (groups.length > 1) {'), true, '分流正则命中 ✓');
  assert.equal(/groups\.length\s*>\s*1/.test('if (groups.length >= 1) {'), false,
    '⚠️ 写成 `>= 1` ⇒ **不命中** ✓（这条正则钉的正是"`≤1` 也要回落" ✓ —— 写错就红 ✓）');
});

test('RT6 ⏳ JSON 坏 / 不是数组 / `≤1` 组 ⇒ **回落老路径、引擎 0 次**', () => {
  // ✅ 今天就能真钉的一半：引擎的入口在**坏输入**下只会得到空 `items`（不会炸 ✗ 不会编 ✗）
  const engine = createMultiItemOrderService({
    sessions: { idOf: (o) => `s_${o}`, store: { get: async () => null, update: async () => null }, ensure: async () => ({}) },
    config: resolveMultiItemOrderConfig({}),
  });
  for (const bad of [null, undefined, 'not-an-array', { groups: 'nope' }]) {
    const out = engine.groupPayload({ groups: bad });
    assert.deepEqual(out.items, [], `坏输入 ${JSON.stringify(bad)} ⇒ **空 items**（⇒ 路由据此回落 ✓ 不许编 ✗）`);
  }
  if (!isWired(ROUTE_SRC)) {
    console.log('[RT6] 待激活：路由还没有 `parseMultiItemGroups`（接 `multi_items` 的解析）');
    return;
  }
  assert.ok(/parseMultiItemGroups/.test(ROUTE_SRC), '要有分组解析函数 ✓（JSON 坏 ⇒ `[]` ✓）');
  assert.ok(/Array\.isArray/.test(ROUTE_SRC), '解析里要判"是不是数组" ✓');
});

test('RT6-probe ⭐ **探针**：坏输入的检测器**真能红** ✓', () => {
  const engine = createMultiItemOrderService({
    sessions: { idOf: (o) => `s_${o}`, store: { get: async () => null, update: async () => null }, ensure: async () => ({}) },
    config: resolveMultiItemOrderConfig({}),
  });
  const good = engine.groupPayload({ groups: [{ productRecordId: 'rec_1', entries: [{ size: '40', quantity: '1' }] }] });
  assert.equal(good.items.length, 1, '正常输入 ⇒ 1 组 ✓（证明上面那条不是在比对"永远空" ✓）');
});

test('RT3/RT4 ⏳ 拒单 ⇒ `respondWriteFailure` 人话 + **零写入**（含退货缺整单金额）', () => {
  if (!isWired(ROUTE_SRC)) {
    console.log('[RT3/RT4] 待激活：路由还没接多货品（拒单分支与金额闸门要在接线时一起落）');
    return;
  }
  assert.ok(ROUTE_SRC.includes('respondWriteFailure'), '拒单要复用既有 `respondWriteFailure` ✓（人话 ✓）');
  assert.ok(/purchaseAmountMissing|purchaseAmountInvalid/.test(ROUTE_SRC), '退货整单金额要先用既有闸门判 ✓');
});

test('RT3-probe ⭐ **探针**：拒单时引擎**真的不写**（假写入件 0 次 ✓）', async () => {
  const writes = [];
  const config = resolveMultiItemOrderConfig({});
  const engine = createMultiItemOrderService({
    // 内存 store（**真能读回** ⇒ 走到"重复拦截"而不是 `draft_missing` ✓）
    sessions: (() => {
      const records = new Map();
      const idOf = (o) => `s_${o}`;
      const store = {
        get: async (id) => (records.has(id) ? JSON.parse(JSON.stringify(records.get(id))) : null),
        create: async (task) => { records.set(task.session_id, JSON.parse(JSON.stringify(task))); return { ...task }; },
        update: async (id, patchOrMutator) => {
          const current = records.has(id) ? JSON.parse(JSON.stringify(records.get(id))) : null;
          const patch = typeof patchOrMutator === 'function' ? patchOrMutator(current) : patchOrMutator;
          const next = { ...(current || {}), ...(patch || {}) };
          records.set(id, next);
          return { ...next };
        },
      };
      return {
        idOf,
        store,
        ensure: async (o) => {
          if (!records.has(idOf(o))) await store.create({ session_id: idOf(o), open_id: String(o || '') });
          return store.get(idOf(o));
        },
      };
    })(),
    config,
    writers: {
      purchase: async (taskId, payload) => { writes.push({ taskId, payload }); },
      purchaseReturn: async (taskId, payload) => { writes.push({ taskId, payload }); },
    },
  });
  const opened = await engine.openDraft({ openId: 'ou_me', chain: 'replenish' });
  await engine.addItem({
    openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey,
    item: { product_record_id: 'rec_K1', number: 'K1', item_no: 'K1', entries: [{ size: '40', quantity: '1' }, { size: '40', quantity: '2' }] },
  });
  const rejected = await engine.submitDraft({ openId: 'ou_me', chain: 'replenish', orderKey: opened.orderKey, submitKey: opened.orderKey, behavior: {} });
  assert.equal(rejected.ok, false, '同货号同尺码重复 ⇒ 拒单 ✓');
  assert.equal(rejected.code, 'duplicate_line');
  assert.equal(typeof rejected.message, 'string', '要有**人话** ✓（路由直接把它交给 `respondWriteFailure` ✓）');
  assert.deepEqual(writes, [], '🔴 拒单 ⇒ **零写入** ✓（假写入件一次都没被调 ✓）');
});
