'use strict';

/**
 * ⭐⭐ 2026-10-16 `routes/scanPage.js` 拆分（阶段二 · 纯搬运 ✓）：**横切小件**。
 *   本轮先落 `asList`（后续层：send／respond 系列 · openIdOf · 埋点 · isDataNotReady ✓）。
 */

const asList = (value) => {
  if (Array.isArray(value)) return value.map((item) => (item === undefined || item === null ? '' : item));
  if (value === undefined || value === null) return [];
  return [value];
};

module.exports = { asList };
