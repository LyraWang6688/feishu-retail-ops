'use strict';
// Stable names shared by the gateway, monitoring, and event catalog.
const BATCH_WRITE_EVENTS = Object.freeze({
  create: Object.freeze({ success: 'bitable.record.batch_created', failure: 'bitable.record.batch_create_failed' }),
  update: Object.freeze({ success: 'bitable.record.batch_updated', failure: 'bitable.record.batch_update_failed' }),
  delete: Object.freeze({ success: 'bitable.record.batch_deleted', failure: 'bitable.record.batch_delete_failed' }),
});
module.exports = { BATCH_WRITE_EVENTS };
