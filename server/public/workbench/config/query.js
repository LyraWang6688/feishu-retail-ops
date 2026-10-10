import { SALES_QUERY_PAGE_URL, INVENTORY_QUERY_PAGE_URL } from './links.js';

/**
 * 多维表格 AI 页面（外链）的两个板块 —— **配置先行：加减板块 / 改文案只改这一个文件**，
 * 渲染层不写死清单、更不写死 URL。
 *
 * ⭐ 业务负责人 2026-10-08（逐字）：
 *   「**2. 信息查询**：整合已有的两个 tab 页，放到同一个 tab 页里的**两个板块**，即"销售查询"和"库存查询"」
 *   「销售查询和库存查询点开也是**多维表格上的一个网页**。⇒ 在这个维度上我们**不用自己搭建接口**」
 *
 * ⭐⭐ 2026-10-09（业务负责人定的最终结构）：这两个板块**不再同属一个「信息查询」tab**，
 *   而是各回各的领域（她给的名字也跟着改到位）：
 *     · `sales-query`     → **销售 tab · ③ 销售查询**（文案不变）
 *     · `inventory-query` → **库存 tab · ② 全仓查询**（她这次的叫法是「全仓查询」；
 *       **URL 一个字没换**，还是她 2026-10-08 给的同一张多维表格页面）
 *   ⇒ 页面清单与顺序在 `config/domains.js`（那里只按 id 引用这里的板块）。
 *
 * ⭐ 2026-10-10（她真机反馈「下面的这些文字解释就不用了」）：卡片**只留标题**（点一下直接跳），
 *   那句「在飞书多维表格里看——点一下直接打开」的副标题（`desc`）**已整字段退场**。
 *
 * 字段：
 *   `id`    稳定标识（测试 / 排重用，不渲染；`config/domains.js` 按它引用）
 *   `icon`  卡片图标
 *   `title` 板块标题（逐字 = 她说的名字）
 *   `href`  飞书多维表格网页外链（空串 = 待配置；空值时渲染成不可点的卡，见 `config/links.js`）
 */
export const QUERY_SECTIONS = [
  {
    id: 'sales-query',
    icon: '📈',
    title: '销售查询',
    href: SALES_QUERY_PAGE_URL,
  },
  {
    id: 'inventory-query',
    icon: '📦',
    title: '全仓查询',
    href: INVENTORY_QUERY_PAGE_URL,
  },
];
