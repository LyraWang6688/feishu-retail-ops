/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：「**配品就是走表单了～工作台自建写服务"可以删除了，
 *   也就说在工作台点击配品就是直接跳转表单链接**」
 *
 * ⚠️⚠️ 本文件是**重写**（不是新增）：它 2026-10-15 之前钉的是"工作台自建配品面板 + 自建写服务"
 *   （`public/workbench/features/accessory/**` + `config/workbenchAccessory.js` +
 *    `GET /sales/payment-methods` / `GET /sales/accessories` / `POST /sales/accessory-sales`）。
 *   那一套**已整段删除** ⇒ 本文件改成钉**新入口**与**"判据没有跟着消失"**这两件事。
 *
 * ── 判据迁移清单（原 `AC-AC*` / `AC-A*` → 现在由谁承载）────────────────────────
 * | 原判据（钉在**已删**的自建链路上）                                        | 现在由谁承载 |
 * | ------------------------------------------------------------------------ | ------------ |
 * | AC-AC3 一步成单：`addSaleLine(kind:accessory)` + `submitSale`、收款明细 1 行 | `test/accessorySaleIntake.test.js` **AC-AS1** |
 * | AC-AC3 的 `inStock` / `paymentStatus=全付` / `paidAmount`                  | 同文件 **AC-MIG1** ⭐ 迁移 |
 * | AC-AC4 零库存动作（这一趟只调那两个既有写方法）                             | 同文件 **AC-MIG2** ⭐ 迁移 |
 * | AC-A2 配品不扣库存（`tracksInventory:false` + 引擎那道闸门逐字）            | 同文件 **AC-MIG3** ⭐ 迁移 |
 * | AC-A4b「没传收款方式 ⇒ 沿用配置默认」                                      | ⚠️ **口径已更新**：新链路「关联为空 ⇒ 拒单」⇒ 同文件 **AC-MIG4**（**有意的行为变化**，PR 单列） |
 * | AC-AC6 金额必填（空 / 0 / 负数 ⇒ 不成单 + 零写入）                          | 同文件 **AC-AS4** |
 * | AC-AC5 幂等（同一把键只成一次单）                                          | 同文件 **AC-AS2**（键 = **记录 ID**） |
 * | AC-AC3 的「写入口必须作废工作台订单缓存」（`ordersCache.invalidate()`）      | 同文件 **AC-MIG5** ⭐ 迁移（**成单真的落下之后**作废**进程级共享**那一份）；`workbenchOrdersPerformance.test.js` **AC7 ③b** 逐条钉住位置 ✓ |
 * | AC-AC1 子 tab「配品」在、位置在订单列表 / 销售查询 / 客户往来款之后           | 本文件 **AC-AC1**（判据照旧 ✓） |
 * | AC-AC10 字段各占一行 / AC-AC7 数量默认 1 / AC-AC8 UI 硬规矩                 | ❌ 随面板一起删（依据：面板已不存在 ✓） |
 * | AC-AC2 清单接口 200+空数组 / AC-A3 收款方式选项来自表 / AC-A5 读不到表 ⇒ 503 | ❌ 随那三条接口一起删（依据：接口已不存在 ✓） |
 * | AC-AC1b `kind:'accessory'` 分派                                            | 翻转成本文件 **AC-D1b**（"那条分派不再存在"✓） |
 *
 * ── 验收标准（先写后做；每条能真红）─────────────────────────────────────────
 *   AC-D1 ⭐⭐ 「配品」那一格 ⇒ **点一下就是打开表单**（链接**只来自** `config/links.js`；
 *           能真红：把 kind 改回自建 / 把 href 改空 / 把 URL 抄进 domains.js ⇒ 红）
 *   AC-D2 🔴 全仓 **0 处活引用**（`features/accessory` / `workbenchAccessory` /
 *           `/sales/accessory-sales` / `/sales/accessories` / `/sales/payment-methods`）——
 *           注释 / 文档留痕允许 ✓
 *   AC-D3 ⭐ **判据迁移收口**：新链路上的 `AC-MIG1..AC-MIG4` **必须还在**（不许跟着死文件消失 ✗）
 *   AC-D4 🔴 `require('./src/routes/workbench')` ＋ `require('./src/app')` **能加载**（无悬空引用）
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// 路由模块的 require 链会在模块级求值凭证 / 表 ID（为了让模块能加载；本文件一次飞书都不打）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accessory_form_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accessory_form_test_secret';

