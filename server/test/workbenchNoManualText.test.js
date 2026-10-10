/**
 * ⭐⭐ 工作台「**界面不留说明书**」的验收标准（业务负责人 **2026-10-10** 真机反馈）。
 *
 * 她的原话（逐字）：
 *   「我就以采购这个页为例吧，**这些东西你都不需要**。我不知道这是注释文字吗？**都需要删掉**。
 *    比如说采购这个 tab 页下面，我已经点到了采购，**直接出来报货、退货、到货就行**，
 *    **下面的这些文字解释就不用了**，你理解吗？」
 *
 * 口径：**界面只留"能点、能做的事"** —— 一级 tab 名 · 子 tab 名 · 卡片标题 + 动作 ·
 *       功能按钮 · 验收台本身 · 状态小标签。
 *       凡是"这个页面是干什么的 / 我怎么用"的说明句（一级领域大标题、标题下的描述行、
 *       页面内重复的标题、卡片副标题、占位页长说明句、使用步骤、表单外的提示句）**一律不渲染**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC1 领域 tab 页内**没有**一级领域大标题与它下面那行描述（tab 上已经写了领域名）。
 *  AC2 子 tab 名**不许**带括号备注（「采购订单列表（待建设）」✗ —— 「待建设」只做卡片小标记）。
 *  AC3 卡片只留**标题 + 动作**：卡片的说明句（desc）一个字都不渲染。
 *  AC4 页面内**不许**重复子 tab 的名字（例：进了「报货 / 验收 / 退货」又看到一行同名标题）；
 *      使用步骤（steps）/ 提示句（hint）/ 占位说明（note）也一并删掉。
 *  AC5 验收台那句说明（「按采购订单（= 报货批次那些单）：一张报货批次一张卡…」）**必须不存在** ——
 *      但**验收台本身**（批次卡 + 明细行 + 未到货时的【验收到货】按钮 + 锚点能跳到）一个都不能少。
 *  AC6 占位页只留「**待建设**」小标记：标题与「将来放…」长说明句都不渲染。
 *  AC7 这些说明句在整个渲染面 / 配置里**必须不存在**（逐条清单，去注释后再判）。
 *  AC8 功能性内容**一个都不能少**（这不是放宽）：子 tab 名 / 卡片标题与动作 / 功能按钮 /
 *      外链 href / 状态小标签 / 空状态人话 —— 全部逐字还在。
 *  AC9 订单列表：页内不再有重复大标题与使用说明句（配置与渲染层都不再有）。
 *  AC10 「库存 → 手工调整」页内不再有重复大标题与使用说明句。
 *  AC11 工作台首页页脚只留功能性的「扫码入口」指向，不再解释首页怎么用。
 *
 * ⚠️ 本文件钉住的是**"说明文字不许存在"**：她点名要删的那些句子，断言从"存在"翻成"必须不存在"；
 *    **功能**（按钮 / 表单 / 批次卡 / 标签 / 空状态）另有一组"必须还在"的断言，**不放宽**。
 * ⚠️ 做法与 `workbenchFourTabs.test.js` 同一套：把前端那几个 ES 模块复制成 `.mjs`
 *    （**只改 import 的文件名，逻辑一个字不改**）真的当模块跑起来，断言**真正渲染出来的 HTML**。
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

/**
 * 把要跑的前端模块复制成 `.mjs` 平铺到一个临时目录，**只把 import 的文件名改成复制后的名字**
 * （源码逻辑一个字不改）—— 与 `workbenchFourTabs.test.js` 同一套做法。
 * 每一条替换都必须命中（命不中说明源码的 import 变了，测试要跟着更新）。
 */
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-no-manual-'));
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
    query: load('query'),
    domains: load('domains'),
    ordersConfig: load('orders-config'),
    queryIndex: load('query-index'),
    domainPages: load('domains-pages'),
    domainNav: load('domains-nav'),
    placeholder: load('placeholder'),
    orders: load('orders-index'),
  };
}

/** 三个「静态」子页（`orders` / `inventory-adjustment` 是既有模块，不在纯渲染函数里）。 */
const STATIC_KINDS = ['entry', 'links', 'query', 'placeholder'];
const staticPagesOf = (domains) => domains.DOMAIN_TABS
  .flatMap((domain) => domain.pages)
  .filter((page) => STATIC_KINDS.includes(page.kind));

