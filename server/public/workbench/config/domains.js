/**
 * ⭐⭐ 工作台**四个业务领域 tab** 的**子页面清单** —— **配置先行：加减 / 改名 / 换链接只改这一个文件**。
 *
 * 业务负责人 **2026-10-09** 定的最终结构（逐字）：
 *   「我们就按照**四个 tab 页**来规划：**销售、采购、库存和货品**……
 *    Tab 页的顺序从左往右是：**销售、库存、采购和货品**」
 *   「在 4 个 tab 页里面，我们**都能扫同一个二维码**，但是**点击的按钮不同，触发的逻辑就不一样**」
 *
 * ── 她要的映射（本文件逐条落实，渲染层只负责画）─────────────────────────────
 *   | Tab  | 子页面                                                                   |
 *   | 销售 | ① 销售建单（扫码把鞋登记下来要卖；**资金等非必填、可后续补**）           |
 *   |      | ② 订单列表（补充信息单 ｜ 待交割单 ｜ 售后列表）                          |
 *   |      | ③ 销售查询（她配的多维表格 AI 页面**外链**）                             |
 *   | 库存 | ① 单款查询 ② 全仓查询（多维表格 AI 页面**外链**）③ 手工调整             |
 *   | 采购 | ① 报货 / 验收 / 退货 ② 采购订单列表（= 报货批次那些单）                  |
 *   | 货品 | ① 货品上新（飞书表单**外链**）② 标签打印（单个 + 批量）                  |
 *
 * ── 页面的 `kind`（渲染层按它挑实现，配置里**不写死 HTML**）─────────────────
 *   `entry`                —— 「输入编号 → 打开既有页面」的小入口（销售建单 / 单款查询 / 标签打印单个）
 *                            她是在手机上、多半**扫标签二维码**直接进；不方便扫码时从这里手输编号，
 *                            走的是**同一个页面**（`/s/{编号}?from=…` 或标签打印页），
 *                            ⇒ **不新开一套建单 / 查询逻辑**（各领域共用既有业务处理层）。
 *   `orders`               —— 订单列表（复用既有 `features/orders`，`mode` 决定只看销售还是只看采购）
 *   `query`                —— 她配的多维表格 AI 页面外链卡（复用 `features/query` 的卡片渲染）
 *   `links`                —— 一组卡片（外链 / 跳到本 tab 里的另一个子页）
 *   `inventory-adjustment` —— 复用既有「库存手工调整」模块（内嵌，不再跳走）
 *
 * ⚠️ **外链与 URL 一律只从 `config/links.js` / `config/query.js` 取**（本文件不复制字面量）。
 * ⚠️ `title` = 顶栏那一行（她要的领域名），`label` = 子 tab 上的短名。
 */

import {
  PRODUCT_NEW_FORM_URL,
  PURCHASE_REQUEST_FORM_URL,
  PURCHASE_RETURN_FORM_URL,
} from './links.js';

