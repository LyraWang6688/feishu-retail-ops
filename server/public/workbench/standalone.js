import { requireFeishuAuth } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { createCommonModule } from './features/common/index.js';
import { createSalesModule } from './features/sales/index.js';
import { createInventoryModule } from './features/inventory/index.js';
import { createInventoryAdjustmentModule } from './features/inventory/adjustment.js';
import { createPurchaseReturnModule } from './features/purchase/return.js';

// 独立页面注册表：key = 页面的 <body data-view="...">，value = 该页面的模块工厂。
// 三个一级 tab 各一个页面，另加两个子页：
//   common.html               → 常用功能
//   sales-query.html          → 销售查询（原「今日销售」，支持按某日 / 按区间）
//   inventory.html            → 实时库存
//   inventory-adjustment.html → 常用功能 → 库存手工调整（盘点调整 / 换季调整）
//   purchase-return.html      → 常用功能 → 采购退货（采购 / 退货）
const factories = {
  common: () => createCommonModule({ focused: true }),
  'sales-query': () => createSalesModule({ focused: true }),
  inventory: () => createInventoryModule({ focused: true }),
  'inventory-adjustment': () => createInventoryAdjustmentModule(),
  'purchase-return': () => createPurchaseReturnModule(),
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
