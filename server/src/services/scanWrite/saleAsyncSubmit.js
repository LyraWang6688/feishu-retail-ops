'use strict';

/**
 * 销售异步提交的共用件（2026-11-18，从资金页 `payment.js` 抽出，行为不变）。
 *
 * 资金页和「货品页 0 元直达」都调它：
 *   资金页：lines = 她填的明细，payments = 她填的收款行
 *   0 元直达：lines = 草稿明细（全 0），payments = []
 *
 * 本件只负责：buildSalePayload → salesAsync.enqueue → completeSale → 打印轻页。
 * 不碰路由、不写页面、不自己判断金额。
 */
const { buildSalePayload } = require('../salesPayload');
const { SOURCES } = require('../../config/labelPrintQueue');
const { getPrintPromptService } = require('../printPromptRuntime');
const { printPromptUrlOf } = require('../printPromptService');
const { submitToastUrl } = require('../../utils/submitToast');
const { logInfo, logWarn, logError } = require('../../utils/logger');
const { ASYNC_JOB_TYPES } = require('../../config/asyncJobs');
const { getStockDelistIntentService } = require('../stockDelistIntentRuntime');

/**
 * 本单涉及的鞋类货品（去重；配品/没有 product_record_id 的不进打印页）。
 * 一行 = 一个货品；同款多尺码只留一行。
 */
const salePrintProductsOf = (lines = [], extra = null) => {
  const map = new Map();
  const add = (line) => {
    const recordId = String(line?.product_record_id || line?.productRecordId || '').trim();
    if (!recordId || line?.kind === 'accessory') return;
    if (map.has(recordId)) return;
    map.set(recordId, {
      recordId,
      itemNo: String(line?.item_no || '').trim(),
      color: String(line?.color || '').trim(),
      number: String(line?.number || '').trim(),
    });
  };
  for (const line of Array.isArray(lines) ? lines : []) add(line);
  if (extra) add(extra);
  return [...map.values()];
};

/**
 * @param {object} input
 * @param {object} input.salesAsync         销售异步 worker（必须有 `enqueue`）
 * @param {object} input.writeService       扫码写服务（用 `sessions.completeSale`）
 * @param {string} input.openId
 * @param {string} input.submitKey
 * @param {string} input.orderNo
 * @param {string} [input.gift]
 * @param {Array}  input.lines              `buildSalePayload` 的行形状
 * @param {Array}  [input.payments]
 * @param {string} [input.tapId]
 * @param {Array}  [input.printProducts]    不传则按 lines 现算
 * @param {string} [input.requestId]
 * @returns {Promise<{ok:boolean,status?:number,code?:string,errors?:Array,jobId?:string,orderNo?:string,printPromptUrl?:string,reused?:boolean,lineCount?:number,paymentCount?:number}>}
 */
const enqueueSaleAsync = async ({
  salesAsync, writeService, openId, submitKey, orderNo, gift = '', accessory = '', accessoryTotalCents = 0,
  lines = [], payments = [], tapId = '', printProducts = null, requestId = '', delistProductIds = [],
} = {}) => {
  if (!salesAsync || typeof salesAsync.enqueue !== 'function') {
    return { ok: false, status: 503, code: 'async_disabled', errors: [] };
  }
  const built = buildSalePayload({ openId, orderNo, gift, accessory, accessoryTotalCents, lines, payments });
  if (!built.ok) {
    logWarn('scan.sale.async.invalid_payload', { request_id: requestId, errors: built.errors });
    return { ok: false, status: 400, code: 'invalid_payload', errors: built.errors };
  }
  const enqueued = await salesAsync.enqueue({
    submitKey: String(submitKey || ''),
    payload: built.payload,
    tapId: String(tapId || ''),
  });
  if (!enqueued.ok) {
    logError('scan.sale.async.enqueue_failed', { request_id: requestId, errors: enqueued.errors });
    return { ok: false, status: 500, code: 'enqueue_failed', errors: enqueued.errors };
  }
  // ⭐ 入队后必须轮换本单的 submit_key（completeSale 会 lines/order_no 归零、seq +1）。
  await writeService.sessions.completeSale(openId, {
    key: String(submitKey || ''),
    result: { job_id: enqueued.job?.job_id, order_no: orderNo },
  });
  const saleJobId = String(enqueued.job?.job_id || '').trim();
  logInfo('scan.sale.async.enqueued', {
    request_id: requestId,
    job_id: saleJobId,
    tap_id: tapId || undefined,
    order_no: orderNo,
    line_count: lines.length,
    payment_count: payments.length,
    reused: enqueued.created === false,
  });
  const delistIds = [...new Set((Array.isArray(delistProductIds) ? delistProductIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean))];
  if (saleJobId && delistIds.length) {
    try {
      await getStockDelistIntentService().request({
        jobId: saleJobId, ownerOpenId: openId,
        productRecordIds: delistIds, expectedType: ASYNC_JOB_TYPES.SALES,
      });
    } catch (error) {
      logWarn('stock.delist.intent.request_failed', {
        job_id: saleJobId, error: String(error?.message || error).slice(0, 300),
      });
    }
  }
  const products = Array.isArray(printProducts) ? printProducts : salePrintProductsOf(lines);
  // 用户选了“全部下架”时，不进入打印页；仍有其他未下架货品时，只打印剩余货品。
  const printableProducts = products.filter((product) => !delistIds.includes(String(product.recordId || '')));
  let printPromptUrl = '';
  if (saleJobId && printableProducts.length) {
    const prompt = getPrintPromptService().create({
      kind: 'sale',
      source: SOURCES.sale,
      operationId: saleJobId,
      ownerOpenId: openId,
      products: printableProducts,
      returnUrl: submitToastUrl({ orderNo }),
    });
    if (prompt) printPromptUrl = printPromptUrlOf(prompt.token);
  }
  return {
    ok: true,
    jobId: saleJobId,
    orderNo,
    printPromptUrl,
    reused: enqueued.created === false,
    lineCount: lines.length,
    paymentCount: payments.length,
  };
};

module.exports = { enqueueSaleAsync, salePrintProductsOf };
