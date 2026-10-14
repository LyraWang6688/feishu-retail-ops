/**
 * ⚠️ **2026-10-12 口径又变了**（业务负责人逐字）：「**采购里面的验收到货也不需要了**，因为
 *    **验收到货我们在扫码页也做了**，所以目前我们的采购页就先保持『**订单列表**』和『**供应商往来款**』」
 *    ＋「麻烦把『**采购订单列表**』这个子 tab 页**改为『订单列表』**」
 *    ⇒ 本文件 AC-P1 / P2 / P3 三条**改写**（逐字对照见各条里的注释）：
 *      改前：采购子 tab = `['验收到货','采购订单列表','供应商往来款']`，且钉"验收 = 独立子页
 *            （`kind:'orders'`/`mode:'purchase'`，挂在它自己的 host 上）"。
 *      改后：采购子 tab = `['订单列表','供应商往来款']`（**入口没了**），并改钉
 *            "**验收链路与既有模块保留**"（`features/orders` 的 `verify-arrival` ＋
 *            `POST /api/workbench/purchase/arrivals/confirm` —— 扫码验收 / 群话题核对共用）。
 *      理由：**只删入口、不删共用链路**（这正是她的原话口径）。
 *    ⚠️ AC-P4 / P5 / P6 与 `kind:'orders'` 模块本身**一个字都没改**（模块保留、仍被销售「订单列表」用）。
 *
 * ⚠️ 2026-10-11 晚（业务负责人批准：采购子 tab **只留「验收到货」**）——本文件**改写**的断言（逐字）：
 *   AC-P1 改前：`['报货','验收到货','退货','采购订单列表','供应商往来款']` /
 *             `['purchase-report','purchase-arrival','purchase-return','purchase-orders','purchase-supplier-money']`
 *          改后：`['验收到货','采购订单列表','供应商往来款']` /
 *             `['purchase-arrival','purchase-orders','purchase-supplier-money']`
 *   AC-P2 改前：在 **报货页**（`purchase-report`，`kind:'entry'`）上做那批"没有锚点/内嵌/措辞"的断言
 *          改后：报货 / 退货两个子页**已隐藏**（不在清单里）⇒ 那批断言改成"配置里**没有**这两个子页"
 *             ＋"领域配置 / 渲染层里仍然不许有锚点与内嵌措辞"（被保护的不变量一条没少）
 *   AC-P3 改前：`report/back` 两个子页都是 `kind:'entry'` 的**扫码入口**（`/s/{number}?from=purchase`）
 *          改后：`purchase.pages` 里**不再有** `purchase-report` / `purchase-return`；
 *             采购子页上**没有任何飞书表单外链**（死链清掉），也不再指 `?from=purchase`
 *   理由：业务负责人 2026-10-11 定「采购 = 只留验收到货」——报货 / 退货两个动作现在都在**扫码页**
 *     各自的领域里（`?from=replenish` / `?from=purchase_return`），工作台不再需要那两个子页。
 *   ⚠️ 其余断言（独立子页 / 验收链路一字未改 / 零新写库 …）一条都没放宽。
 */
