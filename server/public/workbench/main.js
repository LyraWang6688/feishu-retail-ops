import { requireFeishuAuth } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { createSalesModule } from './features/sales/index.js';
import { createPurchaseModule } from './features/purchase/index.js';
import { createInventoryModule } from './features/inventory/index.js';
import { createPlaceholderModule } from './features/shared/placeholder.js';

const modules = new Map([
  ['sales', createSalesModule()],
  ['purchase', createPurchaseModule()],
  ['inventory', createInventoryModule()],
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
  try {
    const ready = await requireFeishuAuth({
      statusElement: document.getElementById('auth-status'),
      logoutButton: document.getElementById('logout'),
    });
    if (!ready) return;
    document.querySelectorAll('.main-tab').forEach((tab) => {
      tab.addEventListener('click', () => activateModule(tab.dataset.module));
    });
    activateModule('sales');
  } catch (error) {
    showPageError(`工作台启动失败：${describeError(error)}`);
  }
}

start();
