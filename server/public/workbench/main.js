import { requireFeishuAuth, showLoginButton } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { mainTabsHtml, MAIN_TABS } from './core/tabs.js';
import { SCAN_APPLINK } from './config/links.js';
import { createDomainModule } from './features/domains/index.js';
import { createPlaceholderModule } from './features/shared/placeholder.js';

// ⭐⭐ 一级 tab（业务负责人 2026-10-09 定的**最终结构**）：
//   ① 销售 · ② 库存 · ③ 采购 · ④ 货品 —— **按业务领域分**（不再按动作分）。
//   每个领域的**子页面清单**在 `config/domains.js`（销售建单 / 订单列表 / 销售查询…）。
// ⚠️ **文案 / 顺序 / data-module 的唯一来源是 `config/tabs.js` 的 `MAIN_TABS`**，
//    由 `core/tabs.js` 的 `mainTabsHtml()` 渲染进 `#main-tabs`（配置先行：加减 tab 只改配置）。
//
// ⚠️ 旧的一级 tab（信息录入 / 信息查询 / 订单列表）的口径**不是被推翻，而是被收编**：
//    · 信息查询的两个板块 → 拆进「销售 · 销售查询」「库存 · 全仓查询」（`config/query.js` 一个字没少）；
//    · 订单列表 → 拆进「销售 · 订单列表」「采购 · 采购订单列表」（同一个 `features/orders` 模块）；
//    · 信息录入（原「常用功能」）→ 它的三张卡在四个领域 tab 上都有对应入口
//      （采购 → 报货 / 退货两张表单卡 · 库存 → 手工调整 · 货品 → 标签打印）。
//      ⚠️ 2026-10-09 下半场：业务负责人点头把承载它的那四个老页面**整个删掉**
//      （`common.html` / `others.html` / `purchase.html` / `purchase-return.html`，
//      口径：「代码从仓库里删，不是隐藏」）⇒ `features/common` + `config/home.js`
//      **当前没有任何页面挂载**（`standalone.js` 的注册已摘），只是先留着没删。
// ⚠️ HIDDEN（入口隐去、**代码保留**）：finance / douyin / platform ——
//    它们仍在下面这个 modules 表里（占位模块），但**当前没有任何页面列出它们**
//    （原先列它们的「其它 / 历史功能」页已删）。要恢复某个入口：在 `config/tabs.js` 的
//    `MAIN_TABS` 里加回一条即可，逻辑不用改。
const modules = new Map([
  // ── 一级 tab 的来源（顺序 = `config/tabs.js` 的 MAIN_TABS；第一条 = 她 2026-10-13 定的「扫一扫」）──
  ['scan', createDomainModule('scan')],
  ['sales', createDomainModule('sales')],
  ['inventory', createDomainModule('inventory')],
  ['purchase', createDomainModule('purchase')],
  ['product', createDomainModule('product')],
  // ── 以下三个是隐去的入口（保留代码；在「其它 / 历史功能」里如实列出）──────
  ['finance', createPlaceholderModule({
    title: '资金管理',
    description: '统一展示实际到账、顾客待收款、平台待结算和供应商应付款。',
    planned: ['收支流水', '应收应付', '资金报表与对账'],
  })],
  ['douyin', createPlaceholderModule({
    title: '抖音运营',
    description: '管理第三方券种、核销记录、平台结算和对账差异。',
    planned: ['券种映射', '核销汇总', '平台结算对账'],
  })],
  ['platform', createPlaceholderModule({
    title: '平台管理',
    description: '维护货品、供应商、客户、门店、库存行为和支付方式等基础资料。',
    planned: ['基础资料查询', '业务配置入口', '权限与操作记录'],
  })],
]);

const mounted = new Map();
const host = document.getElementById('module-host');
// 页面加载时打开的 tab = 第一个可见 tab（配置里的第一条 = 「销售」）。
// 写死某个 module 会在 tab 顺序调整后又对不上，所以从 DOM 里取。
let initialModule = 'sales';

