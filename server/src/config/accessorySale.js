'use strict';

/**
 * 自建配品销售的共享口径。
 *
 * ⚠️ 2026-11-24：旧「配品销售 → S交易明细」逐行同步已删除；
 *   direction / status / receiptPrefix 这三个值仍被新链路和销售查询使用，所以搬到本文件。
 */
const ACCESSORY_SALE = Object.freeze({
  direction: '收入',
  status: '已收款',
  receiptPrefix: 'PX',
});

module.exports = { ACCESSORY_SALE };
