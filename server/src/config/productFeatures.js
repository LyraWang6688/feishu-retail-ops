'use strict';

/**
 * 「产品特点配置」三个标签字典表。
 * 表结构统一：只有「标签」文本列 + 创建/更新时间（自动）。
 *
 * ⚠️ 表 ID 允许用环境变量覆盖；默认值是当前生产表，避免额外部署配置。
 */
const tableIdOf = (envKey, fallback) => String(process.env[envKey] || fallback).trim();

const PRODUCT_FEATURE_DIMENSIONS = Object.freeze([
  Object.freeze({
    key: 'audience',
    label: '主推人群',
    tableName: '主推人群标签',
    tableId: tableIdOf('FEISHU_V1_PRODUCT_AUDIENCE_TABLE_ID', 'tbloFxwZa5q504t2'),
  }),
  Object.freeze({
    key: 'sellingPoint',
    label: '核心卖点',
    tableName: '核心卖点标签',
    tableId: tableIdOf('FEISHU_V1_PRODUCT_SELLING_POINT_TABLE_ID', 'tblEqYe3j5a5Nc9R'),
  }),
  Object.freeze({
    key: 'scene',
    label: '主推场景',
    tableName: '主推场景标签',
    tableId: tableIdOf('FEISHU_V1_PRODUCT_SCENE_TABLE_ID', 'tblsqR83PySHsIZU'),
  }),
]);

const PRODUCT_FEATURE_TAG_FIELD = '标签';

module.exports = { PRODUCT_FEATURE_DIMENSIONS, PRODUCT_FEATURE_TAG_FIELD };
