'use strict';
/**
 * 2026-10-28：业务负责人在「销售明细」新增公式列「库存数量」，
 * 采购页「补货」以 `库存数量 = 0` 为筛选条件。
 * 这里只钉住 schema 映射与生产真表字段名一致；不读写任何 Base。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

test('销售明细.库存数量：schema 映射存在且字段名逐字正确', () => {
  assert.equal(
    V1_BITABLE_SCHEMA.tables.salesDetail.fields.stockQuantity,
    '库存数量',
    '采购补货依赖「库存数量」公式列，字段名漂移会静默筛错',
  );
});
