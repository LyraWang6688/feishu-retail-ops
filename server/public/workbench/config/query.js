import { SALES_QUERY_PAGE_URL, INVENTORY_QUERY_PAGE_URL } from './links.js';

/**
 * 【信息查询】tab 的**两个板块**（销售查询 · 库存查询）——
 * ⭐ **配置先行：加减板块 / 改文案只改这一个文件**，渲染层不写死清单、更不写死 URL。
 *
 * ⭐ 业务负责人 2026-10-08（逐字）：
 *   「**2. 信息查询**：整合已有的两个 tab 页，放到同一个 tab 页里的**两个板块**，即"销售查询"和"库存查询"」
 *   「销售查询和库存查询点开也是**多维表格上的一个网页**。⇒ 在这个维度上我们**不用自己搭建接口**」
 *
 * ⇒ 每个板块 = **一张卡**，`href` **只来自 `config/links.js`**（URL 单一来源，本文件不复制字面量）。
 *    她还没给 URL ⇒ 现在是空串 ⇒ 卡面显示「链接待配置」且**不可点**（行为见 `config/links.js` 的说明）。
 *
 * 字段：
 *   `id`    稳定标识（测试 / 排重用，不渲染）
 *   `icon`  卡片图标
 *   `title` 板块标题（逐字 = 她说的「销售查询」「库存查询」）
 *   `desc`  一句话说明
 *   `href`  飞书多维表格网页外链（空串 = 待配置）
 */
export const QUERY_SECTIONS = [
  {
    id: 'sales-query',
    icon: '📈',
    title: '销售查询',
    desc: '销售明细在飞书多维表格里看——点一下直接打开',
    href: SALES_QUERY_PAGE_URL,
  },
  {
    id: 'inventory-query',
    icon: '📦',
    title: '库存查询',
    desc: '实时库存在飞书多维表格里看——点一下直接打开',
    href: INVENTORY_QUERY_PAGE_URL,
  },
];
