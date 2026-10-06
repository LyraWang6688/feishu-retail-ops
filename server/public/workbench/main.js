import { requireFeishuAuth, showLoginButton } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { createCommonModule } from './features/common/index.js';
import { createSalesModule } from './features/sales/index.js';
import { createPurchaseModule } from './features/purchase/index.js';
import { createInventoryModule } from './features/inventory/index.js';
import { createPlaceholderModule } from './features/shared/placeholder.js';

// 一级 tab 只有 3 个（业务负责人 2026-10-06）：常用功能 / 销售查询 / 实时库存。
// 每个 tab 在 index.html 里对应一个 data-module，也各自有一个独立页面：
//   common → /workbench/common.html · sales → /workbench/sales-query.html
//   inventory → /workbench/inventory.html
//
// ⚠️ HIDDEN（入口隐去、**代码保留**）：purchase / finance / douyin / platform。
//    它们仍然在这个 modules 表里，只是 index.html 里没有对应的 data-module 按钮，
//    所以点不到。要恢复某个入口：在 index.html 的 #main-tabs 里加回一行
//    <button class="main-tab" data-module="purchase">采购管理</button> 即可，逻辑不用改。
//    她明确说过「其余的入口可以先隐去，先不做」——是**隐去**，不是删。
const modules = new Map([
  ['common', createCommonModule()],
  ['sales', createSalesModule()],
  ['inventory', createInventoryModule()],
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
// 页面加载时打开的 tab = 第一个可见 tab（现在是「常用功能」）。写死成 'sales'
// 会在 tab 顺序调整后又对不上，所以从 DOM 里取。
const initialModule = document.querySelector('.main-tab')?.dataset.module || 'common';

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
  // ⚠️ tab 的监听**先绑上**（放在鉴权之前）。原来它绑在 `requireFeishuAuth` 之后，
  //    而 `/me` 一返回 401 就在那里面抛了错，这一句永远走不到 —— 现象正是她遇到的
  //    「工作台启动失败：请求失败（401）」＋ 三个 tab 点了没反应。
  //    绑在这里之后，鉴权失败时页面仍然是可交互的（各模块自己会提示取不到数据）。
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
