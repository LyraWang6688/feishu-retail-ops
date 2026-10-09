/**
 * 「**其它 / 历史功能**」页的清单 —— **配置先行：加减遗留入口只改这一个文件**。
 *
 * 业务负责人 2026-10-09 把一级 tab 换成四个业务领域之后，**旧入口一个都没有删**：
 *   ⚠️ 「其余旧功能不删：集中到一个**不显眼的"其它/历史功能"入口**（例如页脚一行，
 *      点开一个独立页列出它们）」—— 就是这一页：
 *   · 工作台首页页脚那一行 `其它 / 历史功能` → `/workbench/others.html`；
 *   · 页面上的卡片 = 下面 `LEGACY_ENTRIES`（**能点进去**，功能原样）；
 *   · 下面 `PLANNED_MODULES` = 一直只是占位（规划中）的那三个模块 ——
 *     **模块代码还在**（`main.js` 的 modules 表里保留），这里如实列出来，不是能点的入口。
 *
 * ⚠️ 这里**只放清单**，不放逻辑；链接一律是工作台内的独立页（老链接 / 老收藏照样能用）。
 * ⚠️ 与 `config/home.js`（原「信息录入」首页的入口清单）**刻意分开**：那一份是她的常用入口，
 *    这一份是"不在四个 tab 上、但一个都没丢"的历史入口。两份互不引用，各改各的。
 */

export const OTHERS_PAGE = {
  title: '其它 / 历史功能',
  subtitle: '不在四个 tab 上、但一个都没删的旧入口；功能都在，只是不再占一级 tab',
  empty: '这里现在没有遗留入口',
  plannedTitle: '规划中的模块（占位，还不能点）',
};

/**
 * 遗留入口（**能点进去**）。
 *   `id`    稳定标识（测试 / 排重用）
 *   `icon`  卡片图标
 *   `title` 卡片标题
 *   `desc`  一句话说明（写清楚它原来是干什么的）
 *   `href`  目标（工作台内的独立页）
 */
export const LEGACY_ENTRIES = [
  {
    id: 'common-home',
    icon: '📋',
    title: '信息录入（原「常用功能」首页）',
    desc: '报货与退货 · 库存手工调整 · 鞋盒标签打印 —— 原来那一页原样保留，链接也没变',
    href: '/workbench/common.html',
    arrow: '进入 →',
  },
  {
    id: 'purchase-manage',
    icon: '🚚',
    title: '采购管理（原一级 tab，2026-10-09 起收在这里）',
    desc: '报货信息情况 · 到货验收情况两个查询面板——读的还是既有接口，一个字没改',
    href: '/workbench/purchase.html',
    arrow: '进入 →',
  },
  {
    id: 'inventory-adjustment',
    icon: '🧮',
    title: '库存手工调整（独立页）',
    desc: '盘点调整（改数量）· 换季调整（门盒/样品 ↔ 仓库，数量不变）——现在也在「库存」tab 里',
    href: '/workbench/inventory-adjustment.html',
    arrow: '进入 →',
  },
  {
    id: 'purchase-return-page',
    icon: '🛒',
    title: '采购和退货（两张表单的独立页）',
    desc: '报货 / 退货两个飞书表单——老链接 / 老收藏打开还是这两张卡',
    href: '/workbench/purchase-return.html',
    arrow: '进入 →',
  },
  {
    id: 'label-print-page',
    icon: '🏷️',
    title: '鞋盒标签打印（独立页）',
    desc: '40×30mm 标签、A4 一页多张——现在也在「货品 → 标签打印」里（单个 / 批量）',
    href: '/workbench/label-print.html',
    arrow: '进入 →',
  },
];

/**
 * 规划中的模块 —— 一直只是占位（原来在一级 tab 之外、入口隐去）。
 * 文案与 `main.js` 里那三个 `createPlaceholderModule` 的取值**逐字一致**
 * （改一处要同步另一处；有测试钉着这两边一致）。
 */
export const PLANNED_MODULES = [
  {
    id: 'finance',
    icon: '💰',
    title: '资金管理',
    desc: '统一展示实际到账、顾客待收款、平台待结算和供应商应付款。',
    planned: ['收支流水', '应收应付', '资金报表与对账'],
  },
  {
    id: 'douyin',
    icon: '🎬',
    title: '抖音运营',
    desc: '管理第三方券种、核销记录、平台结算和对账差异。',
    planned: ['券种映射', '核销汇总', '平台结算对账'],
  },
  {
    id: 'platform',
    icon: '🧩',
    title: '平台管理',
    desc: '维护货品、供应商、客户、门店、库存行为和支付方式等基础资料。',
    planned: ['基础资料查询', '业务配置入口', '权限与操作记录'],
  },
];