/** 子 tab 按钮上的短名（顺序 = DOM 顺序）。 */
const subTabLabels = (html) => [...html.matchAll(
  /data-domain-page="[^"]*"[^>]*>([^<]*)<\/button>/g,
)].map((match) => match[1]);

/**
 * 她截图点名「不需要」的那些说明句（逐字）。
 * ⚠️ 只列**说明文字** —— 子 tab 名（例「报货 / 验收 / 退货」）、卡片标题、按钮、状态标签不在其中。
 */
const REMOVED_SENTENCES = [
  '扫码建单 → 订单列表',
  '报货 / 验收 / 退货 · 采购订单列表',
  '供应商报货（飞书表单）',
  '把货退给供应商',
  '就在这一页下面',
  '按采购订单（= 报货批次那些单）',
  '一张报货批次一张卡，每张卡都能',
  '扫鞋盒标签上的二维码就是这一件事',
  '看某一个编号现在有几双',
  '最省事的用法还是',
  '新增货品基础信息（走既有飞书表单',
  '单个 = 输入编号只打这一款',
  '在飞书多维表格里看——点一下直接打开',
  '实时库存在飞书多维表格里看（全仓）',
  '盘点调整改数量',
  '选货号 + 尺码 → 看当前库存',
  '换季调整只改「所属状态」',
  '记一笔收款（收款方式默认微信，可以改）',
  '把货出库（勾上这次交付的明细）',
  '走既有售后处理层，原单不会被改',
  '把还没收的尾款记成已收',
  '将来放客户的应收',
  '将来放采购订单的 AI 页面',
  '将来放供应商的应付',
  '相关入口',
  '货已交付、钱已收清',
  '信息还没填全（尺码 / 金额 / 状态缺）',
];

// ═══════════════════════════════════════════════════════════════════════════
// AC1 领域页内没有一级大标题与描述行
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 领域 tab 页内没有一级大标题与它下面那行描述（tab 上已经写了领域名）', async () => {
  const modules = loadFrontendModules();
  const domains = await modules.domains;

  // ① 配置里不再有领域大标题 / 描述行 —— 那两行就是她截图点名的「采购」大字 + 下面那行解释。
  for (const domain of domains.DOMAIN_TABS) {
    assert.equal(domain.title, undefined, `领域 ${domain.id} 不许再有与一级 tab 重复的大标题`);
    assert.equal(domain.subtitle, undefined, `领域 ${domain.id} 不许再有描述行`);
  }
  // 那两行解释句的原文（逐字）也不许再留在配置里
  for (const gone of [
    '报货 / 验收 / 退货 · 采购订单列表（待建设）· 供应商往来款（待建设）',
    '扫码建单 → 订单列表（补收款 / 交付 / 售后）→ 销售查询',
    '单款查询 · 全仓查询 · 手工调整',
    '货品上新 · 标签打印（单个 / 批量）',
  ]) {
    assert.ok(!readWorkbench('config/domains.js').includes(gone), `领域描述行必须删掉：${gone}`);
  }

  // ② 领域骨架一个字都不画它们（去注释后再判，免得把历史说明当实现）。
  const index = stripComments(readWorkbench('features/domains/index.js'));
  assert.ok(!/<h2>/.test(index), '领域骨架不许再画一级领域大标题');
  assert.ok(!/domain\.title|domain\.subtitle/.test(index), '领域骨架不许再引用大标题 / 描述行');
  // 能做的事一个不少：子 tab 与切换照旧
  assert.ok(index.includes('data-domain-page'), '子 tab 照旧渲染');
  assert.ok(index.includes('createOrdersModule('), '内嵌的既有模块照旧挂');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 子 tab 名不许带括号备注
// ═══════════════════════════════════════════════════════════════════════════

