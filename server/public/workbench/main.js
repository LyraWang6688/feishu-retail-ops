import { requireFeishuAuth, showLoginButton } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { mainTabsHtml, MAIN_TABS } from './core/tabs.js';
import { TAP_TELEMETRY } from './config/telemetry.js';
import { createDomainModule } from './features/domains/index.js';
import { createPlaceholderModule } from './features/shared/placeholder.js';

/**
 * ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤「工作台接同一套上报」）：
 *   工作台与**扫码页**用的是**同一份**客户端实现（`shared/ui-tap.js`，由各 html 先用
 *   `<script src>` 加载 ⇒ 这里只有 `window.dshUiTap`）—— 本函数只做**一次委托绑定**：
 *     · 带 `[data-tap-target]` 的元素（留给以后按需加）⇒ 记一条 `ui.tap`；
 *     · 表单提交 ⇒ 把 `tap_id` 塞进表单（写请求随后带上它 ⇒ 服务端记 `ui.tap.result`）。
 *   ⭐ 一级 tab 那几格**不加属性**（它们的 HTML 形状被好几条哨兵逐字钉着）⇒ 由下面
 *      `bindMainTabClicks` 的**既有**监听调 `trackTap`，走的是**同一个**上报实现 ✓。
 *   ⚠️ 绑在**鉴权之前**（与 tab 渲染同一条理由）：未登录时页面也点得动，埋点照样有据；
 *   🔴 埋点**绝不**影响她的操作：脚本没加载 / 报错 ⇒ 静默返回（`try` 包住）；
 *      也**绝不**取消浏览器默认行为（那一格是 AppLink，拦了就"点了没反应" ✗）。
 */
function bindTapTelemetry() {
  try {
    const reporter = typeof window === 'undefined' ? null : window.dshUiTap;
    if (!reporter || typeof reporter.bind !== 'function') return;
    reporter.bind({
      path: TAP_TELEMETRY.path,
      page: TAP_TELEMETRY.page,
      formField: TAP_TELEMETRY.formField,
    });
  } catch {
    // 埋点失败从不影响她操作 ✓
  }
}

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
//      口径：「代码从仓库里删，不是隐藏」）⇒ （已删除的旧首页模块）
//      **当前没有任何页面挂载**（`standalone.js` 的注册已摘），只是先留着没删。
// ⚠️ HIDDEN（入口隐去、**代码保留**）：finance / douyin / platform ——
//    它们仍在下面这个 modules 表里（占位模块），但**当前没有任何页面列出它们**
//    （原先列它们的「其它 / 历史功能」页已删）。要恢复某个入口：在 `config/tabs.js` 的
//    `MAIN_TABS` 里加回一条即可，逻辑不用改。
const modules = new Map([
  // ── 一级 tab 的来源（顺序 = `config/tabs.js` 的 MAIN_TABS；第一条 = 她 2026-10-13 定的「扫一扫」）──
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
// 扫一扫按领域拆开后，不再有全局扫一扫；首屏固定从销售进入。
function renderMainTabs() {
  const nav = document.getElementById('main-tabs');
  nav.innerHTML = mainTabsHtml(MAIN_TABS);
  const first = nav.querySelector('.main-tab:not(.hidden)');
  initialModule = first?.dataset.module || 'sales';
}

/** 只给"不是链接"的格子绑面板切换（链接格交给浏览器 ✓ 不要拦它的默认行为 ✗） */
function bindMainTabClicks() {
  document.querySelectorAll('.main-tab:not([href])').forEach((tab) => {
    if (tab.dataset.bound === '1') return;
    tab.dataset.bound = '1';
    tab.addEventListener('click', () => {
      // ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤）：她点 tab ⇒ 走**同一份**上报实现（`shared/ui-tap.js`）。
      //    ⚠️ 在这里上报（而不是给 tab 加属性）：tab 的 HTML 形状被好几条哨兵**逐字钉着**
      //      （`workbenchScanEntry` / `workbenchMainTitle` 等）⇒ 一个属性都不加 ✓ 判据不放宽 ✓
      //    ⚠️ 一次**点击**记一条（服务端按窗口判 `ui.tap.repeated`）—— 埋点失败静默 ✓
      trackTap(`tab:${tab.dataset.module}`);
      activateModule(tab.dataset.module);
    });
  });
}

/** 埋点上报的**唯一入口**（埋点失败 / 脚本没加载 ⇒ 静默，绝不影响她要做的操作 ✓）。 */
function trackTap(target) {
  try {
    const reporter = typeof window === 'undefined' ? null : window.dshUiTap;
    if (!reporter || typeof reporter.track !== 'function') return;
    reporter.track(target, { path: TAP_TELEMETRY.path, page: TAP_TELEMETRY.page });
  } catch { /* 埋点失败从不影响她操作 ✓ */ }
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
  // ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤）：先绑埋点委托（与 tab 渲染同一条理由 —— 鉴权之前就可交互）。
  bindTapTelemetry();
  // ⚠️ 先把 tab 渲染出来、再把监听**绑上**（都放在鉴权之前）。原来监听绑在 `requireFeishuAuth`
  //    之后，而 `/me` 一返回 401 就在那里面抛了错，这一句永远走不到 —— 现象正是她遇到的
  //    「工作台启动失败：请求失败（401）」＋ tab 点了没反应。
  //    绑在这里之后，鉴权失败时页面仍然是可交互的（各模块自己会提示取不到数据）。
  renderMainTabs();
  bindMainTabClicks();
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
