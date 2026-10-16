'use strict';

/**
 * ⭐⭐ 2026-10-16（业务负责人点头「可以进行拆分」）：**薄壳** —— 真身在 `./scanPage/index.js` ✓
 *
 * 为什么留壳（**不是**为了好看）：
 *   · **75 个测试文件** + `app.js` 都是 `require('../src/routes/scanPage')` ✗
 *   · ⇒ 留壳 ⇒ 它们**一个字都不用改** ✓（把"改 import 面"这个额外风险降到 0 ✓）
 *   · ⚠️ 这里必须写 **`'./scanPage/index'`**（**不能**写 `'./scanPage'` ✗ ——
 *     那会命中**本文件自己** ⇒ 循环 require ✓）
 *   · `module.exports` **形状原样**：`createScanPageRouter` 等 7 个符号一个不换 ✓
 */
module.exports = require('./scanPage/index');
