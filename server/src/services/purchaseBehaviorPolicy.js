'use strict';

/** 采购行为记录的编码（稳定标识；中文名可变）。 */
const REPORT_BEHAVIOR = Object.freeze({
  PURCHASE_REQUEST: 'purchase_request',
  PURCHASE_RETURN: 'purchase_return',
});

module.exports = { REPORT_BEHAVIOR };
