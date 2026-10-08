import { requireFeishuAuth, showLoginButton } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { createCommonModule } from './features/common/index.js';
import { createInventoryAdjustmentModule } from './features/inventory/adjustment.js';
import { createLabelPrintModule } from './features/labels/index.js';
import { createPurchaseLinksModule } from './features/purchase/links.js';

// 独立页面注册表：key = 页面的 <body data-view="...">，value = 该页面的模块工厂。
//   common.html               → 信息录入（原「常用功能」**只改名**，里面入口不动）
//   inventory-adjustment.html → 信息录入 → 库存手工调整（盘点调整 / 换季调整）
//   purchase-return.html      → 信息录入 → 报货与退货（两个飞书表单外链，不做查询）
//   label-print.html          → 信息录入 → 鞋盒标签打印（**只读**实时库存 → A4 标签 → 浏览器打印）
//
// ⚠️ 2026-10-08：「信息查询」两个板块（销售查询 / 库存查询）**就是飞书多维表格的外链卡**，
//    按她的口径「**我们不用自己搭建接口**」—— 所以这里**不再注册** `sales-query` / `inventory`
//    两个视图（它们对应的自建页面与接口已于同日删除）。**不为查询新增任何页面**。
const factories = {
  common: () => createCommonModule({ focused: true }),
  'inventory-adjustment': () => createInventoryAdjustmentModule(),
  'purchase-return': () => createPurchaseLinksModule(),
  'label-print': () => createLabelPrintModule(),
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
    // 与 index.html 同一条兜底：401 会自动跳登录，其余失败（403 / 网络）至少给一个
    // 能点的「去登录」，别只留一句"启动失败"。
    showLoginButton();
  }
}

start();
