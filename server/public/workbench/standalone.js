import { requireFeishuAuth } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { createSalesModule } from './features/sales/index.js';
import { createInventoryModule } from './features/inventory/index.js';

const factories = {
  'sales-today': () => createSalesModule({ focused: true }),
  inventory: () => createInventoryModule({ focused: true }),
};

async function start() {
  try {
    const ready = await requireFeishuAuth({
      statusElement: document.getElementById('auth-status'),
      logoutButton: document.getElementById('logout'),
    });
    if (!ready) return;
    const view = document.body.dataset.view;
    const factory = factories[view];
    if (!factory) throw new Error(`未知独立页面：${view}`);
    factory().mount(document.getElementById('standalone-host'));
  } catch (error) {
    showPageError(`页面启动失败：${describeError(error)}`);
  }
}

start();
