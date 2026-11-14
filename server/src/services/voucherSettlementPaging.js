'use strict';

/**
 * 团购券结算 · 平台账单/提现的**游标分页**（2026-11-14）。
 *
 * 真实缺口：`settleBill` / `settleWithdraw` 每次只回一页（默认 100 条），
 * 原实现只调一次就拿这一页金额去对整天账 —— 超过 100 条时永远对不上（或误判）。
 *
 * 判据：`{ok, records}`。**中途失败 / 游标缺失 / 超过页数上限都算失败** ⇒
 * 调用方不结（宁可晚结，也不拿"只拉了第一页"的金额改收款状态）。
 */
const createSettlementPaging = ({
  logger = { logWarn: () => {} },
  pageSize = 100,
  pageLimit = 50,
} = {}) => {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 100));
  const limit = Math.max(1, Number(pageLimit) || 50);

  return async ({ label, listKey, fetchPage }) => {
    const records = [];
    let cursor = 0;
    for (let page = 0; page < limit; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchPage({ cursor, size });
      if (!result || result.ok !== true) {
        return { ok: false, reason: result?.reason || 'upstream_failed', records };
      }
      const data = result.data || {};
      const chunk = Array.isArray(data[listKey]) ? data[listKey] : [];
      records.push(...chunk);
      if (data.has_more === false) return { ok: true, records };
      if (chunk.length < size) return { ok: true, records };
      const nextCursor = data.cursor;
      const cursorMissing = nextCursor === undefined || nextCursor === null || String(nextCursor) === String(cursor);
      if (cursorMissing) {
        logger.logWarn('voucher.settlement.pagination_unknown', { label, cursor, size, records: records.length });
        return { ok: false, reason: 'pagination_unknown', records };
      }
      cursor = nextCursor;
    }
    logger.logWarn('voucher.settlement.page_limit_reached', { label, pages: limit, records: records.length });
    return { ok: false, reason: 'page_limit_reached', records };
  };
};

module.exports = { createSettlementPaging };
