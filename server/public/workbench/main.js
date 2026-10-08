import { requireFeishuAuth, showLoginButton } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { mainTabsHtml } from './core/tabs.js';
import { createCommonModule } from './features/common/index.js';
import { createQueryModule } from './features/query/index.js';
import { createPurchaseModule } from './features/purchase/index.js';
import { createPlaceholderModule } from './features/shared/placeholder.js';

// 一级 tab 只有 2 个（业务负责人 2026-10-08 定）：
//   ① 信息录入（原「常用功能」只改名）· ② 信息查询（销售查询 / 库存查询 两个板块 = 飞书外链卡）
// ⚠️ **文案 / 顺序 / data-module 的唯一来源是 `config/tabs.js` 的 `MAIN_TABS`**，
//    由 `core/tabs.js` 的 `mainTabsHtml()` 渲染进 `#main-tabs`（配置先行：加减 tab 只改配置）。
//    `index.html` 里的 `<nav id="main-tabs">` 因此是空的。
// ⚠️ 自建的「销售查询 / 实时库存」页面与查询接口已于同一天整体删除
//    （三个静态页 · 两个前端模块 · 路由 `/sales/query` · `/sales/today`）。
//    独立页 `common.html`（信息录入）· `inventory-adjustment.html` · `purchase-return.html` 照旧。
//
// ⚠️ HIDDEN（入口隐去、**代码保留**）：purchase / finance / douyin / platform。
//    它们仍然在这个 modules 表里，只是 `config/tabs.js` 里没有对应的 tab，
//    所以点不到。要恢复某个入口：在 `config/tabs.js` 的 `MAIN_TABS` 里加回一条即可，逻辑不用改。
const modules = new Map([
  ['common', createCommonModule()],
  ['query', createQueryModule()],
  // ── 以下四个是隐去的入口（保留代码）────────────────────────────────────
  ['purchase', createPurchaseModule()],
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
// 页面加载时打开的 tab = 第一个可见 tab（配置里的第一条 = 「信息录入」）。
// 写死某个 module 会在 tab 顺序调整后又对不上，所以从 DOM 里取。
let initialModule = 'common';

// 把一级 tab 渲染进 nav —— 文案 / 顺序 / data-module 全部来自 `config/tabs.js`（配置先行）。
function renderMainTabs() {
  const nav = document.getElementById('main-tabs');
  nav.innerHTML = mainTabsHtml();
  initialModule = nav.querySelector('.main-tab')?.dataset.module || 'common';
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
  document.querySelectorAll('.main-tab').forEach((tab) => {
    tab.addEventListener('click', () => activateModule(tab.dataset.module));
  });
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