const SERVER_ROOT = path.join(__dirname, '..');
const WORKBENCH = path.join(SERVER_ROOT, 'public/workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 去注释（JS / CSS）——「注释里留沿革」不算活引用。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

/**
 * 把要跑的前端模块复制成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）——
 * 与 `workbenchFourTabs.test.js` / `workbenchNoManualText.test.js` 同一套做法。
 */
async function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accessory-form-entry-'));
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
  copy('core/formatters.js', 'formatters.mjs');
  copy('features/query/index.js', 'query-index.mjs', [
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
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    domains: await load('domains'),
    nav: await load('domains-nav'),
    links: await load('links'),
  };
}

const salesAccessoryPage = (domains) => domains.domainById('sales').pages.find((page) => page.id === 'sales-accessory');

// ═══════════════════════════════════════════════════════════════════════════
// AC-AC1 子 tab「配品」仍在（位置不变）—— 判据照旧
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AC1 ⭐ 工作台「销售」下仍有子 tab「配品」（位置 = 订单列表 / 销售查询 / 客户往来款 **之后**）', async () => {
  const { domains } = await loadFrontendModules();
  const sales = domains.domainById('sales');
  const ids = sales.pages.map((page) => page.id);
  assert.deepEqual(ids, ['sales-orders', 'sales-query', 'sales-customer-money', 'sales-accessory'],
    '配品仍是销售下的最后一格（顺序与 id 逐字未变 ✓）');
  assert.equal(salesAccessoryPage(domains).label, '配品', 'label 逐字「配品」✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D1 点「配品」⇒ 直接打开表单（链接只来自 config/links.js）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-D1 ⭐⭐ 点「配品」⇒ **直接打开她那张飞书表单**（`kind:"links"` + `directJump`，URL 只在 config/links.js）', async () => {
  const { domains, nav, links } = await loadFrontendModules();
  const page = salesAccessoryPage(domains);
  assert.ok(page, '「配品」子页必须在');

  // ① 改前逐字：`{ id: 'sales-accessory', label: '配品', kind: 'accessory' }`（挂工作台自建的配品面板）
  //    改后逐字：`kind: 'links'` + `directJump: true` + 恰好一张卡（与「货品上新」「供应商名录」**同一套** ✓）
  //    依据：她 2026-10-15「**在工作台点击配品就是直接跳转表单链接**」✓
  assert.equal(page.kind, 'links', '改成"外链卡"那种页（不再是自建面板 accessory）');
  assert.equal(page.directJump, true, '点一次就跳（既有直跳机制 ✓ 不新造 ✗）');
  assert.equal((page.cards || []).length, 1, '恰好一张卡（直跳机制要求恰好一张 ✓）');

  // ② **链接只来自 `config/links.js`**（配置/模板里不复制字面量 ✗）
  assert.equal(page.cards[0].href, links.ACCESSORY_SALE_FORM_URL, 'href = config/links.js 里那个常量 ✓');
  assert.equal(links.ACCESSORY_SALE_FORM_URL,
    'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnCUHxarWSWhoQRiv6qJeKWh', 'URL 逐字是她给的那条 ✓');
  assert.equal(readWorkbench('config/domains.js').includes('scnzoiwpgxik'), false,
    'domains.js 里不许复制 URL 字面量（单一来源 = config/links.js ✗）');

  // ③ 文案走配置（标题 / 动作都在 domains.js 这一份配置里，非空）
  assert.ok(String(page.cards[0].title || '').length > 0, '卡片标题来自配置 ✓');
  // 🔴 **成对迁移（2026-10-16 当天下午 · 最后三处）**：
  //   改前逐字：`assert.ok(String(page.cards[0].arrow || '').length > 0, '动作文案来自配置 ✓');`
  //   改后逐字：`assert.equal(page.cards[0].arrow, undefined, …)` —— 那行 `arrow: '去填配品销售表单 →'` 删了
  //   依据 = 她 **2026-10-16** 逐字「**我也没看到，可以删除**」＋ 只读核实：卡片本体是
  //     `<a class="entry-card" href=…>`（**整张卡就是链接**）⇒ 箭头行没有跳转职责 ⇒ 多余 ⇒ 删
  //     （判据见 `test/workbenchArrowTrimAll20261016.test.js`）。
  //   ⚠️ **不是放宽**：**跳转能力**由下面 ④ 那几条（`resolveTabClick` / AppLink / 表单 URL）**完全钉住**，
  //      本次一个字没动 ✗ —— 只是"卡面上那行提示语"退场。
  assert.equal(page.cards[0].arrow, undefined,
    '⭐ 改后逐字：那行箭头（`去填配品销售表单 →`）已删（配置里不再有 `arrow` 键）');

  // ④ **点一下真的会跳**：`resolveTabClick` 给出 jump（不是"切到本页再看卡片"）
  const action = nav.resolveTabClick(page);
  assert.ok(String(action.jump || '').length > 0, '点一下子 tab ⇒ 直接跳（jump 非空 ✓）');
  // 默认走**飞书端内 AppLink**（与「货品上新」同一条路 ✓）
  assert.ok(nav.directJumpUrlForPage(page).includes('applink.feishu.cn'), '默认端内打开（AppLink ✓）');
  assert.equal(nav.directJumpUrlForPage(page, { applinkEnabled: false }), links.ACCESSORY_SALE_FORM_URL,
    '关掉 AppLink ⇒ 就是她那条表单 URL（判据没放宽 ✓）');
  // 直跳页**不渲染中间内容**（点一次就走）
  assert.equal(nav.domainPageHtml(page), '', '直跳页不渲染中间卡片 ✓');
});

test('AC-D1b 🔴 反向哨兵：`kind:"accessory"` 那条**分派与模块**都不在了（改回去 ⇒ 红）', () => {
  const skeleton = stripComments(readWorkbench('features/domains/index.js'));
  assert.equal(skeleton.includes('accessory'), false,
    '领域骨架里不许再有 accessory 的分派 / import（那条路已删 ✗）');
  assert.equal(fs.existsSync(path.join(WORKBENCH, 'features/accessory')), false, '配品面板目录必须不存在');
  assert.equal(fs.existsSync(path.join(WORKBENCH, 'config/accessory.js')), false, '配品前端配置必须不存在');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2 全仓 0 处活引用（注释 / 文档留痕允许）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-D2 🔴 全仓 0 处**活引用**：features/accessory · workbenchAccessory · 那三条自建接口', () => {
  const NEEDLES = [
    ['features', 'accessory'].join('/'),         // 前端面板目录
    ['workbench', 'Accessory'].join(''),         // 服务端那份配置
    ['/sales/accessory', '-sales'].join(''),     // 自建成单接口
    ['/sales/', 'accessories'].join(''),         // 自建清单接口
    ['/sales/payment', '-methods'].join(''),     // 只服务那个面板的收款方式接口
    ['ACCESSORY_', 'API'].join(''),
    ['ACCESSORY_', 'TEXTS'].join(''),
  ];
  // ⚠️ 排除本哨兵自己（上面这些 needle 是拼出来的，但错误信息里会出现 ⇒ 排除更稳 ✓）
  const SELF = path.join(__dirname, 'workbenchAccessoryTab.test.js');
  const offenders = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (full === SELF) continue;
      if (!/\.(js|css|html)$/.test(entry.name)) continue;
      const raw = fs.readFileSync(full, 'utf8');
      const code = /\.(js|css)$/.test(entry.name) ? stripComments(raw) : raw;
      for (const needle of NEEDLES) {
        if (code.includes(needle)) offenders.push(`${path.relative(SERVER_ROOT, full)} ← ${needle}`);
      }
    }
  };
  for (const root of [path.join(SERVER_ROOT, 'src'), WORKBENCH, path.join(SERVER_ROOT, 'test')]) walk(root);
  assert.deepEqual(offenders, [], `还有活引用：\n  ${offenders.join('\n  ')}`);

  // 那三个已被删掉的文件 / 目录，一个都不是"还在"
  for (const gone of [
    'public/workbench/features/accessory',
    'public/workbench/config/accessory.js',
    'src/config/workbenchAccessory.js',
  ]) {
    assert.equal(fs.existsSync(path.join(SERVER_ROOT, gone)), false, `${gone} 必须已删`);
  }
  // 路由源码里也不许再出现那三条（源码哨兵）
  const routes = fs.readFileSync(path.join(SERVER_ROOT, 'src/routes/workbench.js'), 'utf8');
  assert.equal(/router\.(get|post)\(\s*accessoryTab/.test(routes), false, '那三条自建路由必须整段删掉');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3 判据迁移收口（新链路上必须还钉着）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-D3 ⭐⭐ 配品表单工作流接管后：intake 代码已删除（不留半条死链）', () => {
  // ⭐ 2026-10-18（业务负责人：「配品表单的工作流已接管，所以相关代码可以删除」）：
  //   旧链路（表单变更事件 → accessorySaleIntakeService 写销售）整段退场。
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'src/services/accessorySaleIntakeService.js')), false,
    'accessorySaleIntakeService.js 必须已删');
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'src/config/accessorySaleIntake.js')), false,
    'config/accessorySaleIntake.js 必须已删');
  const events = fs.readFileSync(path.join(SERVER_ROOT, 'src/routes/larkEvents.js'), 'utf8');
  assert.equal(/require\('\.\.\/services\/accessorySaleIntakeService'\)|resolveAccessorySaleIntake\(/.test(events), false,
    '事件路由里不许再挂配品 intake 支路（注释可留历史，调用不行）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D4 require 能加载（无悬空引用）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-D4 ⭐⭐ `require("./src/routes/workbench")` 与 `require("./src/app")` 都能加载（无悬空引用）', () => {
  // ① 路由模块：本进程直接 require（已设 fixture 凭证）
  assert.doesNotThrow(() => require('../src/routes/workbench'), '工作台路由必须能加载');
  // ② app.js：**子进程**里 require —— 它 require 期会起后台快照刷新（不污染本进程），
  //    `process.exit(0)` ⇒ 判据就是"require 有没有抛 / 有没有找不到模块"✓
  const probe = spawnSync(process.execPath, ['-e', "require('./src/app'); process.exit(0);"], {
    cwd: SERVER_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      LARK_AGENT_APP_ID: process.env.LARK_AGENT_APP_ID,
      LARK_AGENT_APP_SECRET: process.env.LARK_AGENT_APP_SECRET,
    },
  });
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  assert.equal(/MODULE_NOT_FOUND|Cannot find module/.test(output), false,
    `app.js 不许有悬空引用：\n${output.slice(-800)}`);
  assert.equal(probe.status, 0, `app.js 必须能加载（exit=${probe.status}）：\n${output.slice(-800)}`);
});