export const DOMAIN_TABS = [
  // ── ① 销售 ────────────────────────────────────────────────────────────────
  {
    id: 'sales',
    label: '销售',
    title: '销售',
    subtitle: '扫码建单 → 订单列表（补收款 / 交付 / 售后）→ 销售查询',
    pages: [
      {
        id: 'sales-create',
        label: '销售建单',
        kind: 'entry',
        title: '销售建单',
        subtitle: '扫鞋盒标签上的二维码就是这一件事；这里也可以手输编号进同一个页面',
        // 扫码页的**销售领域**（`?from=sales`）—— 各领域共用同一个扫码页与同一套业务处理层。
        targetTemplate: '/s/{number}?from=sales',
        fieldLabel: '编号',
        placeholder: '编号（货号|颜色|类别），例如 YD6693-2|黑色|A',
        buttonLabel: '打开销售建单页 →',
        hint: '资金（收款方式 / 收款金额）**不是必填**：先建单、之后在「订单列表 → 补充信息单」里补也可以。',
        steps: [
          '扫鞋盒标签上的二维码 → 顶部选「销售」→ 选尺码 → 「加入本单」（可以连着扫好几双）',
          '同一单扫完 → 填收款方式与金额（不填也行）→ 「提交这一单」',
          '没扫到的款：在上面输入编号，进的是同一个页面',
        ],
        links: [
          {
            icon: '🏷️',
            title: '还没有标签二维码？',
            desc: '去「货品 → 标签打印」按货号打一张，贴到鞋盒上就能扫了',
            href: '/workbench/label-print.html',
            arrow: '去打印 →',
          },
        ],
      },
      {
        id: 'sales-orders',
        label: '订单列表',
        kind: 'orders',
        mode: 'sales',
        title: '订单列表',
        subtitle: '销售单号 · 销售明细 · 收款情况；一张单一张卡，点开就能补收款 / 交付 / 售后',
      },
      {
        id: 'sales-query',
        label: '销售查询',
        kind: 'query',
        sectionId: 'sales-query',
      },
    ],
  },

  // ── ② 库存 ────────────────────────────────────────────────────────────────
  {
    id: 'inventory',
    label: '库存',
    title: '库存',
    subtitle: '单款查询 · 全仓查询 · 手工调整',
    pages: [
      {
        id: 'inventory-single',
        label: '单款查询',
        kind: 'entry',
        title: '单款查询',
        subtitle: '看某一个编号现在有几双、都在哪儿、缺哪些码',
        targetTemplate: '/s/{number}?from=inventory',
        fieldLabel: '编号',
        placeholder: '编号（货号|颜色|类别），例如 YD6693-2|黑色|A',
        buttonLabel: '查这一款的库存 →',
        hint: '最省事的用法还是**扫鞋盒标签上的二维码** → 顶部选「库存」，看到的库存表与这里一模一样。',
        steps: [
          '扫标签二维码 → 顶部选「库存」→ 直接看尺码 × 所属状态（门盒 / 样品 / 仓库）',
          '缺码的尺码会整行标出来（该类别在「尺码管理」里有、三种状态都没库存）',
        ],
      },
      {
        id: 'inventory-all',
        label: '全仓查询',
        kind: 'query',
        sectionId: 'inventory-query',
      },
      {
        id: 'inventory-adjust',
        label: '手工调整',
        kind: 'inventory-adjustment',
      },
    ],
  },

  // ── ③ 采购 ────────────────────────────────────────────────────────────────
  {
    id: 'purchase',
    label: '采购',
    title: '采购',
    subtitle: '报货 / 验收 / 退货 · 采购订单列表（= 报货批次那些单）',
    pages: [
      {
        id: 'purchase-report',
        label: '报货 / 验收 / 退货',
        kind: 'links',
        title: '报货 / 验收 / 退货',
        subtitle: '报货与退货还是那两个飞书表单；到货验收在「采购订单列表」里一批一批点',
        cards: [
          {
            icon: '🛒',
            title: '报货',
            desc: '供应商报货（飞书表单）——填完直接生成报货单',
            href: PURCHASE_REQUEST_FORM_URL,
            arrow: '去填写 →',
          },
          {
            icon: '↩️',
            title: '退货',
            desc: '把货退给供应商（飞书表单）——填完直接生成退货单',
            href: PURCHASE_RETURN_FORM_URL,
            arrow: '去填写 →',
          },
          {
            icon: '✅',
            title: '验收到货',
            desc: '去「采购订单列表」里，每一批点一下「验收到货」并填实际金额',
            // ⭐ 同一 tab 内的跳转（不是外链）：直接切到「采购订单列表」那个子页。
            jumpTo: 'purchase-orders',
            arrow: '去验收 →',
          },
        ],
      },
      {
        id: 'purchase-orders',
        label: '采购订单列表',
        kind: 'orders',
        mode: 'purchase',
        title: '采购订单列表',
        subtitle: '一张报货批次一张卡（报货批次号 · 货号 · 尺码 · 数量 · 到货状态），每张卡都能「验收到货」',
      },
    ],
  },

  // ── ④ 货品 ────────────────────────────────────────────────────────────────
  {
    id: 'product',
    label: '货品',
    title: '货品',
    subtitle: '货品上新 · 标签打印（单个 / 批量）',
    pages: [
      {
        id: 'product-new',
        label: '货品上新',
        kind: 'links',
        title: '货品上新',
        subtitle: '新增货品基础信息（走既有飞书表单，提交后由既有链路建档）',
        cards: [
          {
            icon: '🆕',
            title: '货品上新',
            desc: '填一张飞书表单即可；提交后货品会进「货品信息」，随后就能打标签',
            href: PRODUCT_NEW_FORM_URL,
            arrow: '去填写 →',
          },
        ],
      },
      {
        id: 'product-labels',
        label: '标签打印',
        kind: 'entry',
        title: '标签打印',
        subtitle: '单个 = 输入编号只打这一款；批量 = 打开标签页按条件挑货',
        // 「单个」= 把**货号**带进标签打印页（那一页的 `keyword` 认货号 ⇒ 只出这一款）。
        targetTemplate: '/workbench/label-print.html?keyword={itemNo}',
        fieldLabel: '编号 / 货号',
        placeholder: '编号（货号|颜色|类别）或货号，例如 XHB8095',
        buttonLabel: '只打这一款的标签 →',
        hint: '单个 = **按货号过滤**（同一货号的不同颜色会一起出来）。标签是 **40×30mm**、A4 一页铺多张，'
          + '用**浏览器打印**打出来（与原来那一页完全一样）。',
        links: [
          {
            icon: '🖨️',
            title: '批量打印',
            desc: '按货号 / 所属状态 / 品类 / 最近新增挑货，一次打一批（最多张数由服务端配置）',
            href: '/workbench/label-print.html',
            arrow: '打开标签打印页 →',
          },
        ],
      },
    ],
  },
];

/** 按 id 取一个领域（认不出来时**明确抛错**，不静默给一个空 tab）。 */
export const domainById = (id) => {
  const domain = DOMAIN_TABS.find((item) => item.id === id);
  if (!domain) throw new Error(`config/domains.js 找不到领域：${id}`);
  return domain;
};
