'use strict';

const { PRODUCT_FEATURE_DIMENSIONS, PRODUCT_FEATURE_TAG_FIELD } = require('../config/productFeatures');
const { listRecordsInTable, createRecordInTable } = require('./bitableTableAccess');

const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });
const dimensionOf = (key) => PRODUCT_FEATURE_DIMENSIONS.find((item) => item.key === String(key || '').trim()) || null;
const tagOf = (record) => String(record?.fields?.[PRODUCT_FEATURE_TAG_FIELD] || '').trim();

const listDimension = async (gateway, dimension) => {
  const records = await listRecordsInTable(gateway, dimension.tableId);
  const items = records
    .map((record) => ({ recordId: record.record_id || '', tag: tagOf(record) }))
    .filter((item) => item.tag)
    .sort((left, right) => left.tag.localeCompare(right.tag, 'zh-CN'));
  return { key: dimension.key, label: dimension.label, count: items.length, items };
};

const listProductFeatures = async (gateway) => ({
  dimensions: await Promise.all(PRODUCT_FEATURE_DIMENSIONS.map((dimension) => listDimension(gateway, dimension))),
});

const addProductFeatureTag = async (gateway, key, rawValue) => {
  const dimension = dimensionOf(key);
  if (!dimension) throw userError('未知的产品特点维度');
  const value = String(rawValue || '').trim();
  if (!value) throw userError('标签不能为空');
  if (value.length > 40) throw userError('标签最多 40 个字');
  const existing = await listDimension(gateway, dimension);
  const duplicated = existing.items.some((item) => item.tag.toLowerCase() === value.toLowerCase());
  if (duplicated) throw userError('这个标签已经存在，不要重复添加');
  const created = await createRecordInTable(gateway, dimension.tableId, {
    [PRODUCT_FEATURE_TAG_FIELD]: value,
  }, { tableName: dimension.tableName });
  return {
    dimension: { key: dimension.key, label: dimension.label },
    item: { recordId: created.recordId, tag: value },
  };
};

module.exports = { listProductFeatures, addProductFeatureTag, dimensionOf };
