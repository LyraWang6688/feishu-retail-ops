const lark = require('@larksuiteoapi/node-sdk');
const fs = require('node:fs');
const path = require('node:path');
const { V1_BITABLE_SCHEMA, getV1Table } = require('../config/v1BitableSchema');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { logError, logInfo } = require('../utils/logger');

const compact = (value) => {
  const result = {};
  Object.entries(value || {}).forEach(([key, item]) => {
    if (item !== undefined) result[key] = item;
  });
  return result;
};

const recordIdOf = (response) => response?.data?.record?.record_id || response?.data?.record_id || '';

const textValue = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};

const linkedRecordIds = (value) => {
  if (Array.isArray(value)) return value.flatMap(linkedRecordIds);
  if (typeof value === 'string') return value ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  // Feishu's record GET returns link cells as [{ record_ids: ['rec...'], text: '...' }].
  // Other endpoints return link_record_ids or direct { id } objects.
  const nested = [value.record_ids, value.link_record_ids].filter(Array.isArray);
  if (nested.length) return nested.flatMap(linkedRecordIds);
  const id = value.record_id || value.recordId || value.id;
  return id ? [id] : [];
};

class V1BitableGateway {
  constructor(options = {}) {
    this.schema = options.schema || V1_BITABLE_SCHEMA;
    if (options.client) this.client = options.client;
    else {
      const { appId, appSecret } = getLarkAgentCredentials();
      this.client = new lark.Client({ appId, appSecret });
    }
    this.fieldCache = new Map();
  }

  table(tableKey) {
    return this.schema.tables?.[tableKey] || getV1Table(tableKey);
  }

  async listFields(tableKey, options = {}) {
    const table = this.table(tableKey);
    if (!table.tableId) throw new Error(`“${table.tableName}”未配置 table_id，请设置对应的 FEISHU_V1_*_TABLE_ID`);
    if (!options.refresh && this.fieldCache.has(tableKey)) return this.fieldCache.get(tableKey);

    const fields = [];
    let pageToken;
    do {
      const response = await this.client.bitable.appTableField.list({
        path: { app_token: this.schema.appToken, table_id: table.tableId },
        params: { page_size: 200, page_token: pageToken },
      });
      this.assertSuccess(response, `读取“${table.tableName}”字段`);
      fields.push(...(response.data?.items || []));
      pageToken = response.data?.has_more ? response.data?.page_token : undefined;
    } while (pageToken);

    this.fieldCache.set(tableKey, fields);
    return fields;
  }

  async validateTable(tableKey) {
    const table = this.table(tableKey);
    const actual = await this.listFields(tableKey, { refresh: true });
    const actualNames = new Set(actual.map((field) => field.field_name));
    const missing = Object.values(table.fields).filter((name) => !actualNames.has(name));
    if (missing.length) {
      throw new Error(`“${table.tableName}”缺少 V1 字段: ${missing.join('、')}`);
    }
    return { tableKey, tableId: table.tableId, fieldCount: actual.length };
  }

  async validateTables(tableKeys) {
    const results = [];
    for (const key of tableKeys) results.push(await this.validateTable(key));
    return results;
  }

  fields(tableKey, semanticValues) {
    const table = this.table(tableKey);
    const out = {};
    Object.entries(semanticValues || {}).forEach(([semanticKey, value]) => {
      const fieldName = table.fields[semanticKey];
      if (!fieldName) throw new Error(`“${table.tableName}”未配置语义字段: ${semanticKey}`);
      if (value !== undefined) out[fieldName] = value;
    });
    return out;
  }

