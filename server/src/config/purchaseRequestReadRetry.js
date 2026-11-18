'use strict';

/**
 * 2026-11-18：采购明细读取的瞬时重试。
 *
 * 采购页补货/报货在写明细前会整表读 purchaseRequest（幂等回查 + 明细 ID 取号）。
 * 飞书 Base 返回 1254607 时，网关默认 2 次 / 300ms 不够，采购 job 会直接失败。
 * 复用同一套节奏：最多 6 次、1s 起、2 倍、封顶 15s。
 */
const PURCHASE_REQUEST_READ_RETRY = Object.freeze({
  maxRetries: 5,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 15000,
});

module.exports = { PURCHASE_REQUEST_READ_RETRY };
