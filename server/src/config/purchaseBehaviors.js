'use strict';

/**
 * 采购环节的行为编码（唯一来源，不写死中文）。
 * 供应主表「发生行为」是单向关联 → 行为管理；验收成功后改为「入库」。
 */
const { readString } = require('./envValue');

const PURCHASE_BEHAVIORS = Object.freeze({
  order: readString(process.env, 'PURCHASE_BEHAVIOR_ORDER_CODE', 'PURCHASE_ORDER'),
  inbound: readString(process.env, 'PURCHASE_BEHAVIOR_INBOUND_CODE', 'PURCHASE_IN'),
  return: readString(process.env, 'PURCHASE_BEHAVIOR_RETURN_CODE', 'PURCHASE_RETURN'),
});

module.exports = { PURCHASE_BEHAVIORS };
