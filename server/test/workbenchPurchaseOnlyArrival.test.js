// ⭐⭐ 2026-10-14 改指向（业务负责人逐字：「**工作台的采购 tab 里的退货不需要了**」）：
//   采购子 tab 从「验收·退货·订单列表·供应商往来款」⇒「验收·订单列表·供应商往来款」✓
//   🔴 **不是放宽** ✗：判据从"必须有退货"翻成"**必须没有退货**"，其余三项逐字不变 ✓
//   ⚠️ 退货**功能没删** ✓ —— 它一直在**扫码页**的【退货】领域（`?from=purchase_return` ✓）
/**
 * ⚠️ **2026-10-12 口径又变了**（业务负责人逐字）：「**采购里面的验收到货也不需要了**，因为
 *    **验收到货我们在扫码页也做了**，所以目前我们的采购页就先保持『**订单列表**』和『**供应商往来款**』」
 *    ＋「麻烦把『**采购订单列表**』这个子 tab 页**改为『订单列表』**」
 *    ＋ 销售删「销售建单」· 库存删「单款查询」。
 *    ⇒ 本文件 AC-W1 / W2 / W6 三条**改写**（逐字对照见各条注释）；AC-W3（两个占位页）/
 *      W4（死链清掉）/ W5（不再指 `?from=purchase`）**一条都没放宽**。
 *    ⚠️ 文件名里的 "PurchaseOnlyArrival" 是**历史名**（2026-10-11 那版口径），保留不改名。
 *
 * ⭐⭐ 2026-10-11（业务负责人批准）：工作台「采购」= **只留「验收到货」**。
 *
 * 她的口径（逐字要点）：
 *   · 「报货」「退货」两个子页**隐藏**（那两个动作现在都在**扫码页**：补货 / 退货 各一个领域）；
 *   · 「采购订单列表」「供应商往来款」两个**占位页保留**（待建设）；
 *   · ⚠️ **清掉那两条死链**：隐藏的老「采购管理」页面（`features/purchase/**`）里挂的
 *     **飞书表单死链**清掉（她已批准"可以清掉"）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-W1 采购子 tab 逐字 = **验收到货 · 采购订单列表 · 供应商往来款**（报货 / 退货不再出现）；
 *         其余三个领域的子 tab 清单**一条不变**（销售 4 / 库存 3 / 货品 2）。
 *  AC-W2 「验收到货」仍是**独立子页**（`kind:'orders'` / `mode:'purchase'`），采购不再有 `kind:'entry'` 页。
 *  AC-W3 两个占位页保留（`purchase-orders` / `purchase-supplier-money`，都还是 `placeholder`）。
 *  AC-W4 **死链清掉**：`features/purchase/**` 里不再出现任何飞书表单 URL / `share/base/form`
 *         （源码哨兵）；被它引用的那两个 URL 常量仍在 `config/links.js`（不删，等业务负责人定）。
 *  AC-W5 采购子页上不再有任何指向 `/s/{number}?from=purchase`（已退役领域）的入口。
 *  AC-W6 其它领域的入口一个没丢：销售建单 / 单款查询 / 全仓查询 / 标签打印 / 库存手工调整。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 把前端 ES 模块复制成 `.mjs`（只改 import 的文件名），**真跑**配置与渲染层。 */
