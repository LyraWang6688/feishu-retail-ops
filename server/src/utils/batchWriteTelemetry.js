'use strict';
const { randomUUID } = require('node:crypto');
const { logInfo, logError } = require('./logger');
const { correlationFields } = require('./correlationFields');
const { larkErrorFields } = require('./larkError');
const { BATCH_WRITE_EVENTS } = require('../config/batchWriteTelemetry');

// Observation only: no retries, readbacks, or changes to API arguments/results.
const createBatchWriteTelemetry = ({ tableKey, tableId, operation, total, chunkSize,
  correlation, now = Date.now }) => {
  const batchId = randomUUID();
  const startedAt = now();
  let confirmed = 0;
  const events = BATCH_WRITE_EVENTS[operation];
  return {
    start(offset, requested) {
      const chunkStartedAt = now();
      const base = { table_key: tableKey, table_id: tableId, operation,
        batch_id: batchId, total_count: total, batch_count: Math.ceil(total / chunkSize),
        batch_index: Math.floor(offset / chunkSize) + 1, chunk_offset: offset,
        requested, ...correlationFields(correlation) };
      logInfo('bitable.record.batch_started', base);
      const timing = () => ({ duration_ms: Math.max(0, now() - chunkStartedAt),
        total_duration_ms: Math.max(0, now() - startedAt) });
      return {
        context: base,
        success(returned) {
          confirmed += returned;
          logInfo(events.success, { ...base, ...timing(),
            count: returned, returned, confirmed_count: confirmed,
            batch_complete: confirmed === total, outcome: 'confirmed' });
        },
        failure(error) {
          const details = larkErrorFields(error);
          const partial = Array.isArray(error?.bitableDeletedRecordIds) ? error.bitableDeletedRecordIds.length : 0;
          logError(events.failure, { ...base, ...timing(),
            count: requested, returned: error?.bitableReturnedCount,
            confirmed_count: confirmed + partial, partial_confirmed_count: partial, batch_complete: false,
            outcome: error?.bitableRejected === true ? 'rejected' : 'unknown',
            error_code: error?.bitableCode ?? details.code, log_id: details.log_id,
            method_id: details.method_id, error: error?.message || String(error) });
        },
      };
    },
  };
};
module.exports = { createBatchWriteTelemetry };
