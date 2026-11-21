'use strict';

/**
 * 「货品是否已下架」的唯一判断入口。
 *
 * 规则：只有复选框明确为 true 才算已下架；空 / false 都算未下架。
 * 公式「货品状态」不参与这个判断（有货/无货只是库存事实）。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { PRODUCT_LIFECYCLE } = require('../config/productLifecycle');

const productFields = () => V1_BITABLE_SCHEMA.tables.product.fields;

const isDelistedFields = (fields = {}) => {
  const field = productFields()[PRODUCT_LIFECYCLE.fields.delisted];
  return Boolean(field && fields?.[field] === true);
};

const isDelistedRecord = (record) => isDelistedFields(record?.fields || {});
const isActiveProduct = (record) => !isDelistedRecord(record);

const filterActiveProducts = (records = []) => (Array.isArray(records) ? records : [])
  .filter((record) => isActiveProduct(record));

/** 按调用场景决定是否排除已下架；未登记的上下文默认不改变行为。 */
const filterActiveProductsFor = (records = [], context = '') => (
  PRODUCT_LIFECYCLE.visibility.exclude.includes(context) ? filterActiveProducts(records) : records
);

module.exports = {
  isDelistedFields,
  isDelistedRecord,
  filterActiveProducts,
  filterActiveProductsFor,
};
