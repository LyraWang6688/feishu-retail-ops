'use strict';

/**
 * 2026-11-18：销售写库时重新读货品记录的读重试。
 *
 * 复用 V1BitableGateway.get(..., { retry }) 的既有读重试，不另写循环。
 * 节奏与配品销售读源一致：最多 6 次、1s 起、2 倍、封顶 15s。
 */
const SALES_PRODUCT_READ_RETRY = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 15000,
});

module.exports = { SALES_PRODUCT_READ_RETRY };