test('AC2 子 tab 名不许带括号备注（「采购订单列表（待建设）」✗，「待建设」只做卡片小标记）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav] = await Promise.all([modules.domains, modules.domainNav]);

  for (const domain of domains.DOMAIN_TABS) {
    const html = nav.domainSubTabsHtml(domain);
    const labels = subTabLabels(html);
    assert.deepEqual(labels, domain.pages.map((page) => page.label), '子 tab 名的唯一来源仍是配置');
    for (const label of labels) {
      assert.ok(!/[（(]/.test(label), `子 tab 名不许带括号备注：${label}`);
    }
  }

  // 她截图里那两个（逐字）
  const purchaseTabs = nav.domainSubTabsHtml(domains.domainById('purchase'));
  assert.ok(purchaseTabs.includes('>采购订单列表</button>'), '子 tab 名就是「采购订单列表」（不带备注）');
  assert.ok(purchaseTabs.includes('>供应商往来款</button>'), '子 tab 名就是「供应商往来款」（不带备注）');
  assert.ok(!purchaseTabs.includes('待建设'), '「待建设」不做子 tab 备注 —— 它是占位卡上的小标记');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 卡片只留标题 + 动作
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 卡片只留标题 + 动作：卡片的说明句（desc）一个字都不渲染', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, pages] = await Promise.all([
    modules.domains, modules.domainNav, modules.domainPages,
  ]);

  // ① 配置里再没有卡片说明句（`desc` 字段整体退场）
  for (const domain of domains.DOMAIN_TABS) {
    for (const page of domain.pages) {
      for (const card of (page.cards || [])) {
        assert.equal(card.desc, undefined, `卡片「${card.title}」不许再有说明句`);
      }
      for (const link of (page.links || [])) {
        assert.equal(link.desc, undefined, `入口卡「${link.title}」不许再有说明句`);
      }
    }
  }

  // ② 渲染出来的静态子页里**一个 `<p>` 都没有**（说明句的载体就是它）
  for (const page of staticPagesOf(domains)) {
    const html = nav.domainPageHtml(page);
    assert.ok(!/<p[ >]/.test(html), `${page.label} 不许再有说明句（<p>）`);
    assert.ok(!/class="page-hint"|class="subtitle"|class="placeholder-note"/.test(html),
      `${page.label} 不许再有提示句的样式类`);
  }

  // ③ 她截图点名的那三句（采购页三张卡的副标题）逐字不许在
  const purchase = domains.domainById('purchase');
  const purchaseHtml = pages.linksPageHtml(purchase.pages[0]);
  for (const gone of ['供应商报货（飞书表单）', '把货退给供应商', '就在这一页下面']) {
    assert.ok(!purchaseHtml.includes(gone), `采购卡片的说明句必须删掉：${gone}`);
  }
  // 卡片标题与动作照旧（她点名要留的）。
  // ⚠️ 2026-10-10：报货 / 退货 / 验收到货 拆成**三个子页** ⇒ 三张卡不再挤在同一页里，
  //    但一张都没少（验收那张卡整体退场 —— 它已经是独立子页，见下面的断言）。
  assert.ok(purchaseHtml.includes('<h3>报货</h3>'), '报货卡还在');
  assert.ok(purchaseHtml.includes('class="arrow"'), '卡片右下角的动作照旧');
  const backHtml = pages.linksPageHtml(purchase.pages.find((page) => page.id === 'purchase-return'));
  assert.ok(backHtml.includes('<h3>退货</h3>'), '退货卡还在（它自己的子页）');
  assert.ok(!purchaseHtml.includes('<h3>验收到货</h3>'),
    '报货页上不许再有验收卡（验收 = 独立子页）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 页面内不许重复子 tab 的名字
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 页面内不许重复子 tab 的名字（步骤 / 提示句 / 占位说明也一并删掉）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav] = await Promise.all([modules.domains, modules.domainNav]);

  for (const page of staticPagesOf(domains)) {
    const html = nav.domainPageHtml(page);
    // 卡片标题本身就是 `<h3>`（要留）；重复的**页标题**用的是 `class="section-title"` ⇒ 只禁后者。
    assert.ok(!/class="section-title"/.test(html),
      `${page.label} 不许再画一遍同名标题（子 tab 上已经有了）`);
  }

  // 那些"这个页面怎么用"的字段整体退场（配置先行：字段都不该再有）
  for (const domain of domains.DOMAIN_TABS) {
    for (const page of domain.pages) {
      for (const field of ['subtitle', 'hint', 'steps', 'note']) {
        assert.equal(page[field], undefined,
          `${domain.id} / ${page.label} 的 ${field} 是说明文字 ⇒ 必须删掉`);
      }
    }
  }

  // 渲染层也不许再读它们（免得将来又长回来）
  const render = stripComments(readWorkbench('features/domains/pages.js'));
  for (const needle of ['page.subtitle', 'page.hint', 'page.steps', 'stepsHtml', 'page.note', 'card.desc', 'embed.subtitle']) {
    assert.ok(!render.includes(needle), `领域页渲染层不许再引用 ${needle}`);
  }
  const navSource = stripComments(readWorkbench('features/domains/nav.js'));
  assert.ok(!/class="section-title"/.test(navSource), '外链子页也不许再画一遍同名标题');
  assert.ok(!/在飞书多维表格里看/.test(navSource), '外链子页那句「在飞书多维表格里看——点一下直接打开」必须删掉');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 验收台那句说明必须不存在 —— 但验收台本身一个都不能少
