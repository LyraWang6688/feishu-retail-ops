'use strict';

/**
 * 「货品资料」页（配置 tab）的配置：
 *   · 搜索/完善的数据都来自「货品信息」配置表（configTableCache，record_changed 会失效）；
 *   · 缺失分类按「缺失信息说明」字段的**实际值**动态去重，不在代码里写死分类；
 *   · 只有分组字段 / 排除值 / 数量上限这些规则可配。
 */
const { readInt, readString } = require('./envValue');

const PRODUCT_PROFILE = Object.freeze({
  // 与 v1BitableSchema.product.fields.completeness 同一字段名；这里显式登记，避免路由里写中文。
  missingField: readString(process.env, 'PRODUCT_PROFILE_MISSING_FIELD', '缺失信息说明').trim() || '缺失信息说明',
  // 这个值表示资料已齐备，不进入「货品完善」。
  completeValue: readString(process.env, 'PRODUCT_PROFILE_COMPLETE_VALUE', '齐备').trim() || '齐备',
  // 搜索一次最多返回多少条（模糊匹配后截断；避免 559 条全塞给页面）。
  searchLimit: readInt(process.env, 'PRODUCT_PROFILE_SEARCH_LIMIT', 50, { min: 1, max: 200 }),
  // 搜索专用快照 TTL：不跟 record_changed 失效，避免样例图同步把缓存打穿。
  searchSnapshotTtlMs: readInt(process.env, 'PRODUCT_PROFILE_SEARCH_SNAPSHOT_TTL_MS', 5 * 60 * 1000, {
    min: 60 * 1000, max: 60 * 60 * 1000,
  }),
});

module.exports = { PRODUCT_PROFILE };
