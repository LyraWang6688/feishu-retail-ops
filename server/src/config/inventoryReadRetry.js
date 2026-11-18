'use strict';

/**
 * 2026-11-18：库存关键读的瞬时重试。
 *
 * 飞书 Base 在文档级串行处理时会返回 1254607 Data not ready；
 * 网关默认读重试只有 2 次（300ms 起），库存整表/流水读经常不够。
 * 这里与配品销售读源同节奏：最多 6 次、1s 起、2 倍、封顶 15s。
 */
const INVENTORY_READ_RETRY = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 15000,
});

module.exports = { INVENTORY_READ_RETRY };
