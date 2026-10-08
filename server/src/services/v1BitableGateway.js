const lark = require('@larksuiteoapi/node-sdk');
const fs = require('node:fs');
const path = require('node:path');
const { V1_BITABLE_SCHEMA, getV1Table } = require('../config/v1BitableSchema');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { larkLogger } = require('../utils/larkLogger');
const { logError, logInfo } = require('../utils/logger');
const { correlationFields } = require('../utils/correlationFields');

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

// 单选关联的判定：必须且只能关联到这一条记录。多选或指错记录都不能算匹配，
// 否则幂等比对会把「另一条尺码」或「一次关联多个」误当成同一条业务明细。
const singleLinked = (cell, recordId) => {
  const ids = linkedRecordIds(cell);
  return ids.length === 1 && ids[0] === recordId;
};

class V1BitableGateway {
  constructor(options = {}) {
    this.schema = options.schema || V1_BITABLE_SCHEMA;
    if (options.client) this.client = options.client;
    else {
      const { appId, appSecret } = getLarkAgentCredentials();
      this.client = new lark.Client({ appId, appSecret, logger: larkLogger });
    }
    this.fieldCache = new Map();
  }

  table(tableKey) {
    return this.schema.tables?.[tableKey] || getV1Table(tableKey);
  }

  /**
   * 取表配置，并**先确认 table_id 非空**再返回。
   *
   * 为什么要有这一层（2026-10-06 线上事故的加固）：
   * 表 ID 来自 schema 里的 `getEnv('FEISHU_V1_*_TABLE_ID')`，而 schema 是
   * **模块级对象字面量**——require 那一刻求值一次。只要 .env 还没加载
   * （例如 dotenv.config 被排到了业务 require 之后，见 src/app.js 的注释），
   * 没有硬编码兜底的表就会拿到空串并永久冻结。
   *
   * 空 tableId 不被拦下时的后果：请求打到 `.../tables//records`，
   * 飞书回 404 `404 page not found`——**报错里看不出是哪张表没配**，
   * 现象只是"某个功能没反应"，这正是这次事故难查的原因。
   * 所以在这一层当场抛错，把"静默 404"换成"一眼能读懂的配置错误"。
   * （原先只有 listFields 有这个守卫，create / update / get / delete / listAll
   * 都会带着空 ID 直接发请求。）
   */
  tableWithId(tableKey) {
    const table = this.table(tableKey);
    if (!table.tableId) throw new Error(`“${table.tableName}”未配置 table_id，请设置对应的 FEISHU_V1_*_TABLE_ID`);
    return table;
  }