  async create(tableKey, semanticValues) {
    const table = this.table(tableKey);
    const startedAt = Date.now();
    try {
      const response = await this.client.bitable.appTableRecord.create({
        path: { app_token: this.schema.appToken, table_id: table.tableId },
        data: { fields: compact(this.fields(tableKey, semanticValues)) },
      });
      this.assertSuccess(response, `新增“${table.tableName}”记录`);
      const recordId = recordIdOf(response);
      if (!recordId) throw new Error(`新增“${table.tableName}”成功但未返回 record_id`);
      logInfo('bitable.record.created', {
        table_key: tableKey,
        table_id: table.tableId,
        record_id: recordId,
        duration_ms: Date.now() - startedAt,
      });
      return { recordId, record: response.data?.record };
    } catch (error) {
      logError('bitable.record.create_failed', {
        table_key: tableKey,
        table_id: table.tableId,
        duration_ms: Date.now() - startedAt,
        error: error.message,
      });
      throw error;
    }
  }

  async update(tableKey, recordId, semanticValues) {
    const table = this.table(tableKey);
    const startedAt = Date.now();
    try {
      const response = await this.client.bitable.appTableRecord.update({
        path: { app_token: this.schema.appToken, table_id: table.tableId, record_id: recordId },
        data: { fields: compact(this.fields(tableKey, semanticValues)) },
      });
      this.assertSuccess(response, `更新“${table.tableName}”记录`);
      logInfo('bitable.record.updated', {
        table_key: tableKey,
        table_id: table.tableId,
        record_id: recordId,
        duration_ms: Date.now() - startedAt,
      });
      return response.data?.record || { record_id: recordId };
    } catch (error) {
      logError('bitable.record.update_failed', {
        table_key: tableKey,
        table_id: table.tableId,
        record_id: recordId,
        duration_ms: Date.now() - startedAt,
        error: error.message,
      });
      throw error;
    }
  }

  async get(tableKey, recordId) {
    const table = this.table(tableKey);
    const response = await this.client.bitable.appTableRecord.get({
      path: { app_token: this.schema.appToken, table_id: table.tableId, record_id: recordId },
    });
    this.assertSuccess(response, `读取“${table.tableName}”记录`);
    return response.data?.record;
  }

  async delete(tableKey, recordId) {
    const table = this.table(tableKey);
    const response = await this.client.bitable.appTableRecord.delete({
      path: { app_token: this.schema.appToken, table_id: table.tableId, record_id: recordId },
    });
    this.assertSuccess(response, `删除“${table.tableName}”记录`);
    return true;
  }

  async listAll(tableKey) {
    const table = this.table(tableKey);
    const records = [];
    let pageToken;
    do {
      const response = await this.client.bitable.appTableRecord.list({
        path: { app_token: this.schema.appToken, table_id: table.tableId },
        params: { page_size: 500, page_token: pageToken },
      });
      this.assertSuccess(response, `读取“${table.tableName}”记录列表`);
      records.push(...(response.data?.items || []));
      pageToken = response.data?.has_more ? response.data?.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async findOneByText(tableKey, semanticKey, expected) {
    const fieldName = this.table(tableKey).fields[semanticKey];
    if (!fieldName) throw new Error(`未配置查询字段: ${tableKey}.${semanticKey}`);
    const target = String(expected ?? '').trim();
    const records = await this.listAll(tableKey);
    return records.find((record) => textValue(record.fields?.[fieldName]).trim() === target) || null;
  }

  async uploadAttachment(filePath) {
    const stat = await fs.promises.stat(filePath);
    const response = await this.client.drive.media.uploadAll({
      data: {
        file_name: path.basename(filePath),
        parent_type: 'bitable_image',
        parent_node: this.schema.appToken,
        size: stat.size,
        file: fs.createReadStream(filePath),
      },
    });
    if (typeof response?.code === 'number') this.assertSuccess(response, '上传采购原始图片');
    const token = response?.file_token || response?.data?.file_token || response?.data?.data?.file_token;
    if (!token) throw new Error('上传采购原始图片成功但未返回 file_token');
    return token;
  }

  assertSuccess(response, operation) {
    if (!response || response.code !== 0) {
      throw new Error(`${operation}失败: ${response?.msg || 'unknown'} (Code: ${response?.code ?? 'unknown'})`);
    }
  }
}

module.exports = {
  V1BitableGateway,
  compact,
  linkedRecordIds,
  recordIdOf,
  textValue,
};
