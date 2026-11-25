'use strict';

/**
 * 货品组「主体策略」唯一配置：
 *   · label：标签打印表里哪一列决定主体；
 *   · scan：哪些扫码领域需要先选具体货品。
 * 业务写操作永远落 productRecordId；group 只用于展示/分流。
 */
const SUBJECT_POLICY = Object.freeze({
  label: Object.freeze({ groupField: 'group', productField: 'product' }),
  scan: Object.freeze({
    productPath: '/r',
    groupPath: '/g',
    pickerRealms: Object.freeze(['sales', 'after_sales', 'purchase_return']),
  }),
});

module.exports = { SUBJECT_POLICY };
