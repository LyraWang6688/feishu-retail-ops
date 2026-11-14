'use strict';

const {
  PRODUCT_FEATURE_DIMENSIONS, PRODUCT_FEATURE_TAG_FIELD, PRODUCT_FEATURE_USAGE_FIELD,
  PRODUCT_FEATURE_MAX_TAG_LENGTH,
} = require('../config/productFeatures');
const { getConfigRows, invalidateConfigTable } = require('./configTableCache');
const {
  listRecordsInTable, createRecordInTable, updateRecordInTable, deleteRecordInTable,
} = require('./bitableTableAccess');

const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });
const dimensionOf = (key) => PRODUCT_FEATURE_DIMENSIONS.find((item) => item.key === String(key || '').trim()) || null;
const tagOf = (record) => String(record?.fields?.[PRODUCT_FEATURE_TAG_FIELD] || '').trim();
const usageOf = (record) => {
  const value = record?.fields?.[PRODUCT_FEATURE_USAGE_FIELD];
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(number) ? number : 0;
};

const listDimension = async (gateway, dimension) => {
  // 走统一配置表缓存：record_changed 即时失效 + TTL 兜底 + lastGood（2026-11-14 #49）
  const records = await getConfigRows({
    gateway,
    tableKey: dimension.cacheKey,
    loader: () => listRecordsInTable(gateway, dimension.tableId),
  });
  const items = records
    .map((record) => ({ recordId: record.record_id || '', tag: tagOf(record), usage: usageOf(record) }))
    .filter((item) => item.tag)
    .sort((left, right) => (right.usage - left.usage) || left.tag.localeCompare(right.tag, 'zh-CN'));
  return { key: dimension.key, label: dimension.label, count: items.length, items };
};

const listProductFeatures = async (gateway) => ({
  dimensions: await Promise.all(PRODUCT_FEATURE_DIMENSIONS.map((dimension) => listDimension(gateway, dimension))),
});

const normalizeTag = (rawValue) => {
  const value = String(rawValue || '').trim();
  if (!value) throw userError('标签不能为空');
  if (value.length > PRODUCT_FEATURE_MAX_TAG_LENGTH) throw userError(`标签最多 ${PRODUCT_FEATURE_MAX_TAG_LENGTH} 个字`);
  return value;
};

const ensureUnique = (items, value, exceptRecordId = '') => {
  const duplicated = items.some((item) => item.recordId !== exceptRecordId && item.tag.toLowerCase() === value.toLowerCase());
  if (duplicated) throw userError('这个标签已经存在，不要重复添加');
};

const addProductFeatureTag = async (gateway, key, rawValue) => {
  const dimension = dimensionOf(key);
  if (!dimension) throw userError('未知的产品特点维度');
  const value = normalizeTag(rawValue);
  const existing = await listDimension(gateway, dimension);
  ensureUnique(existing.items, value);
  const created = await createRecordInTable(gateway, dimension.tableId, {
    [PRODUCT_FEATURE_TAG_FIELD]: value,
  }, { tableName: dimension.tableName });
  invalidateConfigTable(dimension.cacheKey);
  return {
    dimension: { key: dimension.key, label: dimension.label },
    item: { recordId: created.recordId, tag: value, usage: 0 },
  };
};

const updateProductFeatureTag = async (gateway, key, recordId, rawValue) => {
  const dimension = dimensionOf(key);
  if (!dimension) throw userError('未知的产品特点维度');
  const rid = String(recordId || '').trim();
  if (!rid) throw userError('缺少标签记录 ID');
  const value = normalizeTag(rawValue);
  const existing = await listDimension(gateway, dimension);
  const target = existing.items.find((item) => item.recordId === rid);
  if (!target) throw userError('要修改的标签不存在，请刷新后重试');
  ensureUnique(existing.items, value, rid);
  await updateRecordInTable(gateway, dimension.tableId, rid, {
    [PRODUCT_FEATURE_TAG_FIELD]: value,
  }, { tableName: dimension.tableName });
  invalidateConfigTable(dimension.cacheKey);
  return {
    dimension: { key: dimension.key, label: dimension.label },
    item: { recordId: rid, tag: value, usage: target.usage },
  };
};

const deleteProductFeatureTag = async (gateway, key, recordId) => {
  const dimension = dimensionOf(key);
  if (!dimension) throw userError('未知的产品特点维度');
  const rid = String(recordId || '').trim();
  if (!rid) throw userError('缺少标签记录 ID');
  const existing = await listDimension(gateway, dimension);
  const target = existing.items.find((item) => item.recordId === rid);
  if (!target) throw userError('要删除的标签不存在，请刷新后重试');
  await deleteRecordInTable(gateway, dimension.tableId, rid, { tableName: dimension.tableName });
  invalidateConfigTable(dimension.cacheKey);
  return {
    dimension: { key: dimension.key, label: dimension.label },
    item: target,
  };
};

module.exports = {
  listProductFeatures, addProductFeatureTag, updateProductFeatureTag,
  deleteProductFeatureTag, dimensionOf,
};
