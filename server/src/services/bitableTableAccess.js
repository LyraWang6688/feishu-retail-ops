'use strict';

/**
 * 不在 V1 schema 里的小字典表：按 table_id 只读/新增。
 * 写仍然走 `V1BitableGateway.scheduledWrite`，不绕开飞书写调度器。
 */
const { correlationFields } = require('../utils/correlationFields');

const assertTableId = (tableId) => {
  const id = String(tableId || '').trim();
  if (!id) throw new Error('table_id is required');
  return id;
};

const listRecordsInTable = async (gateway, tableId) => {
  const id = assertTableId(tableId);
  const records = [];
  let pageToken;
  do {
    const response = await gateway.client.bitable.appTableRecord.list({
      path: { app_token: gateway.schema.appToken, table_id: id },
      params: { page_size: 500, page_token: pageToken },
    });
    gateway.assertSuccess(response, `listRecordsInTable failed: ${id}`);
    records.push(...(response.data?.items || []));
    pageToken = response.data?.has_more ? response.data?.page_token : undefined;
  } while (pageToken);
  return records;
};

const createRecordInTable = async (gateway, tableId, fields, options = {}) => {
  const id = assertTableId(tableId);
  const correlation = correlationFields(options.correlation);
  const payload = { ...(fields || {}) };
  const response = await gateway.scheduledWrite(options.tableName || id, 'create', async () => {
    const result = await gateway.client.bitable.appTableRecord.create({
      path: { app_token: gateway.schema.appToken, table_id: id },
      data: { fields: payload },
    });
    gateway.assertSuccess(result, `createRecordInTable failed: ${id}`);
    return result;
  }, { correlation });
  return {
    recordId: response?.data?.record?.record_id || response?.data?.record_id || '',
    record: response?.data?.record,
  };
};

const updateRecordInTable = async (gateway, tableId, recordId, fields, options = {}) => {
  const id = assertTableId(tableId);
  const rid = String(recordId || '').trim();
  if (!rid) throw new Error('record_id is required');
  const correlation = correlationFields(options.correlation);
  const payload = { ...(fields || {}) };
  const response = await gateway.scheduledWrite(options.tableName || id, 'update', async () => {
    const result = await gateway.client.bitable.appTableRecord.update({
      path: { app_token: gateway.schema.appToken, table_id: id, record_id: rid },
      data: { fields: payload },
    });
    gateway.assertSuccess(result, `updateRecordInTable failed: ${id}`);
    return result;
  }, { correlation });
  return { recordId: rid, record: response?.data?.record };
};

const deleteRecordInTable = async (gateway, tableId, recordId, options = {}) => {
  const id = assertTableId(tableId);
  const rid = String(recordId || '').trim();
  if (!rid) throw new Error('record_id is required');
  const correlation = correlationFields(options.correlation);
  const response = await gateway.scheduledWrite(options.tableName || id, 'delete', async () => {
    const result = await gateway.client.bitable.appTableRecord.delete({
      path: { app_token: gateway.schema.appToken, table_id: id, record_id: rid },
    });
    gateway.assertSuccess(result, `deleteRecordInTable failed: ${id}`);
    return result;
  }, { correlation });
  return { recordId: rid, deleted: Boolean(response?.data?.deleted) };
};

module.exports = { listRecordsInTable, createRecordInTable, updateRecordInTable, deleteRecordInTable };