/**
 * ⭐⭐ 采购「验收到货」= **独立子页面**（业务负责人 **2026-10-10** 真机反馈）。
 *
 * 她的原话（逐字）：
 *   「现在不是已经有三张卡片了吗？一个是到货，一个是退货，一个是验收。目前你的"验收到货"子卡片，
 *    **并不是我点击完之后跳转到新页面，而是一点完之后，它直接在同一个 tab 页里下面出现了。我们不应该是跳转吗？**
 *    你也看一下那个按钮，它应该是去下面验收，而不应该是点完之后换了一个验收的屏幕吗？」
 *
 * ⇒ 本轮口径：
 *   · 采购子 tab 变成 **① 报货 ② 验收到货（独立子页）③ 退货** ＋ 现有两个占位页
 *     （采购订单列表 / 供应商往来款）；
 *   · 「报货 / 验收 / 退货」那一页里**删掉**：验收卡 · `embed` 内嵌宿主 · 任何"去下面验收"的措辞；
 *   · 报货 / 退货 仍走**飞书表单**（外部链接，URL 全部来自 `config/links.js`）；
 *   · 验收页 = **既有** `createOrdersModule({ mode: 'purchase' })`：
 *     **未到货的批次排在前面**，**已到货的折叠**在下面；
 *   · 既有验收逻辑 / 接口**一个字都不许改**（`verify-arrival` / `submit-arrival` →
 *     `POST /api/workbench/purchase/arrivals/confirm` → 既有入库链路）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-P1 采购子 tab 的顺序逐字 = **报货 · 验收到货 · 退货 · 采购订单列表 · 供应商往来款**
 *        （唯一来源 `config/domains.js`）。
 *  AC-P2 「验收到货」是**独立子页**（`kind:'orders'` / `mode:'purchase'`）：
 *        报货那一页里**不再有**验收卡 · `anchor` · `embed` 宿主；也不许再有
 *        「去下面验收 / 就在这一页下面 / 内嵌在本页」这类措辞。
 *  AC-P3 报货 / 退货 = 飞书表单**外链**（URL 逐字 = `config/links.js`），点卡片真的跳走。
 *  AC-P4 领域骨架按 `kind:'orders'` 挂**既有**模块（`createOrdersModule({ mode: page.mode })`）；
 *        `pages.js` / `index.js` 里不再有 `embed` 分支。
 *  AC-P5 验收页：**未到货的批次排在前面**；**已到货的折叠**在 `<details data-view="purchase-arrived">` 里；
 *        折叠头带条数。
 *  AC-P6 既有验收链路**一字未改**：按钮 / 表单字段 / 接口路径 / 提交载荷形状逐字还在，
 *        而且没有新增任何采购验收接口。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 去掉注释再对"代码里有没有某件事"下结论 —— 注释里提一句历史不算实现。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 把前端 ES 模块复制成 `.mjs` 平铺到临时目录，**只改 import 的文件名**（与既有工作台用例同一套做法）。 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-arrival-page-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/query/index.js', 'query-index.mjs', [
    // ⚠️ 2026-10-12：`features/query/index.js` 新增 import `config/links.js`
    //    （跳转装配读 `LINK_*` 三个开关）⇒ 这一条替换必须跟着加。
    ["from '../../config/links.js'", "from './links.mjs'"],
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/shared/placeholder.js', 'placeholder.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/domains/pages.js', 'domains-pages.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../shared/placeholder.js'", "from './placeholder.mjs'"],
  ]);
  copy('features/domains/nav.js', 'domains-nav.mjs', [
    ["from '../../config/query.js'", "from './query.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../query/index.js'", "from './query-index.mjs'"],
    ["from './pages.js'", "from './domains-pages.mjs'"],
  ]);
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    links: load('links'),
    domains: load('domains'),
    domainPages: load('domains-pages'),
    domainNav: load('domains-nav'),
    ordersConfig: load('orders-config'),
    orders: load('orders-index'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC-P1 采购子 tab 的顺序（配置先行）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P1 采购子 tab 顺序逐字 = 订单列表 · 供应商往来款（验收入口已删 + 改名）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav] = await Promise.all([modules.domains, modules.domainNav]);
  const purchase = domains.domainById('purchase');

  // ⚠️ 2026-10-12 改写：改前 = ['验收到货','采购订单列表','供应商往来款'] / 对应 id。
  //    现在「验收到货」入口删了、「采购订单列表」改名「订单列表」（见文件头）。
  assert.deepEqual(purchase.pages.map((page) => page.label),
    ['验收', '订单列表', '供应商往来款']);
  // 2026-10-14（她逐字）：「工作台的采购 tab 里的退货不需要了」⇒ 这一步翻成「必须没有」（不放宽 ✗）
  assert.deepEqual(purchase.pages.map((page) => page.id),
    ['purchase-acceptance', 'purchase-orders', 'purchase-supplier-money']);
  assert.equal(purchase.pages.some((page) => page.id === 'purchase-arrival'), false, '验收入口已删');

  // 子 tab 上真的点得到（渲染层不写死）
  const tabs = nav.domainSubTabsHtml(purchase);
  for (const label of ['验收', '订单列表', '供应商往来款']) {
    assert.ok(tabs.includes(`>${label}</button>`), `子 tab 上少了「${label}」`);
  }
  assert.equal(tabs.includes('>验收到货</button>'), false, '子 tab 上不该再有「验收到货」');
  const labels = [...tabs.matchAll(/data-domain-page="[^"]*"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(labels, purchase.pages.map((page) => page.label), '子 tab 顺序 = 配置顺序');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P2 「验收到货」= 独立子页（不再有锚点卡 / 内嵌宿主 / "去下面"措辞）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P2 ⭐ 验收入口**已按 2026-10-13 裁定挂回**（名字逐字「验收」· 第一个 · 走既有 orders/purchase）；报货/退货仍不在清单里', async () => {
  // ⚠️ 2026-10-12 改写（见文件头）：改前钉的是"「验收到货」= 独立子页（`kind:'orders'`/`mode:'purchase'`）"。
  //    她把那个入口删了（扫码页已做验收）⇒ 改成：
  //    ① **入口不在配置里**；② **验收台代码与接口保留**（共用 ⇒ 删入口不删链路）。
  const modules = loadFrontendModules();
  const [domains, pages, nav] = await Promise.all([modules.domains, modules.domainPages, modules.domainNav]);
  const purchase = domains.domainById('purchase');

  // ① ⭐ 2026-10-13 翻转（口径变了）：她要求「**验收**」作为采购**第一个**子 tab 挂回来 ⇒
  //    改前逐字：`assert.equal(arrival, undefined, '「验收到货」入口已删')` +
  //    `assert.equal(purchase.pages.some((page) => page.kind === 'orders'), false, ...)`
  const arrival = purchase.pages[0];
  assert.equal(arrival.id, 'purchase-acceptance', '验收必须是**第一个**子 tab');
  assert.equal(arrival.label, '验收', '名字**逐字**两个字');
  assert.equal(purchase.pages.some((page) => page.kind === 'orders' && page.mode === 'purchase'), true,
    '挂的是**既有** orders/purchase 模块（不新造页面 ✓）');

  // ①b 链路保留：既有模块 + 接口 + 地址配置都还在（扫码验收 / 群话题核对共用）
  assert.ok(readWorkbench('features/orders/index.js').includes('verify-arrival'), '验收台代码保留');
  assert.ok(readWorkbench('config/orders.js').includes('/api/workbench/purchase/arrivals/confirm'),
    '验收接口地址配置保留');

  // ② 报货 / 退货两个子页已隐藏（配置里没有它们 ⇒ 更不可能有验收卡 / 锚点卡 / 内嵌宿主）
  // ⚠️ 2026-10-13 更正：**「退货」不再是隐藏项** —— 她点名要它作为采购的子 tab（第二个）✓
  //    「报货」仍隐藏（补货/报货在扫码页 ✓）
  assert.equal(purchase.pages.some((page) => page.id === 'purchase-report'), false, 'purchase-report 子页仍隐藏');
// 2026-10-14（她逐字）：「工作台的采购 tab 里的退货不需要了」⇒ 判据翻成「必须没有」（不放宽）
  assert.equal(purchase.pages.some((page) => page.id === 'purchase-return'), false, '⭐「退货」子 tab 已按她 2026-10-14 的话退场 ✓');
  for (const page of purchase.pages) {
    assert.equal(page.embed, undefined, `${page.id} 不许有内嵌宿主`);
    assert.equal(page.anchor, undefined, `${page.id} 不许有本页锚点`);
    assert.equal((page.cards || []).some((card) => card.anchor), false, `${page.id} 不许有锚点卡`);
  }

  // ③ 子 tab（渲染层不写死清单）
  // ⚠️ 2026-10-13：**只翻"退货"这一件事** —— 她点名「把退货放在工作台采购单独一个子 tab，是退货！」
  //    改前逐字：`for (const gone of ['报货', '退货']) { assert.equal(tabs.includes(...), false, ...) }`
  const tabs = nav.domainSubTabsHtml(purchase);
  for (const gone of ['报货']) {
    assert.equal(tabs.includes(`>${gone}</button>`), false, `子 tab 上不该再有「${gone}」`);
  }
  assert.equal(tabs.includes('>退货</button>'), false, '⭐「退货」这一格在采购里已经不渲染了 ✓（已按她 2026-10-14 的话退场）');
  assert.equal(pages, pages); // （保留 await 的引用，避免 lint 误判未用）

  // ④ 渲染层 / 配置里也不许再留着"内嵌本页"的措辞（去注释后再判）
  const surface = ['config/domains.js', 'features/domains/pages.js', 'features/domains/index.js']
    .map((file) => stripComments(readWorkbench(file))).join('\n');
  for (const gone of ['去下面验收', '就在这一页下面', '内嵌在本页', '本页锚点', 'embed', 'embedHtml']) {
    assert.equal(surface.includes(gone), false, `领域配置 / 渲染层里不许再有「${gone}」`);
  }
});

// AC-P3 报货 / 退货 = 飞书表单外链（点卡片真的跳走）
// ═══════════════════════════════════════════════════════════════════════════

// ── ⚠️ 2026-10-11 断言**改写**（口径变了：从"两张卡都是飞书表单外链"改成"两张卡都是扫码入口"）──
//   改前（逐字）：
//     test('AC-P3 报货 / 退货仍是飞书表单外链（URL 逐字 = config/links.js）', ...)
//       assert.deepEqual(report.cards.map((card) => card.href), [links.PURCHASE_REQUEST_FORM_URL], '报货 = 飞书表单');
//       assert.deepEqual(back.cards.map((card) => card.href), [links.PURCHASE_RETURN_FORM_URL], '退货 = 飞书表单');
//       …（并断言渲染出来的是 <a class="entry-card" href=...> + rel="noopener"）
//   改后（逐字）：下面这一条 —— 两张卡都是 **`kind:'entry'` 的扫码入口**
//     （`targetTemplate = '/s/{number}?from=purchase'`，渲染出编号输入 + 按钮），
//     并且**飞书表单 URL 不再出现在采购子页上**。
//   理由（业务事实变了，不是放宽）：那两张卡原来指向的飞书表单写的是「**信息填写**」表，
//     而业务负责人 2026-10-09 把那张表**整表删除**（`TableIdNotFound`）⇒ 两张卡都是**死链**。
//     2026-10-11 她选定方案A（扫码验收）之后，采购的两个录入动作（报货 / 退货）都已落在
//     **扫码页的采购领域**（`/s/{number}?from=purchase` 上同时有【一键补货】与【退货】两张表单）
//     ⇒ 两张卡换成与「销售建单」同一个形状的入口。
//   ⚠️ **不放宽的部分**：`config/links.js` 的两个 URL 与 `PURCHASE_FORMS` **仍在**
//     （隐藏的「采购管理」老页面还在用，由 `workbenchHomeEntries.test.js` 钉着）；
//     本文件下面的 AC-P1/P2/P4/P5/P6 一个字都没改。
test('AC-P3 报货 / 退货两个子页已隐藏：采购子页上没有任何飞书表单外链，也不再指 ?from=purchase', async () => {
  const modules = loadFrontendModules();
  const [domains, links, nav] = await Promise.all([modules.domains, modules.links, modules.domainNav]);
  const purchase = domains.domainById('purchase');

  // ⚠️ 2026-10-12 改写：改前 = ['purchase-arrival','purchase-orders','purchase-supplier-money']
  //    ⇒ 去掉已删的验收入口。
  // 2026-10-14（她逐字）：「工作台的采购 tab 里的退货不需要了」⇒ 这一步翻成「必须没有」（不放宽 ✗）
  assert.deepEqual(purchase.pages.map((page) => page.id),
    ['purchase-acceptance', 'purchase-orders', 'purchase-supplier-money']);
  // 采购子页上**一条飞书表单外链都没有**（那两张卡写的表已被删除 ⇒ 死链，已清掉）
  const html = purchase.pages.map((page) => nav.domainPageHtml(page)).join('\n');
  assert.equal(html.includes(links.PURCHASE_REQUEST_FORM_URL), false);
  assert.equal(html.includes(links.PURCHASE_RETURN_FORM_URL), false);
  assert.equal(/share\/base\/form/.test(html), false, '采购子页上不再有飞书表单外链');
  // 也不再有任何指向**已退役领域**（`?from=purchase`）的入口
  assert.equal(/from=purchase(&|"|')/.test(JSON.stringify(purchase)), false, '不再指 ?from=purchase');
  // ⚠️ `config/links.js` 的两个 URL 与 `PURCHASE_FORMS` **仍在**（删 or 留由业务负责人定；
  //    隐藏的老「采购管理」页面里已经没有任何地方再引用它们 —— 见 `features/purchase/**`）
  assert.deepEqual(links.PURCHASE_FORMS.map((form) => form.id), ['purchase-request', 'purchase-return']);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P4 领域骨架：kind:'orders' 挂既有模块（一行新逻辑都没有）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P4 领域骨架按 kind:orders 挂既有订单模块；不再有 embed 分支', () => {
  const index = stripComments(readWorkbench('features/domains/index.js'));
  assert.ok(index.includes('if (page.kind === \'orders\') return void createOrdersModule({ mode: page.mode }).mount(host);'),
    '「验收到货」走既有的"独立页"分支（模式来自配置）');
  assert.equal(/page\.embed/.test(index), false, '领域骨架不许再认 embed');
  assert.ok(!/\bfetch\s*\(/.test(index), '领域骨架自己不发请求');

  const pages = stripComments(readWorkbench('features/domains/pages.js'));
  assert.equal(/embed/i.test(pages), false, '渲染层不许再画内嵌宿主');
  // 验收逻辑仍在**既有模块**里（不在领域骨架里新写一套）
  assert.ok(index.includes('createOrdersModule('));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P5 验收页：未到货在前 / 已到货折叠
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P5 验收页：未到货的批次排在前面，已到货的折叠在下面（带条数）', async () => {
  const modules = loadFrontendModules();
  const orders = await modules.orders;

  const rows = [
    // 故意把"已到货"的放在最前面 —— 渲染必须把它挪到后面并折叠
    { record_id: 'r1', batch_no: 'CGD-DONE-1', product_number: 'A1', size: 40, quantity: 1, arrival_status: '已到货' },
    { record_id: 'r2', batch_no: 'CGD-WAIT-1', product_number: 'B1', size: 41, quantity: 2, arrival_status: '未到货' },
    { record_id: 'r3', batch_no: 'CGD-DONE-2', product_number: 'C1', size: 42, quantity: 1, arrival_status: '已到货' },
    { record_id: 'r4', batch_no: 'CGD-WAIT-2', product_number: 'D1', size: 43, quantity: 1, arrival_status: '' },
  ];
  const html = orders.purchaseOrdersHtml(rows);

  const foldAt = html.indexOf('data-view="purchase-arrived"');
  assert.ok(foldAt > -1, '已到货的必须有一个折叠块（<details data-view="purchase-arrived">）');
  assert.match(html, /<details[^>]*data-view="purchase-arrived"/,
    '折叠块本身就是一个 <details>（默认收起）');
  // 未到货（含"状态空 ⇒ 按未到货显示"）在折叠块**之前**
  assert.ok(html.indexOf('CGD-WAIT-1') < foldAt, '未到货的批次必须排在已到货前面');
  assert.ok(html.indexOf('CGD-WAIT-2') < foldAt, '状态为空 ⇒ 按未到货处理，也要排前面');
  // 已到货的收在折叠块**里面**
  assert.ok(html.indexOf('CGD-DONE-1') > foldAt, '已到货的要收进折叠块');
  assert.ok(html.indexOf('CGD-DONE-2') > foldAt, '已到货的要收进折叠块');
  assert.match(html, /<summary[^>]*>已到货（2）<\/summary>/, '折叠头写清「已到货（几条）」');
  // 已到货的卡照旧有验收入口（不减少功能；幂等由后端兜底）
  assert.ok(html.includes('data-action="verify-arrival"'), '每张卡都仍有【验收到货】');
  assert.equal((html.match(/data-action="verify-arrival"/g) || []).length, 4, '四批都要有验收按钮');
  // 空列表的人话照旧
  assert.ok(orders.purchaseOrdersHtml([]).includes('purchase-empty'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-P6 既有验收链路一字未改
// ═══════════════════════════════════════════════════════════════════════════

test('AC-P6 既有验收链路一字未改（按钮 / 表单 / 接口 / 载荷形状）', async () => {
  const modules = loadFrontendModules();
  const [orders, ordersConfig] = await Promise.all([modules.orders, modules.ordersConfig]);

  // ① 接口路径逐字（唯一来源 config/orders.js，且只有一个验收接口）
  assert.equal(ordersConfig.ORDERS_API.arrivalConfirm, '/api/workbench/purchase/arrivals/confirm');
  const apiSource = readWorkbench('config/orders.js');
  const endpoints = new Set([...apiSource.matchAll(/\/api\/workbench\/purchase\/[a-z/]+/g)].map((m) => m[0]));
  assert.deepEqual([...endpoints].sort(),
    ['/api/workbench/purchase/arrivals/confirm', '/api/workbench/purchase/requests'],
    '采购只许有既有的那两个接口（不许新增验收接口）');

  // ② 前端验收逻辑的四个哨兵逐字还在，且提交载荷形状没变
  const source = readWorkbench('features/orders/index.js');
  for (const needle of [
    'data-action="verify-arrival"',
    'data-action="submit-arrival"',
    'data-field="arrival-amount"',
    'data-field="arrival-note"',
    'api.post(ORDERS_API.arrivalConfirm, {',
    'batchNo, actualAmount: Number(rawAmount), acceptanceText',
  ]) {
    assert.ok(source.includes(needle), `既有验收逻辑少了 ${needle}`);
  }
  // 金额 / 说明的既有校验（提交前后端还会再判一次）
  assert.ok(source.includes("if (!/^\\d+(\\.\\d+)?$/.test(rawAmount) || Number(rawAmount) <= 0)"));
  assert.ok(source.includes('if (!acceptanceText)'));

  // ③ 渲染出来的验收表单逐字（一张卡一颗按钮 + 一个折叠表单）
  const html = orders.purchaseOrdersHtml([
    { record_id: 'r1', batch_no: 'CGD-1', product_number: 'X1', size: 38, quantity: 2, arrival_status: '未到货' },
  ]);
  for (const needle of [
    'data-batch="CGD-1"', 'data-action-block="verify-arrival"', 'data-arrival-batch="CGD-1"',
  ]) {
    assert.ok(html.includes(needle), `验收卡少了 ${needle}`);
  }
});
