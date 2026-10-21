'use strict';

/**
 * 请求耗时埋点（埋点第 4 刀 · 5 条链路）—— **配置先行**：
 *   只对这里登记的链路打 `perf.request.completed`（含 `duration_ms`、是否超 `slowMs`），
 *   其余请求一条都不多。默认开（纯日志、无行为）；阈值与链路都可配。
 *
 * ⚠️ 这是**HTTP 层**的端到端耗时（含中间件/写库/飞书调用），不是单条 SQL/单次 API 耗时；
 *   要看链路内部细分，后续用 trace_id 把同一请求的日志串起来（下一刀）。
 */
const { readFlag, readInt } = require('./envValue');
const { SCAN_WRITE } = require('./scanWrite');
const { SCAN_PAGE } = require('./scanPage');

const ACTION_CHAINS = Object.freeze({
  [SCAN_WRITE.actions.replenish]: 'scan.replenish',
  [SCAN_WRITE.actions.purchaseReturn]: 'scan.purchase_return',
});

const REQUEST_TIMING = Object.freeze({
  enabled: readFlag(process.env, 'REQUEST_TIMING_ENABLED', true),
  slowMs: readInt(process.env, 'REQUEST_TIMING_SLOW_MS', 1500, { min: 0, max: 600000 }),
  chains: Object.freeze([
    Object.freeze({ name: 'scan.sale.submit', method: 'POST', scanPath: true, action: SCAN_WRITE.actions.submitOrder }),
    Object.freeze({ name: 'scan.sale.payment', method: 'POST', scanPath: true, action: SCAN_PAGE.paymentStep.payAction }),
    Object.freeze({ name: 'orders.list', method: 'GET', path: '/api/workbench/sales/orders' }),
    Object.freeze({ name: 'inventory.adjust', method: 'POST', prefix: '/api/workbench/inventory/adjustments' }),
    Object.freeze({ name: 'label.print.enqueue', method: 'POST', path: '/api/workbench/label-print/jobs' }),
    Object.freeze({ name: 'purchase.arrival.accept', method: 'POST', path: '/api/workbench/purchase/arrivals/accept' }),
    Object.freeze({ name: 'scan.replenish', method: 'POST', scanPath: true, action: SCAN_WRITE.actions.replenish }),
    Object.freeze({ name: 'scan.purchase_return', method: 'POST', scanPath: true, action: SCAN_WRITE.actions.purchaseReturn }),
  ]),
});

/** 这个请求属于哪条登记链路（不在登记表里 ⇒ null = 不打点）。 */
const resolveTimingChain = ({ method = '', path = '', body = {} } = {}) => {
  const verb = String(method || '').toUpperCase();
  const url = String(path || '').split('?')[0];
  for (const chain of REQUEST_TIMING.chains) {
    if (chain.method !== verb) continue;
    if (chain.path && url === chain.path) return chain.name;
    if (chain.prefix && url.startsWith(chain.prefix)) return chain.name;
    if (chain.scanPath && (url.startsWith('/s/') || url.startsWith('/r/'))) {
      const action = String((body && body.action) || '');
      if (action === chain.action) return chain.name;
    }
  }
  return null;
};

module.exports = { REQUEST_TIMING, ACTION_CHAINS, resolveTimingChain };