async function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-purchase-only-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement, optional] of replacements) {
      if (!source.includes(needle)) {
        assert.ok(optional, `${from} 里没有找到要改的 import：${needle}`);
        continue;
      }
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/links.js', 'links.mjs');
  copy('config/query.js', 'query.mjs', [["from './links.js'", "from './links.mjs'", true]]);
  copy('config/domains.js', 'domains.mjs', [
    ["from './links.js'", "from './links.mjs'"],
    ["from './query.js'", "from './query.mjs'", true],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  // ⚠️ **await 在这里**（模块是动态 import，返回 Promise）——别把 Promise 当成模块用。
  return { links: await load('links'), domains: await load('domains') };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC-W1 采购子 tab 只留「验收到货」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W1 采购子 tab 逐字 = 订单列表 · 供应商往来款（验收入口已删 + 改名 + 2026-10-14 供应商名录）', async () => {
  const { domains } = await loadFrontendModules();
  const byId = new Map(domains.DOMAIN_TABS.map((domain) => [domain.id, domain]));
  // ⚠️ 2026-10-12 改写：改前 = ['验收到货','采购订单列表','供应商往来款'] / 对应 id。
  assert.deepEqual(byId.get('purchase').pages.map((page) => page.label),
    ['验收', '订单列表', '供应商往来款', '供应商名录']);
  assert.deepEqual(byId.get('purchase').pages.map((page) => page.id),
    ['purchase-acceptance', 'purchase-orders', 'purchase-supplier-money', 'purchase-suppliers']);
  // ⚠️ 2026-10-13：**只翻"退货"这一件事** —— 她点名要它作为采购子 tab（第二个）✓
  //    改前逐字：`for (const gone of ['purchase-report', 'purchase-return', 'purchase-arrival'])` +
  //              `for (const gone of ['报货', '退货', '验收到货'])`
  // 报货 / 验收到货**仍不在**清单里（报货在扫码页；验收是「验收」这条新子 tab ✓）
  for (const gone of ['purchase-report', 'purchase-arrival']) {
    assert.equal(byId.get('purchase').pages.some((page) => page.id === gone), false, `${gone} 应已隐藏`);
  }
  for (const gone of ['报货', '验收到货']) {
    assert.equal(byId.get('purchase').pages.some((page) => page.label === gone), false, `${gone} 子 tab 应已不在`);
  }
// 2026-10-14（她逐字）：「工作台的采购 tab 里的退货不需要了」⇒ 翻成「必须没有」（不放宽）
  assert.equal(byId.get('purchase').pages.some((page) => page.id === 'purchase-return'), false,
    '⭐「退货」子 tab 已按她 2026-10-14 的话退场（采购里不再重复开这个入口）');
  // 其余三个领域：销售 / 库存各少一个入口（2026-10-12），货品不变
  assert.deepEqual(byId.get('sales').pages.map((page) => page.label),
    ['订单列表', '销售查询', '客户往来款', '配品']);
  assert.deepEqual(byId.get('inventory').pages.map((page) => page.label),
    ['全仓查询', '手工调整']);
  assert.deepEqual(byId.get('product').pages.map((page) => page.label),
    ['货品上新', '标签打印']);
});

test('AC-W2 「验收到货」入口已删（链路保留）；采购不再有入口页 / 订单模块页', async () => {
  const { domains } = await loadFrontendModules();
  const purchase = domains.domainById('purchase');
  // ⚠️ 2026-10-12 改写：改前 = `arrival.kind === 'orders'` / `arrival.mode === 'purchase'`。
  const arrival = purchase.pages.find((page) => page.id === 'purchase-arrival');
  assert.equal(arrival, undefined, '「验收到货」入口已删（扫码页已做验收）');
  // ⭐ 2026-10-13 翻回来（她要求「验收」挂回第一个子 tab）：
  assert.equal(purchase.pages[0].id, 'purchase-acceptance', '验收 = 第一个子 tab');
  assert.equal(purchase.pages[0].label, '验收', '名字逐字两个字');
  assert.equal(purchase.pages.some((page) => page.kind === 'orders' && page.mode === 'purchase'), true,
    '⭐ 又挂上了**既有** orders/purchase 模块（不新造页面 ✓）');
  assert.equal(purchase.pages.some((page) => page.kind === 'entry'), false, '采购没有"填编号"的入口页');
  // 链路保留：既有验收台代码 / 接口地址配置 / 接口本身都还在（扫码验收、群话题核对共用）
  assert.ok(readWorkbench('features/orders/index.js').includes('verify-arrival'), '验收台代码保留');
  assert.ok(readWorkbench('config/orders.js').includes('/api/workbench/purchase/arrivals/confirm'),
    '验收接口地址配置保留');
});

test('AC-W3 ⭐ 两个占位页保留（待建设）；「验收」那条**不是**占位（2026-10-13 已接上既有模块）', async () => {
  const { domains } = await loadFrontendModules();
  const purchase = domains.domainById('purchase');
  for (const id of ['purchase-orders', 'purchase-supplier-money']) {
    const page = purchase.pages.find((item) => item.id === id);
    assert.equal(page?.kind, 'placeholder', `${id} 仍是占位页`);
    assert.ok(page.label, `${id} 仍有子 tab 名`);
  }
  const acceptance = purchase.pages.find((item) => item.id === 'purchase-acceptance');
  assert.equal(acceptance?.kind, 'orders', '验收走既有订单模块');
  assert.equal(acceptance?.mode, 'purchase', '采购模式');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W4 死链清掉（隐藏的老「采购管理」页面）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W4 ⭐ 死链清掉：老「采购管理」页 `features/purchase/**` **整个目录已不存在**；链接常量仍在 config/links.js', async () => {
  // ⚠️⚠️ 2026-10-15 **判据提升**（业务负责人逐字：「**采购页的老文件是死代码，给删除了吧**」）——
  //   改前逐字：
  //     `const dir = path.join(WORKBENCH, 'features/purchase');`
  //     `const files = fs.readdirSync(dir).filter(...)` ＋逐个文件断言"不许有 feishu.cn / share/base/form /
  //     PURCHASE_*_FORM_URL" ＋ `assert.equal(fs.existsSync(path.join(dir,'links.js')), false, …)`
  //   改后逐字：下面这几条 —— 判据从"**目录里那几个文件干净**"提升成"**目录整个不存在**"
  //     （更强：目录都没了 ⇒ 不可能再挂任何死链），并保留"两个 URL 常量仍在 config/links.js"那一条 ✓。
  //   依据：她 2026-10-15 拍板删死代码 ⇒ 目录已删；那两个 URL **照旧保留**（删 or 留不由这次处置）。
  //   ⚠️ 仍然**能真红**：把 `index.html` 那行 `<link>` 加回去 ⇒ 下面第 ② 条红；把目录恢复 ⇒ 第 ① 条红 ✓
  const dir = path.join(WORKBENCH, 'features/purchase');
  assert.equal(fs.existsSync(dir), false, '🔴 `features/purchase/**` 必须整个不存在（死代码删干净，不残留）');
  // ② 那条**活引用**（`index.html` 曾挂着的 `<link … purchase.css>`）也不许回来
  const indexHtml = readWorkbench('index.html');
  assert.equal(indexHtml.includes('features/purchase'), false,
    '`index.html` 不许再引用那个目录下的静态资源（`purchase.css` 那行已摘）');
  assert.equal(indexHtml.includes('purchase.css'), false, '那行 `<link … purchase.css>` 不许回来');
  // ③ 源码里也不许再有活引用（注释里留沿革不算；去注释后再扫）
  const offenders = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|css|html)$/.test(entry.name)) continue;
      const code = stripComments(fs.readFileSync(full, 'utf8'));
      if (code.includes('features/purchase')) offenders.push(path.relative(WORKBENCH, full));
    }
  };
  walk(WORKBENCH);
  assert.deepEqual(offenders, [], `工作台源码 / HTML 里不许再有活引用：${offenders.join(' / ')}`);
  // ④ ⚠️ `config/links.js` 的两个 URL 常量**仍在**（删 or 留由业务负责人定；这里只钉"没被顺手删掉"）
  const { links } = await loadFrontendModules();
  assert.equal(typeof links.PURCHASE_REQUEST_FORM_URL, 'string');
  assert.equal(typeof links.PURCHASE_RETURN_FORM_URL, 'string');
  assert.deepEqual(links.PURCHASE_FORMS.map((form) => form.id), ['purchase-request', 'purchase-return']);
});

