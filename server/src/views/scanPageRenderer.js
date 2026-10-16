/**
 * 扫码页渲染器（**薄壳**）。
 *
 * ⭐ 2026-10-16（业务负责人点头「可以进行拆分」）：本文件按**块**拆进了
 *   `views/scanPage/*.js`（拼装见 `views/scanPage/index.js`），这里**只做 re-export**。
 *
 * 为什么**保留这个路径**（而不是把 import 全改成新路径）：
 *   它被**路由 / 运维工具 / 73 个判据**按路径引用（`routes/scanPage.js` ·
 *   `routes/workbench.js` · `tools/task61-render-baseline.js` · `test/**` …）——
 *   那些引用关心的是**行为**、不是"文件在哪" ✗；换路径 = 几十处成对迁移 + 一次假红。
 *   薄壳让"零行为变化"这件事**可被逐字节证明**（同一入口、同一导出、同一份实现 ✓）。
 *
 * ⚠️ 这里**没有一行渲染逻辑** —— 改渲染请改 `views/scanPage/` 那边 ✓。
 */
'use strict';

module.exports = require('./scanPage');