  async listFields(tableKey, options = {}) {
    const table = this.tableWithId(tableKey);
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

  /**
   * 新增一条记录。
   *
   * `options.correlation` 是**不透明的**业务键包（本层不认识里面的名字，只负责原样放进日志）：
   *   · 为什么放在这里：`bitable.record.created` 正是"一条销售被劈成两半"里**看不见的那半**
   *     —— 明细 / 收款 / 库存流水都是从这里写进去的，排查时只能靠时间窗口去接
   *     （2026-10-07 业务负责人拍板「日志改下吧！」）。
   *   · 为什么不是"在业务层补一条重复日志"：那样同一个事实有两条日志、两处会漂移；
   *     而**不透明**地透传不会让网关耦合业务 —— 这一层连"销售"这个词都不认识。
   *   · 为什么不是 AsyncLocalStorage：库存引擎有**跨请求重放**（runForStock /
   *     resumePending），上下文里读到的键会指向**当前**请求，把上一笔单挂到错的任务上。
   *     显式传参没有这个问题。理由详见 utils/correlationFields 与本次的设计文档。
   *
   * 不传 `correlation` 时行为**逐字不变**（只有一个空对象被 spread）。
   */
  async create(tableKey, semanticValues, options = {}) {
    const table = this.tableWithId(tableKey);
    const startedAt = Date.now();
    const correlation = correlationFields(options.correlation);
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
        ...correlation,
      });
      return { recordId, record: response.data?.record };
    } catch (error) {
      logError('bitable.record.create_failed', {
        table_key: tableKey,
        table_id: table.tableId,
        duration_ms: Date.now() - startedAt,
        error: error.message,
        ...correlation,
      });
      throw error;
    }
  }

  /** 更新一条记录；`options.correlation` 同 create（只进日志，不改任何请求内容）。 */
  async update(tableKey, recordId, semanticValues, options = {}) {
    const table = this.tableWithId(tableKey);
    const startedAt = Date.now();
    const correlation = correlationFields(options.correlation);
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
        ...correlation,
      });
      return response.data?.record || { record_id: recordId };
    } catch (error) {
      logError('bitable.record.update_failed', {
        table_key: tableKey,
        table_id: table.tableId,
        record_id: recordId,
        duration_ms: Date.now() - startedAt,
        error: error.message,
        ...correlation,
      });
      throw error;
    }
  }

  async get(tableKey, recordId) {
    const table = this.tableWithId(tableKey);
    const response = await this.client.bitable.appTableRecord.get({
      path: { app_token: this.schema.appToken, table_id: table.tableId, record_id: recordId },
    });
    this.assertSuccess(response, `读取“${table.tableName}”记录`);
    return response.data?.record;
  }

  async delete(tableKey, recordId) {
    const table = this.tableWithId(tableKey);
    const response = await this.client.bitable.appTableRecord.delete({
      path: { app_token: this.schema.appToken, table_id: table.tableId, record_id: recordId },
    });
    this.assertSuccess(response, `删除“${table.tableName}”记录`);
    return true;
  }

  async listAll(tableKey) {
    const table = this.tableWithId(tableKey);
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

  /**
   * 上传一个附件到本 Base 的素材库，拿回 `file_token`（之后用它写附件字段）。
   *
   * `options.parentType`（默认 `bitable_image`）由各链路的 config 决定 —— 官方文档
   * （`drive/v1/medias/upload_all`，原文片段见 `config/tagQrCode.js` 的注释）规定：
   * 多维表格图片 = `bitable_image`、多维表格文件 = `bitable_file`，
   * 两者 `parent_node` 都传**多维表格的 app_token**（本网关自己有，调用方不用管）。
   * `options.operation` 只用于报错文案：**默认值与文案逐字不变**，
   * 所以既有的采购调用方（只传 filePath）行为一个字都没改。
   */
  async uploadAttachment(filePath, options = {}) {
    const stat = await fs.promises.stat(filePath);
    const operation = options.operation || '上传采购原始图片';
    const response = await this.client.drive.media.uploadAll({
      data: {
        file_name: path.basename(filePath),
        parent_type: options.parentType || 'bitable_image',
        parent_node: this.schema.appToken,
        size: stat.size,
        file: fs.createReadStream(filePath),
      },
    });
    if (typeof response?.code === 'number') this.assertSuccess(response, operation);
    const token = response?.file_token || response?.data?.file_token || response?.data?.data?.file_token;
    if (!token) throw new Error(`${operation}成功但未返回 file_token`);
    return token;
  }

  assertSuccess(response, operation) {
    if (!response || response.code !== 0) {
      const error = new Error(`${operation}失败: ${response?.msg || 'unknown'} (Code: ${response?.code ?? 'unknown'})`);
      // response.code 是飞书对请求的结构化应答：请求被处理并明确拒绝，可以确定没有写入。
      // 幂等写入靠这个标记区分「明确失败」和「结果未知」——网络超时、连接重置这类
      // 异常没有该标记，一律按可能已经写入处理。
      error.bitableRejected = true;
      error.bitableCode = response?.code;
      throw error;
    }
  }
}

module.exports = {
  V1BitableGateway,
  compact,
  linkedRecordIds,
  recordIdOf,
  singleLinked,
  textValue,
};