// 把一级 tab 渲染进 nav —— 文案 / 顺序 / data-module 全部来自 `config/tabs.js`（配置先行）。
// ⭐⭐ 2026-10-13 晚（她真机：「**就是点那个 tab 上的扫一扫**」）：
//    「扫一扫」那一格**本身**是 `<a href="<AppLink>">` ⇒ 点它 = **用户手势** ⇒ 飞书放行 ⇒ 弹摄像头 ✓
//    ⚠️ **没有**任何 JS 导航（`location.assign` 那种在她飞书里不生效 ✗ 已删）；
//    ⚠️ 也**不**在进工作台时自动弹 ✗（她踩到的正是这个 ✗）。点一次弹一次（原生链接、无状态 ✓）。
// ⭐⭐ 2026-10-13 晚（她第三次催）：**首屏就把那一格渲染成 `<a href=AppLink>`** ✓
//    ⇒ 不再依赖 `/scan-entry` 的返回时机（她那条"点了没反应/落到别的页"的两个怀疑点都消除 ✓）
//    ⚠️ PC 上飞书 AppLink 不支持 ⇒ 等接口回来说 canScan=false 时，**把那一格藏起来**（不给死格子 ✗）
let scanAppLink = SCAN_APPLINK;
let scanEntryReady = false; // 入口信息取回来过（不论能不能扫）
function renderMainTabs() {
  const nav = document.getElementById('main-tabs');
  nav.innerHTML = mainTabsHtml(MAIN_TABS, { hrefs: scanAppLink ? { scan: scanAppLink } : {} });
  // PC（飞书 AppLink 不支持 PC ✓）⇒ **把「扫一扫」那一格藏起来**：
  //   她在 PC 上点它没有意义 ⇒ **不给"点了没反应"的死格子** ✗（她 2026-10-13 AC：「不可点、不给死按钮」）
  //   ⚠️ 面板也是空的（她：「面板里……不用留」✓）⇒ 更不能让它成为默认落在的那一格 ✗
  if (scanEntryReady && !scanAppLink) {
    const cell = nav.querySelector('[data-module="scan"]');
    if (cell) { cell.classList.add('hidden'); cell.setAttribute('aria-hidden', 'true'); }
  }
  // 默认打开那一格 = **第一格既不是链接、也没被藏起来的**（手机上 = 扫一扫 ✓；PC 上 = 销售 ✓）
  const firstUsable = [...nav.querySelectorAll('.main-tab:not([href])')].find((tab) => !tab.classList.contains('hidden'));
  initialModule = firstUsable?.dataset.module || 'sales';
}

/** 取一次「扫一扫」入口信息（只读；失败 ⇒ 那一格仍是按钮 ⇒ 进面板给人话 + 手输，不白屏 ✓） */
async function loadScanEntry() {
  try {
    const response = await fetch('/api/workbench/scan-entry');
    const payload = await response.json();
    scanEntryReady = true;
    if (payload?.success === true && payload.canScan === true && payload.appLink) {
      scanAppLink = payload.appLink;
    }
    // ⭐ 不论能不能扫都要重渲染：能扫 ⇒ 那一格变链接 ✓；不能扫（PC）⇒ 那一格**藏起来** ✓
    renderMainTabs();
    bindMainTabClicks();
  } catch {
    // 取不到 ⇒ 什么都不做 ✓
  }
}

/** 只给"不是链接"的格子绑面板切换（链接格交给浏览器 ✓ 不要拦它的默认行为 ✗） */
function bindMainTabClicks() {
  document.querySelectorAll('.main-tab:not([href])').forEach((tab) => {
    if (tab.dataset.bound === '1') return;
    tab.dataset.bound = '1';
    tab.addEventListener('click', () => activateModule(tab.dataset.module));
  });
}

function activateModule(moduleId) {
  showPageError('');
  document.querySelectorAll('.main-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.module === moduleId));
  mounted.forEach((container, id) => container.classList.toggle('hidden', id !== moduleId));
  if (mounted.has(moduleId)) return;
  const module = modules.get(moduleId);
  if (!module) return showPageError(`未知工作台模块：${moduleId}`);
  const container = document.createElement('div');
  container.dataset.modulePanel = moduleId;
  host.append(container);
  mounted.set(moduleId, container);
  module.mount(container);
}

async function start() {
  // ⚠️ 先把 tab 渲染出来、再把监听**绑上**（都放在鉴权之前）。原来监听绑在 `requireFeishuAuth`
  //    之后，而 `/me` 一返回 401 就在那里面抛了错，这一句永远走不到 —— 现象正是她遇到的
  //    「工作台启动失败：请求失败（401）」＋ tab 点了没反应。
  //    绑在这里之后，鉴权失败时页面仍然是可交互的（各模块自己会提示取不到数据）。
  renderMainTabs();
  bindMainTabClicks();
  // ⚠️ **不 await**：它只决定"那一格是链接还是按钮"，不阻塞鉴权与首屏 ✓
  void loadScanEntry();
  try {
    const ready = await requireFeishuAuth({
      statusElement: document.getElementById('auth-status'),
      logoutButton: document.getElementById('logout'),
    });
    if (!ready) return;
    activateModule(initialModule);
  } catch (error) {
    showPageError(`工作台启动失败：${describeError(error)}`);
    // 401 已经在 requireFeishuAuth 里自动跳登录了；这里是兜底（跳不过去 / 403 账号
    // 未被授权 / 网络错误）——至少给她一个能点的「去登录」，而不是死在这一屏。
    showLoginButton();
  }
}

start();
