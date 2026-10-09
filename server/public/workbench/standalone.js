import { requireFeishuAuth, showLoginButton } from './core/auth.js';
import { describeError, showPageError } from './core/ui.js';
import { createInventoryAdjustmentModule } from './features/inventory/adjustment.js';
import { createLabelPrintModule } from './features/labels/index.js';

// 独立页面注册表：key = 页面的 <body data-view="...">，value = 该页面的模块工厂。
//   inventory-adjustment.html → 库存 tab → 手工调整（盘点调整 / 换季调整）
//   label-print.html          → 货品 tab → 标签打印（**只读**实时库存+货品信息 → 40×30mm A4 标签 → 浏览器打印）
//
// ⚠️ 2026-10-08：「信息查询」两个板块（销售查询 / 库存查询）**就是飞书多维表格的外链卡**，
//    按她的口径「**我们不用自己搭建接口**」—— 所以这里**不再注册** `sales-query` / `inventory`
//    两个视图（它们对应的自建页面与接口已于同日删除）。**不为查询新增任何页面**。
//
// ⚠️ 2026-10-09：业务负责人点头删掉四个老页面（她的口径：**代码从仓库里删，不是隐藏**）——
//    `others.html`（「其它 / 历史功能」页）· `common.html`（老「信息录入 / 常用功能」首页）·
//    `purchase.html`（老「采购管理」页）· `purchase-return.html`（老采购退货独立页）。
//    ⇒ 这四个视图的注册与模块 import **一并删除**（页面都删了，注册留着就是死入口）。
//    ⭐ 功能一个都没丢：四个领域 tab（`config/domains.js`）上已经有等价入口 ——
//      采购 →「报货 / 验收 / 退货」两张飞书表单卡、库存 →「手工调整」、货品 →「标签打印」。
// ⚠️ 留下来的就是**这两个**独立页；两个都**保留**（她要的）。
const factories = {
  'inventory-adjustment': () => createInventoryAdjustmentModule(),
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
