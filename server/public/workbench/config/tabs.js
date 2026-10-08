/**
 * 工作台**一级 tab** 的清单（`module` id · 文案 · 顺序）——
 * ⭐ **配置先行：改 tab 名字 / 加减 tab 只改这一个文件**，`index.html` 与 `main.js` 都不写死文案。
 *
 * ⭐ 业务负责人 2026-10-08（逐字）：
 *   「目前我们分了**三个 tab 页**：销售查询、库存查询还有常用功能。现在需要你**整合成两个 tab 页**：
 *    **1. 信息录入**：实际上就是"常用功能"，把那个 tab 页的名字改一下就行
 *    **2. 信息查询**：整合已有的两个 tab 页，放到同一个 tab 页里的**两个板块**，即"销售查询"和"库存查询"」
 *
 * ⚠️ **`module` id 保持既有机制**（对应 `main.js` 的 `modules` 表 + index.html 的 `data-module`）：
 *    · `common` —— 原「常用功能」的模块，**只改显示文案为「信息录入」**，模块 id 不动
 *      （独立页 `common.html` 靠 `data-view="common"` 注册，改 id 会连带改一堆老链接）。
 *    · `query` —— 新增「信息查询」模块（两张飞书多维表格外链卡，见 `config/query.js`）。
 *
 * 顺序 = 渲染顺序 = **默认打开的 tab 是第一条**（她的编号 ① 是「信息录入」）。
 */
export const MAIN_TABS = [
  { module: 'common', label: '信息录入' },
  { module: 'query', label: '信息查询' },
];
