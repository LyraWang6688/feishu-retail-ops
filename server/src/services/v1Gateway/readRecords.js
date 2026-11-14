'use strict';

/**
 * 多维表格「读」的分页/分片循环（2026-11-14 #48，从 `v1BitableGateway.js` 拆出）。
 *
 * 为什么单独一层：
 *   · 网关方法只留"取 table / 拼参数 / 进出 `readWithRetry`"；
 *   · 翻页（`page_token` 串行）、`batch_get` 的 100 条分片、逐片打点这些**纯循环**搬到这里；
 *   · `assertSuccess` / `logInfo` 由调用方注入（保持网关的错误标记语义，且沿用网关那份 logger 绑定）。
 *
 * ⚠️ 行为逐字保持（含分页大小、分片上限、日志字段），别在搬家的同时"顺手优化"。
 */
/** 飞书 `records/batch_get` 实测 record_ids 上限 **100**（超了 400）。 */
const BATCH_GET_IDS_LIMIT = 100;

/** 整表读：`page_token` 串行翻页（不并行；一页 500 条）。 */
const listAllRecords = async ({
  client, appToken, tableId, tableName, fieldNames = [], assertSuccess,
}) => {
  const records = [];
  let pageToken;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: {
        page_size: 500,
        page_token: pageToken,
        ...(fieldNames.length ? { field_names: JSON.stringify(fieldNames) } : {}),
      },
    });
    assertSuccess(response, `读取“${tableName}”记录列表`);
    records.push(...(response.data?.items || []));
    pageToken = response.data?.has_more ? response.data?.page_token : undefined;
  } while (pageToken);
  return records;
};

/** 按条件读：GET + filter 公式（返回体与 `listAll` 逐字同形状）；`maxRecords` 读够就停。 */
const listByFilterRecords = async ({
  client, appToken, tableId, tableName, expression, pageSize, maxRecords, assertSuccess,
}) => {
  const records = [];
  let pageToken;
  do {
    const response = await client.bitable.appTableRecord.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: pageSize, page_token: pageToken, filter: expression },
    });
    assertSuccess(response, `按条件读取“${tableName}”记录`);
    records.push(...(response.data?.items || []));
    pageToken = response.data?.has_more ? response.data?.page_token : undefined;
  } while (pageToken && (!maxRecords || records.length < maxRecords));
  return records;
};

/** 批量读：按 100 条分片，逐片打 `bitable.record.batch_read`（字段形状与拆分前一致）。 */
const getBatchRecords = async ({
  client, appToken, tableId, tableName, tableKey, wanted, correlation = {}, assertSuccess, logInfo,
}) => {
  const records = [];
  for (let offset = 0; offset < wanted.length; offset += BATCH_GET_IDS_LIMIT) {
    const chunk = wanted.slice(offset, offset + BATCH_GET_IDS_LIMIT);
    const startedAt = Date.now();
    const response = await client.bitable.appTableRecord.batchGet({
      path: { app_token: appToken, table_id: tableId },
      data: { record_ids: chunk },
    });
    assertSuccess(response, `批量读取“${tableName}”记录`);
    const got = response.data?.records || [];
    const forbidden = response.data?.forbidden_record_ids;
    records.push(...got);
    logInfo('bitable.record.batch_read', {
      table_key: tableKey,
      table_id: tableId,
      requested: chunk.length,
      returned: got.length,
      missing: Math.max(0, chunk.length - got.length),
      forbidden: Array.isArray(forbidden) ? forbidden.length : 0,
      chunk_offset: offset,
      duration_ms: Date.now() - startedAt,
      ...correlation,
    });
  }
  return records;
};

module.exports = { BATCH_GET_IDS_LIMIT, listAllRecords, listByFilterRecords, getBatchRecords };
