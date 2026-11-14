'use strict';

/**
 * 「产品特点配置」三个标签字典表。
 * 表结构统一：只有「标签」文本列 + 创建/更新时间（自动）。
 *
 * ⚠️ 表 ID 允许用环境变量覆盖；默认值是当前生产表，避免额外部署配置。
 */
const { readInt } = require('./envValue');

const tableIdOf = (envKey, fallback) => String(process.env[envKey] || fallback).trim();

const PRODUCT_FEATURE_DIMENSIONS = Object.freeze([
  Object.freeze({
    key: 'audience',
    cacheKey: 'productAudience',
    label: '主推人群',
    tableName: '主推人群标签',
    tableId: tableIdOf('FEISHU_V1_PRODUCT_AUDIENCE_TABLE_ID', 'tbloFxwZa5q504t2'),
  }),
  Object.freeze({
    key: 'sellingPoint',
    cacheKey: 'productSellingPoint',
    label: '核心卖点',
    tableName: '核心卖点标签',
    tableId: tableIdOf('FEISHU_V1_PRODUCT_SELLING_POINT_TABLE_ID', 'tblEqYe3j5a5Nc9R'),
  }),
  Object.freeze({
    key: 'scene',
    cacheKey: 'productScene',
    label: '主推场景',
    tableName: '主推场景标签',
    tableId: tableIdOf('FEISHU_V1_PRODUCT_SCENE_TABLE_ID', 'tblsqR83PySHsIZU'),
  }),
]);

const PRODUCT_FEATURE_TAG_FIELD = '标签';
/** 标签长度上限（原来写死在 service；2026-11-14 收口）。 */
const PRODUCT_FEATURE_MAX_TAG_LENGTH = readInt(
  process.env, 'PRODUCT_FEATURE_MAX_TAG_LENGTH', 40, { min: 1, max: 200 },
);
const PRODUCT_FEATURE_USAGE_FIELD = '涉及货品';

module.exports = {
  PRODUCT_FEATURE_DIMENSIONS, PRODUCT_FEATURE_TAG_FIELD, PRODUCT_FEATURE_USAGE_FIELD,
  PRODUCT_FEATURE_MAX_TAG_LENGTH,
};
