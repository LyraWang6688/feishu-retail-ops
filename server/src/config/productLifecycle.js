'use strict';

/**
 * 货品生命周期配置（配置先行）。
 *
 * 生产「货品信息」实际字段：
 *   · 货品状态 = 公式：有货 / 无货（按实时库存记录算，只读）
 *   · 下架     = 复选框：人工明确决定这个款以后不再经营
 *
 * 「货品下架」页只列：货品状态 = 无货 且 下架 = false。
 * 用户点下架时只写「下架 = true」，不删除货品记录。
 */
const { readFlag, readString } = require('./envValue');

const PRODUCT_LIFECYCLE = Object.freeze({
  // 语义键 -> v1BitableSchema.product.fields；service 不写物理字段名。
  fields: Object.freeze({
    delisted: 'delisted',
  }),

  // 货品下架页的候选口径。
  delistPage: Object.freeze({
    stockStatus: readString(process.env, 'PRODUCT_LIFECYCLE_NO_STOCK_STATUS', '无货').trim() || '无货',
    delisted: false,
  }),

  // 下架动作：只写复选框 + 归档样例图，绝不删除记录。
  downlist: Object.freeze({
    setDelisted: true,
    archiveSampleImages: readFlag(process.env, 'PRODUCT_LIFECYCLE_ARCHIVE_SAMPLE_IMAGES', true),
  }),

  // 哪些场景排除 / 哪些场景保留并标注。
  visibility: Object.freeze({
    exclude: Object.freeze([
      'productSearch',
      'productCompletion',
      'salesPicker',
      'purchasePicker',
      'arrivalMatcher',
      'labelPrintList',
    ]),
    annotate: Object.freeze([
      'salesHistory',
      'inventoryLedger',
      'purchaseHistory',
      'afterSales',
      'recordLookup',
    ]),
  }),

  labels: Object.freeze({
    delisted: '已下架',
  }),
});

module.exports = { PRODUCT_LIFECYCLE };
