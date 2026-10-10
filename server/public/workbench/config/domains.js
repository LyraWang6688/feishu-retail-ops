/**
 * ⭐⭐ 工作台**四个业务领域 tab** 的**子页面清单** —— **配置先行：加减 / 改名 / 换链接只改这一个文件**。
 *
 * 业务负责人 **2026-10-09** 定的结构（逐字）：
 *   「我们就按照**四个 tab 页**来规划：**销售、采购、库存和货品**……
 *    Tab 页的顺序从左往右是：**销售、库存、采购和货品**」
 *   「在 4 个 tab 页里面，我们**都能扫同一个二维码**，但是**点击的按钮不同，触发的逻辑就不一样**」
 *
 * ⭐⭐ **2026-10-10（业务负责人看了真机之后）**：
 *   「我就以采购这个页为例吧，**这些东西你都不需要**。我不知道这是注释文字吗？**都需要删掉**。
 *    比如说采购这个 tab 页下面，我已经点到了采购，**直接出来报货、退货、到货就行**，
 *    **下面的这些文字解释就不用了**，你理解吗？」
 *   ⇒ 本文件里**所有"解释我怎么用"的文字全部退场**：
 *     领域描述行 · 子页描述 · 使用步骤 · 提示句 · 卡片副标题（`desc`）· 占位页长说明（`note`）。
 *     界面只留"**能点、能做的事**"：一级 tab 名 · 子 tab 名 · 卡片**标题 + 动作** ·
 *     功能按钮 · 内嵌的验收台 · 状态小标签（例：占位页那一个「待建设」）。
 *   ⚠️ 因此下面每条配置里**只有**：`id` / `label`（子 tab 短名）/ `kind` / 目标（链接或模板）/
 *     卡片标题 + 动作 / 状态标记；**没有一句是写给用户看的说明文**。
 *   ⭐ 验收标准（先写后做）见 `test/workbenchNoManualText.test.js`。
 *
 * ── 她要的映射（本文件逐条落实，渲染层只负责画）─────────────────────────────
 *   | Tab  | 子页面（子 tab 短名逐字）                                                |
 *   | 销售 | ① 销售建单 ② 订单列表 ③ 销售查询 ④ 客户往来款（占位）                    |
 *   | 库存 | ① 单款查询 ② 全仓查询 ③ 手工调整                                        |
 *   | 采购 | ① 报货 / 验收 / 退货（验收台内嵌在本页）② 采购订单列表（占位）③ 供应商往来款（占位）|
 *   | 货品 | ① 货品上新 ② 标签打印                                                   |
 *
 * ── 页面的 `kind`（渲染层按它挑实现，配置里**不写死 HTML**）─────────────────
 *   `entry`                —— 「输入编号 → 打开既有页面」的小入口（销售建单 / 单款查询 / 标签打印单个）
 *   `orders`               —— 订单列表（复用既有 `features/orders`，`mode` 决定只看销售还是只看采购）
 *   `query`                —— 她配的多维表格 AI 页面外链卡（复用 `features/query` 的卡片渲染）
 *   `links`                —— 一组卡片（外链 / 本页锚点 / 跳到本 tab 里的另一个子页）；
 *                            `embed` 时再内嵌一个**既有模块**（例：验收台）
 *   `placeholder`          —— ⭐ **占位页**：只有一个小标记「待建设」
 *   `inventory-adjustment` —— 复用既有「库存手工调整」模块（内嵌，不再跳走）
 *
 * ⚠️ **外链与 URL 一律只从 `config/links.js` / `config/query.js` 取**（本文件不复制字面量）。
 * ⚠️ `label` = 子 tab 上的短名（**页内不再重复写一遍** —— 那正是 2026-10-10 删掉的那一类）。
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
    pages: [
      {
        id: 'sales-create',
        label: '销售建单',
        kind: 'entry',
        // 扫码页的**销售领域**（`?from=sales`）—— 各领域共用同一个扫码页与同一套业务处理层。
        targetTemplate: '/s/{number}?from=sales',
        fieldLabel: '编号',
        placeholder: '编号（货号|颜色|类别），例如 YD6693-2|黑色|A',
        buttonLabel: '打开销售建单页 →',
        links: [
          {
            icon: '🏷️',
            title: '还没有标签二维码？',
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
      },
      {
        id: 'sales-query',
        label: '销售查询',
        kind: 'query',
        sectionId: 'sales-query',
      },
      // ⭐ 她 2026-10-09（下半场）加的第 4 个子页：**占位页**（只留「待建设」小标记）。
      {
        id: 'sales-customer-money',
        label: '客户往来款',
        kind: 'placeholder',
      },
    ],
  },

  // ── ② 库存 ────────────────────────────────────────────────────────────────
  {
    id: 'inventory',
    label: '库存',
    pages: [
      {
        id: 'inventory-single',
        label: '单款查询',
        kind: 'entry',
        targetTemplate: '/s/{number}?from=inventory',
        fieldLabel: '编号',
        placeholder: '编号（货号|颜色|类别），例如 YD6693-2|黑色|A',
        buttonLabel: '查这一款的库存 →',
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
    pages: [
      {
        id: 'purchase-report',
        label: '报货 / 验收 / 退货',
        kind: 'links',
        // ⭐ 卡片只留**标题 + 动作**（副标题就是她截图点名"都不需要"的那几句）。
        cards: [
          {
            icon: '🛒',
            title: '报货',
            href: PURCHASE_REQUEST_FORM_URL,
            arrow: '去填写 →',
          },
          {
            icon: '↩️',
            title: '退货',
            href: PURCHASE_RETURN_FORM_URL,
            arrow: '去填写 →',
          },
          {
            icon: '✅',
            title: '验收到货',
            // ⭐ 同一页里的锚点（**不是**外链、也不是跳去别的子页）：
            //    验收台（既有订单模块的 purchase 模式）就内嵌在下面那一块（`embed.id` 就是锚点 id）。
            anchor: '#purchase-arrival',
            arrow: '去验收 →',
          },
        ],
        // ⭐ 内嵌**既有** `features/orders`（`mode: 'purchase'`）—— 原来那套验收台。
        //    ⚠️ 不画标题、不画说明：验收台本身（批次卡 + 明细行 + 【验收到货】按钮）就是全部内容。
        embed: {
          id: 'purchase-arrival',
          module: 'orders',
          mode: 'purchase',
        },
      },
      {
        id: 'purchase-orders',
        label: '采购订单列表',
        kind: 'placeholder',
      },
      {
        id: 'purchase-supplier-money',
        label: '供应商往来款',
        kind: 'placeholder',
      },
    ],
  },

  // ── ④ 货品 ────────────────────────────────────────────────────────────────
  {
    id: 'product',
    label: '货品',
    pages: [
      {
        id: 'product-new',
        label: '货品上新',
        kind: 'links',
        cards: [
          {
            icon: '🆕',
            title: '货品上新',
            href: PRODUCT_NEW_FORM_URL,
            arrow: '去填写 →',
          },
        ],
      },
      {
        id: 'product-labels',
        label: '标签打印',
        kind: 'entry',
        // 「单个」= 把**货号**带进标签打印页（那一页的 `keyword` 认货号 ⇒ 只出这一款）。
        targetTemplate: '/workbench/label-print.html?keyword={itemNo}',
        fieldLabel: '编号 / 货号',
        placeholder: '编号（货号|颜色|类别）或货号，例如 XHB8095',
        buttonLabel: '只打这一款的标签 →',
        links: [
          {
            icon: '🖨️',
            title: '批量打印',
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
