import { MAIN_TABS } from '../config/tabs.js';

/**
 * 一级 tab 的按钮 HTML —— **文案 / 顺序 / `data-module` 全部来自 `config/tabs.js`**（配置先行）。
 *
 * ⚠️ **仍然走既有机制**：`button.main-tab[data-module]` + `main.js` 的 `modules` 表。
 *    这里只把「清单 → 按钮」这一步从写死的 HTML 挪进配置，逻辑没换。
 * ⚠️ **第一条自动带 `active`** —— `main.js` 也按 DOM 里第一个 `.main-tab` 决定默认打开哪个，
 *    两处口径必须一致（本函数就是唯一来源）。
 */
export function mainTabsHtml(tabs = MAIN_TABS) {
  return tabs
    .map((tab, index) => `<button class="main-tab${index === 0 ? ' active' : ''}" type="button" data-module="${tab.module}">${tab.label}</button>`)
    .join('');
}
