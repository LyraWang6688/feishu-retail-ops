'use strict';

/**
 * 「货品资料」页（配置 tab）的配置：
 *   · 搜索/完善的数据都来自「货品信息」配置表（configTableCache，record_changed 会失效）；
 *   · 缺失分类按「商品信息缺失」字段的**实际值**动态去重，不在代码里写死分类；
 *   · 只有分组字段 / 排除值 / 数量上限这些规则可配。
 */
const { readInt, readString } = require('./envValue');

const PRODUCT_PROFILE = Object.freeze({
  // 与 v1BitableSchema.product.fields.completeness 同一字段名；这里显式登记，避免路由里写中文。
  missingField: readString(process.env, 'PRODUCT_PROFILE_MISSING_FIELD', '商品信息缺失').trim() || '商品信息缺失',
  tagMissingField: readString(process.env, 'PRODUCT_PROFILE_TAG_MISSING_FIELD', '标签信息缺失').trim() || '标签信息缺失',
  // 这个值表示资料已齐备，不进入「货品完善」。
  completeValue: readString(process.env, 'PRODUCT_PROFILE_COMPLETE_VALUE', '齐备').trim() || '齐备',
  // ⭐ 2026-11-20：货品下架卡片只认这个状态值（生产单选项：在售 / 下架）。
  delistedStatus: readString(process.env, 'PRODUCT_PROFILE_DELISTED_STATUS', '下架').trim() || '下架',
  // ⭐ 2026-11-17：缺失项的**给用户看的标签**（与工作台货品资料页的缺失 chips 同一套文案）。
  //   扫码页「资料不齐」链接、货品资料页的 chips 都从这里取，避免两处各写一份。
  issueSample: readString(process.env, 'PRODUCT_PROFILE_ISSUE_SAMPLE', '缺样例图').trim() || '缺样例图',
  issueProduct: readString(process.env, 'PRODUCT_PROFILE_ISSUE_PRODUCT', '缺商品信息：{value}').trim() || '缺商品信息：{value}',
  issueTag: readString(process.env, 'PRODUCT_PROFILE_ISSUE_TAG', '缺标签：{value}').trim() || '缺标签：{value}',
  issueSeparator: readString(process.env, 'PRODUCT_PROFILE_ISSUE_SEPARATOR', '；').trim() || '；',
  // 搜索一次最多返回多少条（模糊匹配后截断；避免 559 条全塞给页面）。
  searchLimit: readInt(process.env, 'PRODUCT_PROFILE_SEARCH_LIMIT', 50, { min: 1, max: 200 }),
  // 「货品下架」默认展示全部；上限防一次把几千条塞给页面。
  delistedLimit: readInt(process.env, 'PRODUCT_PROFILE_DELISTED_LIMIT', 2000, { min: 1, max: 10000 }),
  // 搜索专用快照 TTL：不跟 record_changed 失效，避免样例图同步把缓存打穿。
  completionDimensions: Object.freeze([
    Object.freeze({ key: 'sample', label: '样例图' }),
    Object.freeze({ key: 'product', label: '商品信息缺失' }),
    Object.freeze({ key: 'tag', label: '标签信息缺失' }),
  ]),
  completionLimit: readInt(process.env, 'PRODUCT_PROFILE_COMPLETION_LIMIT', 1000, { min: 1, max: 5000 }),
  searchSnapshotTtlMs: readInt(process.env, 'PRODUCT_PROFILE_SEARCH_SNAPSHOT_TTL_MS', 5 * 60 * 1000, {
    min: 60 * 1000, max: 60 * 60 * 1000,
  }),
  // ⭐ #1204：样例图缩略图 —— 记录 file_token 的短 TTL 缓存（一张图一次飞书读 → 一次读服务多张）。
  sampleImageCacheTtlMs: readInt(process.env, 'PRODUCT_SAMPLE_IMAGE_CACHE_TTL_MS', 10 * 60 * 1000, {
    min: 0, max: 60 * 60 * 1000,
  }),
  sampleImageCacheMax: readInt(process.env, 'PRODUCT_SAMPLE_IMAGE_CACHE_MAX', 500, { min: 1, max: 5000 }),
  // ⭐ #1204：连续 1254607/限流 ⇒ 短路一段时间（503 + Retry-After），不再逐张打飞书。
  accessoryUploadOperation: '上传配品样例图',
  accessoryDownloadOperation: '下载配品样例图',
  sampleImageBreaker: Object.freeze({
    failures: readInt(process.env, 'PRODUCT_SAMPLE_IMAGE_BREAKER_FAILURES', 5, { min: 1, max: 100 }),
    windowMs: readInt(process.env, 'PRODUCT_SAMPLE_IMAGE_BREAKER_WINDOW_MS', 60 * 1000, { min: 1000, max: 600000 }),
    cooldownMs: readInt(process.env, 'PRODUCT_SAMPLE_IMAGE_BREAKER_COOLDOWN_MS', 30 * 1000, { min: 1000, max: 600000 }),
  }),
});

module.exports = { PRODUCT_PROFILE };
