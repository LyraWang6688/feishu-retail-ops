'use strict';

/**
 * 库存页成本（2026-11-27）—— 单独一件，避免把 scanPageService 继续撑大。
 * 只做一件事：按货品 record_id 从货品配置缓存里读「成本」并格式化成 ¥ 文案。
 * ⚠️ 调用方必须先按权限判断；本模块不做授权。
 */
const { getConfigRows } = require('./configTableCache');
const { textValue } = require('./v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SCAN_PAGE } = require('../config/scanPage');
const { asAmount, formatPrice } = require('./scanPagePrice');

const readField = (schema, tableKey, record, semanticKey) => {
  const table = schema.tables?.[tableKey] || {};
  const fieldName = table.fields?.[semanticKey] || '';
  return fieldName ? record?.fields?.[fieldName] : undefined;
};

const costTextOf = async ({
  gateway,
  productRecordId,
  schema = V1_BITABLE_SCHEMA,
  config = SCAN_PAGE,
} = {}) => {
  const id = String(productRecordId || '').trim();
  if (!id) return '';
  const products = await getConfigRows({ gateway, tableKey: 'product' });
  const product = (products || []).find((row) => row.record_id === id);
  if (!product) return '';
  const amount = asAmount(readField(schema, 'product', product, 'cost'));
  return amount === null || amount === undefined ? '' : formatPrice(amount, config);
};

module.exports = { costTextOf };