// ═══════════════════════════════════════════════════════════════════════════

test('AC5 验收台那句说明必须不存在；验收台本身（批次卡 + 验收入口）一个都不能少', async () => {
  const modules = loadFrontendModules();
  const [domains, pages, ordersConfig, orders] = await Promise.all([
    modules.domains, modules.domainPages, modules.ordersConfig, modules.orders,
  ]);
  const purchase = domains.domainById('purchase');
  const report = purchase.pages.find((page) => page.id === 'purchase-report');
  const arrival = purchase.pages.find((page) => page.id === 'purchase-arrival');

  // ① 配置：那句说明与**内嵌宿主**整体退场；验收改成**独立子页**
  //    （⚠️ 2026-10-10 断言翻转（业务负责人真机反馈）：「不应该是一点完之后在同一个 tab 页里
  //     下面出现」—— 原先这里钉的是"报货页里有锚点卡 + 内嵌验收块"。）
  assert.equal(report.embed, undefined, '内嵌验收块必须删掉（验收 = 独立子页）');
  assert.equal(report.cards.some((card) => card.anchor), false, '本页锚点卡必须删掉');
  assert.equal(arrival.kind, 'orders', '「验收到货」= 独立子页（既有订单模块的 purchase 模式）');
  assert.equal(arrival.mode, 'purchase');
  assert.equal(ordersConfig.ORDERS_PAGE.purchaseSubtitle, undefined, '订单列表的采购描述行也必须删');
  assert.equal(ordersConfig.ORDERS_PAGE.subtitle, undefined, '订单列表的描述行也必须删');

  // ② 渲染出来一个字都不许有它（锚点 / 内嵌宿主 / 那句说明）
  const html = pages.linksPageHtml(report);
  for (const gone of ['按采购订单', '一张报货批次一张卡', '每张卡都能', '#purchase-arrival', 'data-embed-host']) {
    assert.ok(!html.includes(gone), `报货页里必须没有：${gone}`);
  }

  // ③ 验收台本身（现在挂在**独立子页**的 host 上）：一张报货批次一张卡 + 每张卡都能
  //    「验收到货」+ 实际金额必填
  const purchaseHtml = orders.purchaseOrdersHtml([
    { record_id: 'pr1', batch_no: 'CGD-1', product_number: 'XHB8095', size: 38, quantity: 2, arrival_status: '未到货' },
  ]);
  assert.ok(purchaseHtml.includes('CGD-1'), '批次号照旧是卡片的标题');
  assert.ok(purchaseHtml.includes('XHB8095') && /38\s*码/.test(purchaseHtml), '明细行照旧');
  assert.ok(purchaseHtml.includes('未到货'), '到货状态小标签照旧');
  assert.ok(purchaseHtml.includes('data-action="verify-arrival"'), '每张卡都有【验收到货】按钮');
  assert.ok(purchaseHtml.includes('data-field="arrival-amount"'), '验收要填「实际金额」（既有必填口径）');
  assert.ok(purchaseHtml.includes('data-action="submit-arrival"'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 占位页只留「待建设」小标记
// ═══════════════════════════════════════════════════════════════════════════

test('AC6 占位页只留「待建设」小标记：标题与「将来放…」长说明句都不渲染', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, placeholder] = await Promise.all([
    modules.domains, modules.domainNav, modules.placeholder,
  ]);
  const byId = new Map(domains.DOMAIN_TABS.map((domain) => [domain.id, domain]));
  const pages = [
    byId.get('sales').pages.find((page) => page.id === 'sales-customer-money'),
    byId.get('purchase').pages.find((page) => page.id === 'purchase-orders'),
    byId.get('purchase').pages.find((page) => page.id === 'purchase-supplier-money'),
  ];

  assert.equal(placeholder.PLACEHOLDER_STATUS, '待建设');
  for (const page of pages) {
    assert.equal(page.note, undefined, `${page.label} 的「将来放…」长说明句必须删掉`);
    const html = nav.domainPageHtml(page);
    assert.ok(html.includes('data-page-kind="placeholder"'), `${page.label} 仍按占位页渲染`);
    assert.ok(html.includes('class="tag'), `${page.label} 仍有彩色小标签`);
    assert.ok(html.includes(placeholder.PLACEHOLDER_STATUS), `${page.label} 的小标记就是「待建设」`);
    assert.ok(!/<h3/.test(html), `${page.label} 不许再画一遍标题（子 tab 上已经有了）`);
    assert.ok(!/<p[ >]/.test(html), `${page.label} 不许再有长说明句`);
    assert.ok(!/将来放/.test(html), `${page.label} 不许再写「将来放…」`);
  }
  // 子 tab 上仍然点得到这三个占位页（入口一个不少）
  const purchaseTabs = nav.domainSubTabsHtml(byId.get('purchase'));
  assert.ok(purchaseTabs.includes('>采购订单列表</button>') && purchaseTabs.includes('>供应商往来款</button>'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 说明句清单：整个渲染面 / 配置里必须不存在
// ═══════════════════════════════════════════════════════════════════════════

test('AC7 她点名的说明句在整个渲染面与配置里必须不存在（逐条清单）', async () => {
  const modules = loadFrontendModules();
  const [domains, nav] = await Promise.all([modules.domains, modules.domainNav]);

  // ① 所有静态子页渲染出来的 HTML
  const rendered = staticPagesOf(domains).map((page) => nav.domainPageHtml(page)).join('\n');
  // ② 四个领域 + 三个模块的配置与渲染层（去注释后再判）
  const sources = [
    'config/domains.js', 'config/query.js', 'config/orders.js',
    'features/domains/index.js', 'features/domains/pages.js', 'features/domains/nav.js',
    'features/query/index.js', 'features/orders/index.js', 'features/inventory/adjustment.js',
  ].map((file) => stripComments(readWorkbench(file))).join('\n');
  // ③ 子 tab / 一级 tab 的短名也在渲染面里（它们**要留**，所以单独拼进来一起扫）
  const tabs = domains.DOMAIN_TABS.map((domain) => nav.domainSubTabsHtml(domain)).join('\n');

  const surface = `${rendered}\n${sources}\n${tabs}`;
  for (const gone of REMOVED_SENTENCES) {
    assert.ok(!surface.includes(gone), `说明句必须删掉：「${gone}」`);
  }
  // 领域描述行里的「（待建设）」备注也不许再出现在任何地方
  assert.ok(!/（待建设）/.test(surface), '「（待建设）」这种括号备注必须删掉');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC8 功能性内容一个都不能少（不是放宽）
// ═══════════════════════════════════════════════════════════════════════════

test('AC8 功能性内容一个都不能少：子 tab / 卡片标题与动作 / 按钮 / 外链 / 小标签', async () => {
  const modules = loadFrontendModules();
  const [domains, nav, pages, links, ordersConfig, orders, placeholder] = await Promise.all([
    modules.domains, modules.domainNav, modules.domainPages, modules.links,
    modules.ordersConfig, modules.orders, modules.placeholder,
  ]);

  // ① 四个领域的子 tab 名逐字不变（她能点到的领域结构）
  const byId = new Map(domains.DOMAIN_TABS.map((domain) => [domain.id, domain]));
  assert.deepEqual(byId.get('sales').pages.map((page) => page.label),
    ['销售建单', '订单列表', '销售查询', '客户往来款']);
  assert.deepEqual(byId.get('inventory').pages.map((page) => page.label),
    ['单款查询', '全仓查询', '手工调整']);
  assert.deepEqual(byId.get('purchase').pages.map((page) => page.label),
    ['报货', '验收到货', '退货', '采购订单列表', '供应商往来款']);
  assert.deepEqual(byId.get('product').pages.map((page) => page.label),
    ['货品上新', '标签打印']);

  // ② 采购：报货 / 退货两张飞书表单外链逐字（各在自己那一页）+ 验收 = 独立子页
  const purchase = byId.get('purchase');
  const report = purchase.pages.find((page) => page.id === 'purchase-report');
  const back = purchase.pages.find((page) => page.id === 'purchase-return');
  assert.deepEqual(report.cards.map((card) => card.title), ['报货']);
  assert.deepEqual(report.cards.map((card) => card.href), [links.PURCHASE_REQUEST_FORM_URL]);
  assert.deepEqual(back.cards.map((card) => card.title), ['退货']);
  assert.deepEqual(back.cards.map((card) => card.href), [links.PURCHASE_RETURN_FORM_URL]);
  const arrivalPage = purchase.pages.find((page) => page.id === 'purchase-arrival');
  assert.equal(arrivalPage.kind, 'orders');
  assert.equal(arrivalPage.mode, 'purchase');
  const reportHtml = pages.linksPageHtml(report);
  assert.ok(reportHtml.includes(links.PURCHASE_REQUEST_FORM_URL), '报货那张飞书表单外链照旧可点');
  assert.ok(pages.linksPageHtml(back).includes(links.PURCHASE_RETURN_FORM_URL), '退货那张飞书表单外链照旧可点');
  assert.ok(reportHtml.includes('rel="noopener"'), '外链卡的 rel="noopener" 照旧');

  // ③ 入口页：编号表单 + 提交按钮 + 目标模板（"能做的事"照旧）
  const create = pages.entryPageHtml(byId.get('sales').pages[0]);
  assert.ok(create.includes('data-entry-form') && create.includes('name="number"'), '销售建单仍有编号输入');
  assert.ok(create.includes('打开销售建单页'), '销售建单的按钮照旧');
  assert.equal(byId.get('sales').pages[0].targetTemplate, '/s/{number}?from=sales');
  assert.equal(byId.get('inventory').pages[0].targetTemplate, '/s/{number}?from=inventory');
  assert.equal(byId.get('product').pages[1].targetTemplate, '/workbench/label-print.html?keyword={itemNo}');

  // ④ 外链子页：两个多维表格卡的标题与 href 照旧
  const inventoryQuery = nav.domainPageHtml(byId.get('inventory').pages.find((page) => page.kind === 'query'));
  assert.ok(inventoryQuery.includes('全仓查询'), '外链卡的标题照旧');
  assert.ok(inventoryQuery.includes(links.INVENTORY_QUERY_PAGE_URL), '外链 href 逐字来自配置');

  // ⑤ 订单列表：功能按钮 / 字段标签 / 段头小标签与条数照旧（只删说明句）
  assert.equal(ordersConfig.ORDERS_TEXTS.verifyArrival, '验收到货');
  assert.ok(ordersConfig.ORDERS_TEXTS.arrivalSubmit && ordersConfig.ORDERS_TEXTS.arrivalAmount,
    '验收的提交按钮与「实际金额」标签照旧');
  const detail = orders.orderDetailHtml({
    record_id: 'o1', order_no: 'XSD-20261010-0001',
    fulfillment_status: '部分交付', payment_status: '部分收款',
    details: [{ record_id: 'd1', product: 'XHB8095', size: 38, actual_amount: 89, fulfillment_status: '未交付' }],
    payments: [],
  }, { methods: ['微信', '现金'] });
  for (const action of ['submit-payment', 'deliver', 'submit-second-delivery', 'submit-after-sales']) {
    assert.ok(detail.includes(`data-action="${action}"`), `订单动作少了 ${action}`);
  }
  for (const label of ['补收款', '交付', '二次交付', '售后']) {
    assert.ok(detail.includes(label), `动作标题少了 ${label}`);
  }
  const sections = orders.ordersSectionsHtml([{
    record_id: 'o1', order_no: 'XSD-1', fulfillment_status: '已交付', payment_status: '已收款',
    details: [{ record_id: 'd1', product: 'X', size: 38, actual_amount: 1, fulfillment_status: '已交付' }],
  }]);
  assert.ok(sections.includes('售后列表') && sections.includes('已两清') && sections.includes('1 单'),
    '段头仍是「名字 + 小标签 + N 单」（一个都没少）');
  assert.ok(orders.purchaseOrdersHtml([]).includes('purchase-empty'), '空状态人话照旧');

  // ⑥ 占位页的小标记仍是统一那一句
  assert.equal(placeholder.PLACEHOLDER_STATUS, '待建设');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC9 订单列表：页内不再有重复大标题与使用说明句
// ═══════════════════════════════════════════════════════════════════════════

test('AC9 订单列表：页内不再有重复大标题与使用说明句（配置与渲染层都不再有）', async () => {
  const modules = loadFrontendModules();
  const [frontConfig, orders] = await Promise.all([modules.ordersConfig, modules.orders]);

  // ① 与子 tab 重复的大标题 / 描述行退场
  assert.equal(frontConfig.ORDERS_PAGE.title, undefined, '「订单列表」大标题与子 tab 重复 ⇒ 删掉');
  assert.equal(frontConfig.ORDERS_PAGE.subtitle, undefined);
  assert.equal(frontConfig.ORDERS_PAGE.purchaseSubtitle, undefined);

  // ② 藏在动作表单里的"这个动作是什么"说明句也退场
  for (const key of ['collectHint', 'deliveryHint', 'afterSalesHint', 'secondDeliveryHint', 'arrivalVerifyHint']) {
    assert.equal(frontConfig.ORDERS_TEXTS[key], undefined, `ORDERS_TEXTS.${key} 是使用说明句 ⇒ 删掉`);
  }
  // 段头 / 分组头的解释句退场（名字 + 小标签 + N 单要留）
  for (const section of frontConfig.SALES_SECTIONS) {
    assert.equal(section.hint, undefined, `${section.label} 的说明句必须删掉`);
  }
  for (const group of frontConfig.SALES_GROUPS) {
    assert.equal(group.hint, undefined, `${group.label} 的说明句必须删掉`);
  }

  // ③ 渲染层（去注释）不许再画大标题 / 说明句
  const source = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(!/panel-header|<h2>|P\.subtitle|class="subtitle"/.test(source), '订单列表不许再画重复大标题 / 描述行');
  assert.ok(!/T\.(collectHint|deliveryHint|afterSalesHint|secondDeliveryHint|arrivalVerifyHint)/.test(source),
    '说明句一个字都不许再拼进页面');
  assert.ok(!/group\.hint|section\.hint/.test(source), '分组 / 段头的说明句不许再渲染');

  // ④ 空状态 / 按钮 / 状态标签照旧（不是放宽）
  assert.ok(frontConfig.ORDERS_PAGE.empty && frontConfig.ORDERS_PAGE.purchaseEmpty, '空状态人话照旧');
  assert.ok(frontConfig.ORDERS_PAGE.open && frontConfig.ORDERS_PAGE.back, '「查看 / 操作」与「返回」照旧');
  const html = orders.ordersSectionsHtml([{
    record_id: 'o1', order_no: 'XSD-1', fulfillment_status: '部分交付', payment_status: '部分收款',
    details: [{ record_id: 'd1', product: 'X', size: 38, actual_amount: 1, fulfillment_status: '未交付' }],
  }]);
  assert.ok(html.includes('待补充') || html.includes('待交割'), '状态小标签照旧');
  assert.ok(html.includes('data-action="open-order"'), '「查看 / 操作」按钮照旧');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC10 「库存 → 手工调整」页内不再有重复大标题与使用说明句
// ═══════════════════════════════════════════════════════════════════════════

test('AC10 「库存 → 手工调整」页内不再有重复大标题与使用说明句', () => {
  const source = stripComments(readWorkbench('features/inventory/adjustment.js'));

  assert.ok(!/<h2>/.test(source), '「库存手工调整」大标题与子 tab 重复 ⇒ 删掉');
  assert.ok(!/<h3>/.test(source), '「盘点调整」这类重复小标题 ⇒ 删掉');
  for (const gone of ['盘点调整改数量', '选货号 + 尺码', '换季调整只改']) {
    assert.ok(!source.includes(gone), `说明句必须删掉：${gone}`);
  }

  // 功能照旧：两个子 tab + 两条提交按钮 + 既有接口
  for (const needle of [
    'data-subtab="adjust-count"', 'data-subtab="adjust-season"',
    'data-action="submit-count"', 'data-action="submit-season"',
    '/api/workbench/inventory/adjustments/count', '/api/workbench/inventory/adjustments/season',
  ]) {
    assert.ok(source.includes(needle), `手工调整的功能少了 ${needle}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC11 工作台首页页脚：只留功能性指向，不再解释怎么用
// ═══════════════════════════════════════════════════════════════════════════

test('AC11 工作台首页页脚只留「扫码入口」的功能性指向，不再解释首页怎么用', () => {
  // 只看**真的会渲染出来的**那一份（HTML 注释里留的是沿革说明，不是页面上的字）。
  const html = readWorkbench('index.html').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(html.includes('扫码入口'), '「扫码入口」这个功能性指向保留');
  assert.ok(html.includes('扫鞋盒标签上的二维码'), '告诉她在哪扫码这一句保留');
  assert.ok(!html.includes('页面顶部可切换'), '页脚不许再解释扫码页怎么切领域（那是说明书）');
});
