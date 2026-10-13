import { MAIN_TABS } from '../config/tabs.js';

/**
 * 一级 tab 的按钮 HTML —— **文案 / 顺序 / `data-module` 全部来自 `config/tabs.js`**（配置先行）。
 *
 * ⚠️ **仍然走既有机制**：`button.main-tab[data-module]` + `main.js` 的 `modules` 表。
 *    这里只把「清单 → 按钮」这一步从写死的 HTML 挪进配置，逻辑没换。
 * ⚠️ **第一条自动带 `active`** —— `main.js` 也按 DOM 里第一个 `.main-tab` 决定默认打开哪个，
 *    两处口径必须一致（本函数就是唯一来源）。
 */
export function mainTabsHtml(tabs = MAIN_TABS, options = {}) {
  // ⭐⭐ 2026-10-13 晚（她真机口径，逐字）：「**就是点那个 tab 上的扫一扫**」——
  //    ⇒ **那一格本身**要做成 `<a href="<AppLink>">`：她的手指点它 = **用户手势** ✓
  //       飞书才放行 AppLink ⇒ 直接弹摄像头 ✓（**点一次弹一次**，无状态、无记号 ✓）
  //    `options.hrefs` = `{ 模块名: 链接 }`（**只给要变成链接的那几格**）；
  //    ⚠️ **不给 hrefs 时行为逐字不变**（仍是 5 颗 button）⇒ 既有面板机制与既有测试一行不用改 ✓
  const hrefs = options.hrefs || {};
  const linkIndex = tabs.findIndex((tab) => hrefs[tab.module]);
  return tabs
    .map((tab, index) => {
      const href = hrefs[tab.module];
      // 「当前可见的面板」= 第一格**不是链接的** tab（链接格点一下就跳走了，不是面板 ✓）
      const activeIndex = linkIndex === 0 ? tabs.findIndex((item, i) => i > 0 && !hrefs[item.module]) : 0;
      const active = index === activeIndex ? ' active' : '';
      if (href) {
        return `<a class="main-tab${active}" data-module="${tab.module}" href="${href}" rel="noopener">${tab.label}</a>`;
      }
      return `<button class="main-tab${active}" type="button" data-module="${tab.module}">${tab.label}</button>`;
    })
    .join('');
}
