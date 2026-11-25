'use strict';

/**
 * 扫码页「货品卡」上那两个入口（2026-11-17 · 业务负责人）：
 *   · **库存调整** —— 点一下直达 工作台 → 库存 → 手工调整 → 单双调整，并带出这一款；
 *   · **信息完善** —— 只在「商品信息缺失 / 标签信息缺失」不是「齐备」时出现；按钮只显示固定文案。
 *
 * 两个领域共用同一张货品卡（`views/scanPage/layout.js` 的 `identityHtml`）⇒ 写一处、两页都有。
 * 链接一律**相对路径**（`/workbench/?…`）⇒ 与扫码页同源、共用同一个飞书会话 cookie。
 *
 * ⚠️ `adjustHrefTemplate` 里的 `{recordId}` 由服务层用 `encodeURIComponent` 填；
 *    工作台那边读 `module/page/product` 三个参数（见 `public/workbench/main.js`）。
 */
const { readList, readString } = require('./envValue');

const PRODUCT_ACTIONS = Object.freeze({
  // 哪些领域显示。库存页也要显示「库存调整」（2026-11-25 业务负责人）。
  realms: Object.freeze(readList(process.env, 'SCAN_PAGE_PRODUCT_ACTIONS_REALMS') ?? ['sales', 'purchase_return', 'inventory']),
  // 库存调整也出现在库存页；信息完善仍只在会建单的领域。
  adjustRealms: Object.freeze(readList(process.env, 'SCAN_PAGE_PRODUCT_ADJUST_REALMS') ?? ['sales', 'purchase_return', 'inventory']),
  infoRealms: Object.freeze(readList(process.env, 'SCAN_PAGE_PRODUCT_INFO_REALMS') ?? ['sales', 'purchase_return']),
  adjustLabel: readString(process.env, 'SCAN_PAGE_PRODUCT_ADJUST_LABEL', '库存调整'),
  adjustHrefTemplate: readString(
    process.env,
    'SCAN_PAGE_PRODUCT_ADJUST_HREF',
    '/workbench/?module=inventory&page=inventory-adjust&product={recordId}',
  ),
  // 资料不齐时的固定入口文案（不再拼接缺失明细）。
  infoLabel: readString(process.env, 'SCAN_PAGE_PRODUCT_INFO_LABEL', '信息完善'),
  // 多个缺失项之间（缺样例图；缺商品信息：…；缺标签：…）—— 与货品资料页 chips 同一套口径。
  gapIssueSeparator: readString(process.env, 'SCAN_PAGE_PRODUCT_GAP_ISSUE_SEPARATOR', '；'),
});

module.exports = { PRODUCT_ACTIONS };