test('AC-W5 采购子页上不再有指向已退役领域（?from=purchase）的入口', () => {
  // 注释里要留沿革（"原先指向哪里、为什么撤"）——**去注释后**再看代码里有没有。
  const domains = stripComments(readWorkbench('config/domains.js'));
  assert.equal(/from=purchase(&|"|'|\))/.test(domains), false, 'domains 配置里不许再有 ?from=purchase');
  assert.equal(domains.includes('PURCHASE_REQUEST_FORM_URL'), false, 'domains 里不再引用报货表单 URL');
  assert.equal(domains.includes('PURCHASE_RETURN_FORM_URL'), false, 'domains 里不再引用退货表单 URL');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W6 其它领域入口一个没丢
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W6 其它领域的入口一个没丢（全仓查询 / 标签打印 / 手工调整 / 订单列表）', async () => {
  const { domains } = await loadFrontendModules();
  const byId = new Map(domains.DOMAIN_TABS.map((domain) => [domain.id, domain]));
  // ⚠️ 2026-10-12 改写：改前还钉着 `sales-create`（`?from=sales`）与 `inventory-single`（`?from=inventory`）
  //    两个入口的 targetTemplate —— 那两个入口已按她的口径删除 ⇒ 改成"清单里没有它们"；
  //    其余功能（全仓查询 / 手工调整 / 标签打印 / 订单列表）**一条没少**。
  assert.equal(byId.get('sales').pages.some((page) => page.id === 'sales-create'), false, '销售建单入口已删');
  assert.equal(byId.get('inventory').pages.some((page) => page.id === 'inventory-single'), false, '单款查询入口已删');
  assert.equal(byId.get('inventory').pages.find((page) => page.id === 'inventory-all').kind, 'query');
  assert.equal(byId.get('inventory').pages.find((page) => page.id === 'inventory-adjust').kind, 'inventory-adjustment');
  assert.equal(byId.get('product').pages.find((page) => page.id === 'product-labels').targetTemplate,
    '/workbench/label-print.html?keyword={itemNo}');
  assert.equal(byId.get('sales').pages.find((page) => page.id === 'sales-orders').mode, 'sales');
});
