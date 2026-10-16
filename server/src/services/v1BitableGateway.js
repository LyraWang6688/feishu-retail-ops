const lark = require('@larksuiteoapi/node-sdk');
const fs = require('node:fs');
const path = require('node:path');
const { V1_BITABLE_SCHEMA, getV1Table } = require('../config/v1BitableSchema');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { larkLogger } = require('../utils/larkLogger');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { correlationFields } = require('../utils/correlationFields');

/** 飞书 `records/batch_get` 官方上限：一次最多 **500** 条（超了必须分片）。 */
// 批量读写**每次的条数**：500。依据（curl 官方文档核过，2026-10-12）：
//   · batch_create：「单次调用最多新增 1,000 条记录」（错误码 1254104 RecordAddOnceExceedLimit）；
//   · 接口频率限制 **50 次/秒**；
//   ⇒ 官方上限 1000，我们取 **500**：与既有 `getBatch` 同一把尺子、且给"内容变更较大"的
//     1254002（Fail）留出余量（官方排查建议就是"单次减少数据量"）。
const BATCH_GET_CHUNK_SIZE = 500;

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
  /**
   * ⭐⭐ 2026-10-12（验收提速）：**批量新增** —— 一次请求最多 500 条。
   *
   * 为什么要有它：她真机每批 5 码，逐码"库存 + 流水"要串行敲 10+ 次飞书（每次约 10 秒）
   * ⇒ 单这一刀就 119.5 秒。批量之后 5 行一次 ⇒ **一次请求**。
   *
   * 语义与单条 `create` **逐条一致**（这是硬要求，别在这里"顺手优化"）：
   *   · **空数组 ⇒ 零请求**（返 `[]`，一次飞书都不打）；
   *   · 分片 ≤ `BATCH_GET_CHUNK_SIZE`（500，与 `getBatch` 同一把尺子）；
   *   · 任何一片失败 ⇒ **抛错**（不静默、不返回半截结果）；
   *   · 返回与入参**同序**的 `[{ recordId, record }]`（调用方按位置对账）；
   *   · `options.correlation` **不透明**透传（只进日志，不进 payload）。
   */
  async createBatch(tableKey, rows = [], options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    const table = this.tableWithId(tableKey);
    const correlation = correlationFields(options.correlation);
    const created = [];
    for (let offset = 0; offset < list.length; offset += BATCH_GET_CHUNK_SIZE) {
      const chunk = list.slice(offset, offset + BATCH_GET_CHUNK_SIZE);
      const startedAt = Date.now();
      try {
        const response = await this.client.bitable.appTableRecord.batchCreate({
          path: { app_token: this.schema.appToken, table_id: table.tableId },
          data: { records: chunk.map((values) => ({ fields: compact(this.fields(tableKey, values)) })) },
        });
        // ⚠️ 措辞与单条 create **逐字一致**（白名单里已有 `新增“{}”记录`，不新增硬编码中文）
        this.assertSuccess(response, `新增“${table.tableName}”记录`);
        const records = response.data?.records || [];
        if (records.length !== chunk.length) {
          // ⭐ 先按 `getBatch` 的口径**如实记三个数**（requested / returned / missing），**再抛**：
          //    写库场景宁可不静默（业务负责人 2026-10-12 拍板）—— 半截成功绝不当成功。
          //    ⚠️ 官方文档（curl 核过，2026-10-12）：batch_create 出错是**整体非 0**，
          //      没有 batchGet 那种"部分成功 + forbidden_record_ids"的语义 ⇒ 条数对不上就是异常。
          logWarn('bitable.record.batch_write_mismatch', {
            table_key: tableKey,
            table_id: table.tableId,
            operation: 'create',
            requested: chunk.length,
            returned: records.length,
            missing: Math.max(0, chunk.length - records.length),
            chunk_offset: offset,
            ...correlation,
          });
          // 内部错误（正常不可达）：用**英文键**表述 ⇒ 不引入新的硬编码中文
          throw new Error(`batch_create_count_mismatch: expected ${chunk.length}, got ${records.length}`);
        }
        created.push(...records.map((record) => ({
          recordId: record?.record_id || '', record,
        })));
        logInfo('bitable.record.batch_created', {
          table_key: tableKey,
          table_id: table.tableId,
          count: records.length,
          chunk_offset: offset,
          duration_ms: Date.now() - startedAt,
          ...correlation,
        });
      } catch (error) {
        logError('bitable.record.batch_create_failed', {
          table_key: tableKey,
          table_id: table.tableId,
          count: chunk.length,
          chunk_offset: offset,
          error: error?.message || String(error),
          ...correlation,
        });
        throw error;
      }
    }
    return created;
  }

  /**
   * ⭐⭐ 2026-10-12（验收提速）：**批量更新** —— 一次请求最多 500 条。
   * `patches` = `[{ recordId, values }]`（`values` 是**语义键**，和单条 `update` 一样）。
   * 其余语义（空 ⇒ 零请求 / 分片 / 失败抛错 / 同序返回 / correlation 不透明）与 `createBatch` 完全一致。
   */
  async updateBatch(tableKey, patches = [], options = {}) {
    const list = Array.isArray(patches) ? patches : [];
    if (!list.length) return [];
    const table = this.tableWithId(tableKey);
    const correlation = correlationFields(options.correlation);
    const updated = [];
    for (let offset = 0; offset < list.length; offset += BATCH_GET_CHUNK_SIZE) {
      const chunk = list.slice(offset, offset + BATCH_GET_CHUNK_SIZE);
      const startedAt = Date.now();
      try {
        const response = await this.client.bitable.appTableRecord.batchUpdate({
          path: { app_token: this.schema.appToken, table_id: table.tableId },
          data: {
            records: chunk.map((patch) => ({
              record_id: String(patch?.recordId || '').trim(),
              fields: compact(this.fields(tableKey, patch?.values || {})),
            })),
          },
        });
        // ⚠️ 同上：复用白名单里已有的 `更新“{}”记录` 措辞
        this.assertSuccess(response, `更新“${table.tableName}”记录`);
        const records = response.data?.records || [];
        if (records.length !== chunk.length) {
          // ⭐ 同 createBatch：先记 requested / returned / missing 三个数，再抛
          logWarn('bitable.record.batch_write_mismatch', {
            table_key: tableKey,
            table_id: table.tableId,
            operation: 'update',
            requested: chunk.length,
            returned: records.length,
            missing: Math.max(0, chunk.length - records.length),
            chunk_offset: offset,
            ...correlation,
          });
          throw new Error(`batch_update_count_mismatch: expected ${chunk.length}, got ${records.length}`);
        }
        updated.push(...records.map((record) => ({
          recordId: record?.record_id || '', record,
        })));
        logInfo('bitable.record.batch_updated', {
          table_key: tableKey,
          table_id: table.tableId,
          count: records.length,
          chunk_offset: offset,
          duration_ms: Date.now() - startedAt,
          ...correlation,
        });
      } catch (error) {
        logError('bitable.record.batch_update_failed', {
          table_key: tableKey,
          table_id: table.tableId,
          count: chunk.length,
          chunk_offset: offset,
          error: error?.message || String(error),
          ...correlation,
        });
        throw error;
      }
    }
    return updated;
  }

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

  /**
   * ⭐⭐ 2026-10-12「**销售提交提速（第二刀）**」：按 **已知 record id** 批量读
   * （飞书 `POST /records/batch_get`）。
   *
   * 为什么需要它：本网关原来只有**单条** `get` ⇒「已知 id ⇒ 精确读」= 1 次主表读 + N 次 `get`，
   * 比"1 次整表读"**调用更多** ⇒ 有了批量才有意义（业务负责人 2026-10-12 授权新增）。
   *
   * 口径（逐条都是红线）：
   *   · **`ids` 为空 / 全是空串 ⇒ 不发任何请求**，直接返回 `[]` ✓
   *   · 官方一次最多 **500** 条 ⇒ 自动**分片**（>500 分多次请求）✓
   *   · **部分 id 不存在** ⇒ 返回**实际存在的**那些，日志里如实报"请求 N / 回来 M / 缺 N-M"
   *     + 官方 `forbidden_record_ids` 的条数（**不编、不补空记录**）✓
   *   · **失败 ⇒ 抛错**（`assertSuccess` 往上抛）—— **绝不静默返回空** ✗
   *     （空会被上层当成"这一单没有明细" ⇒ 重复建行 = 钱/货的错）
   *   · `options.correlation` 与其它方法同一条口径：**不透明**地进日志，不改任何请求内容 ✓
   */
  /**
   * ⭐⭐ 2026-10-15（Lead 批准）：按**原始 table_id** 读一条记录 —— 服务**不在 schema 里**的表
   *   （第一个用户：业务负责人新建的「**配品销售**」表 `tblkT1QTUsESni5b` 那类**入口表**）✓
   *
   * 🔴 为什么要有它：本网关其它方法都按**语义键 + `schema.tableId`** 取表 ⇒ 不在 schema 里的表
   *   **没有任何门**；而"绕过网关直连飞书 SDK"会破坏「**全仓只有网关直连飞书**」这条纪律 ✗
   *   ⇒ 加这一个**只读**口，把"读非 schema 表"也收进同一个门里 ✓
   *
   * 口径：
   *   · **只读**（`appTableRecord.get`）；**不提供**对应的写口（要写必须先有 schema 映射 ✗）
   *   · `tableId` 空 / `recordId` 空 ⇒ **当场抛**（不猜、不发请求）✓
   *   · `options.fieldNames` 只取需要的列（与既有的"按需取字段"同一口径 ✓）
   *   · 失败 ⇒ `assertSuccess` 往上抛（**绝不静默返回空** ✗ —— 空会被上层当成"这一行没有值"）
   *   · `options.correlation` 与其它方法同一条口径：**不透明**地进日志 ✓
   *   · `options.reason` 只为排查（例如 `accessory_sale_intake.fallback` ⇒ 一眼看出"事件没带全、回退读表"）✓
   *
   * @returns {Promise<object|null>} 飞书那条 record（形状与 `get` 相同）；读不到 ⇒ `null`
   */
  async getByTableId({
    tableId = '', recordId = '', fieldNames = [], correlation = {}, reason = '',
  } = {}) {
    const wantedTableId = String(tableId || '').trim();
    const wantedRecordId = String(recordId || '').trim();
    if (!wantedTableId) throw new Error('getByTableId 需要 tableId（空表 ID 会打到 .../tables//records）');
    if (!wantedRecordId) throw new Error('getByTableId 需要 recordId');
    const names = (Array.isArray(fieldNames) ? fieldNames : []).filter((name) => String(name || '').trim());
    const response = await this.client.bitable.appTableRecord.get({
      path: { app_token: this.schema.appToken, table_id: wantedTableId, record_id: wantedRecordId },
      ...(names.length ? { params: { field_names: JSON.stringify(names) } } : {}),
    });
    // ⚠️ 读不到（飞书 404 之类）**如实抛** ⇒ 调用方自己决定"当失败还是当没有"（不许在这里吞 ✗）
    this.assertSuccess(response, `按 table_id 读取记录（${reason || 'get_by_table_id'}）`);
    return response.data?.record || null;
  }

  /**
   * ⭐⭐ 2026-10-15（task-19 ⑤ · Lead 裁决「回写默认开」）：按**原始 table_id** 回写**少量配置列** ——
   *   给"不在 schema 里的入口表"（「配品销售」`tblkT1QTUsESnl5b`）写「写入状态 / 失败原因」两列用 ✓
   *
   * 🔴 **为什么它和 `getByTableId` 成对出现**：只读口只能读；而 Lead 2026-10-15 拍板**回写要真的用上**
   *   ⇒ 必须有一个**写**口。⚠️ 它不是"随便哪张表都能写" ✗ —— 调用方由**配置**白名单把关
   *   （`config/accessorySaleIntake.writeBack` 只在配置了那张表与那两个列名时才调它）✓
   * ⚠️ `fieldNames` 由调用方给**飞书列名**；本层不认识业务字段名（与既有口径一致 ✓）
   * ⚠️ 失败 ⇒ `assertSuccess` **如实抛** ⇒ 调用方自己决定"只记日志"（**不许在这里吞** ✗）
   */
  async updateByTableId({
    tableId = '', recordId = '', fields = {}, correlation = {}, reason = '',
  } = {}) {
    const wantedTableId = String(tableId || '').trim();
    const wantedRecordId = String(recordId || '').trim();
    if (!wantedTableId) throw new Error('updateByTableId 需要 tableId（空表 ID 会打到 .../tables//records）');
    if (!wantedRecordId) throw new Error('updateByTableId 需要 recordId');
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('updateByTableId 需要 fields（空对象是白跑一次调用）');
    }
    const response = await this.client.bitable.appTableRecord.update({
      path: { app_token: this.schema.appToken, table_id: wantedTableId, record_id: wantedRecordId },
      data: { fields },
    });
    this.assertSuccess(response, `按 table_id 回写记录（${reason || 'update_by_table_id'}）`);
    return response.data?.record || null;
  }

  async getBatch(tableKey, ids = [], options = {}) {
    const table = this.tableWithId(tableKey);
    const wanted = (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim()).filter(Boolean);
    if (!wanted.length) return [];
    const correlation = correlationFields(options.correlation);
    const records = [];
    for (let offset = 0; offset < wanted.length; offset += BATCH_GET_CHUNK_SIZE) {
      const chunk = wanted.slice(offset, offset + BATCH_GET_CHUNK_SIZE);
      const startedAt = Date.now();
      const response = await this.client.bitable.appTableRecord.batchGet({
        path: { app_token: this.schema.appToken, table_id: table.tableId },
        data: { record_ids: chunk },
      });
      this.assertSuccess(response, `批量读取“${table.tableName}”记录`);
      const got = response.data?.records || [];
      const forbidden = response.data?.forbidden_record_ids;
      records.push(...got);
      logInfo('bitable.record.batch_read', {
        table_key: tableKey,
        table_id: table.tableId,
        requested: chunk.length,
        returned: got.length,
        // ⭐「缺了几条」如实报（官方没给名字就只报数，不猜是哪条）。
        missing: Math.max(0, chunk.length - got.length),
        forbidden: Array.isArray(forbidden) ? forbidden.length : 0,
        chunk_offset: offset,
        duration_ms: Date.now() - startedAt,
        ...correlation,
      });
    }
    return records;
  }

  async delete(tableKey, recordId) {
    const table = this.tableWithId(tableKey);
    const response = await this.client.bitable.appTableRecord.delete({
      path: { app_token: this.schema.appToken, table_id: table.tableId, record_id: recordId },
    });
    this.assertSuccess(response, `删除“${table.tableName}”记录`);
    return true;
  }

  /**
   * ⭐⭐ task-65（2026-10-16 · Lead 授权「给网关加 `deleteBatch`」）：**批量删除** —— 一次请求最多 500 条。
   *
   * 官方（curl 核过，2026-10-16，《删除多条记录》）：
   *   `POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/batch_delete`，
   *   请求体 `{ records: string[] }`（记录 ID 列表），**「单次调用中最多删除 500 条记录」**，
   *   频率限制 **50 次/秒**；响应体 `data.records = [{ deleted, record_id }]`。
   *
   * 为什么要有它（真账）：采购退货扣库存那一段原来**每一双**一次 `delete`
   *   （单货品 3 双 = 3 次、多货品 6 双 = 6 次）⇒ 批量之后整批 **1 次**。
   *
   * 语义与单条 `delete` **逐条一致**（这是硬要求，别在这里"顺手优化"）：
   *   · **空数组 / 全空串 ⇒ 零请求**（返 `[]`，一次飞书都不打）；
   *   · 分片 ≤ `BATCH_GET_CHUNK_SIZE`（500，与 `createBatch` / `getBatch` 同一把尺子）；
   *   · 🔴 **只有请求的每一条都被如实回报 `deleted !== false` 才算这一片成功**；
   *     条数对不上 / 少回 / 明说 `deleted: false` ⇒ **先记 requested/returned/missing 三个数，再抛**
   *     —— **绝不把"部分成功"当全成功**，也**绝不把"全成功"当失败**（成功了就正常返回）；
   *     ⚠️ 抛出的错误上挂 **`bitablePartialDelete` / `bitableDeletedRecordIds`**（官方**如实回报**的
   *     那一份：哪几条真的删掉了）⇒ 调用方据此把"已删"记进本地 journal，续跑才不会把
   *     "已删"当成"不存在"而卡住；**不挂 `bitableRejected`**（那一位的语义是"飞书明确拒绝 ⇒
   *     确定没写入"，部分删除**不成立**）。
   *   · 返回与入参**同序**的 `[{ recordId, deleted }]`（调用方按位置对账）；
   *   · `options.correlation` **不透明**透传（只进日志，不进 payload）。
   *   · 🔴 **单条 `delete` 一行没动**：既有调用方（`executeOperation` 等）行为**逐字不变**
   *     —— 本方法只加能力，不改任何既有调用。
   */
  async deleteBatch(tableKey, ids = [], options = {}) {
    const list = (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim()).filter(Boolean);
    if (!list.length) return [];
    const table = this.tableWithId(tableKey);
    const correlation = correlationFields(options.correlation);
    const deleted = [];
    for (let offset = 0; offset < list.length; offset += BATCH_GET_CHUNK_SIZE) {
      const chunk = list.slice(offset, offset + BATCH_GET_CHUNK_SIZE);
      const startedAt = Date.now();
      try {
        const response = await this.client.bitable.appTableRecord.batchDelete({
          path: { app_token: this.schema.appToken, table_id: table.tableId },
          data: { records: chunk },
        });
        // ⚠️ 措辞与单条 delete **逐字一致**（白名单里已有 `删除“{}”记录`，不新增硬编码中文）
        this.assertSuccess(response, `删除“${table.tableName}”记录`);
        const records = response.data?.records || [];
        const byId = new Map(records.map((record) => [record?.record_id, record]));
        // 官方口径是 `deleted` 布尔；只把**明说 false / 干脆没回**当成失败（不猜、不美化）。
        const missing = chunk.filter((recordId) => !byId.has(recordId));
        const notDeleted = chunk.filter((recordId) => byId.get(recordId)?.deleted === false);
        if (records.length !== chunk.length || missing.length || notDeleted.length) {
          // ⭐ 同 createBatch / updateBatch：先记 requested / returned / missing 三个数，**再抛**
          logWarn('bitable.record.batch_write_mismatch', {
            table_key: tableKey,
            table_id: table.tableId,
            operation: 'delete',
            requested: chunk.length,
            returned: records.length,
            missing: Math.max(0, chunk.length - records.length),
            not_deleted: notDeleted.length,
            chunk_offset: offset,
            ...correlation,
          });
          // 内部错误（正常不可达）：用**英文键**表述 ⇒ 不引入新的硬编码中文
          const mismatch = new Error(`batch_delete_count_mismatch: expected ${chunk.length}, got ${records.length}`
            + (notDeleted.length ? `, not_deleted ${notDeleted.length}` : ''));
          // ⭐ 官方**如实回报的那一份**（哪几条真的删掉了）挂在错误上 —— 先例是 `assertSuccess`
          //    往错误上挂 `bitableRejected` / `bitableCode`。调用方据此把"已删"记进本地 journal；
          //    没有它，续跑（逐双）会把"已经删掉的那几条"当成"不存在"当场抛、要人工核对。
          //    ⚠️ 只认**明说 `deleted: true`** 的：宁可少记（续跑会停下要人工核对），
          //       也绝不把"可能没删"记成"已删"（那会静默少扣库存）。
          mismatch.bitablePartialDelete = true;
          mismatch.bitableDeletedRecordIds = chunk.filter(
            (recordId) => byId.get(recordId)?.deleted === true,
          );
          throw mismatch;
        }
        deleted.push(...chunk.map((recordId) => ({ recordId, deleted: true })));
        logInfo('bitable.record.batch_deleted', {
          table_key: tableKey,
          table_id: table.tableId,
          count: chunk.length,
          chunk_offset: offset,
          duration_ms: Date.now() - startedAt,
          ...correlation,
        });
      } catch (error) {
        logError('bitable.record.batch_delete_failed', {
          table_key: tableKey,
          table_id: table.tableId,
          count: chunk.length,
          chunk_offset: offset,
          error: error?.message || String(error),
          ...correlation,
        });
        throw error;
      }
    }
    return deleted;
  }

  /**
   * 整表读（翻页取完）。
   *
   * `options.fieldNames`（可选）：**只要这些列**（飞书 `field_names`）——
   * ⚠️ 2026-10-12 新增（订单列表提速：562 条的「货品信息」整表全字段读一次要 7.8 秒，
   *    而这一页只用得上「货号 / 颜色」）。不传 ⇒ 行为与以前**逐字一致**（全字段）。
   * ⚠️ 传进来的应当是**飞书列名**（调用方按语义键从 schema 解析），本层不认识业务字段名。
   * 🔴 **必须序列化成 JSON 字符串**：官方《列出记录》文档里 `field_names` 的类型是 **string**，
   *    示例值就是 `["字段1","字段2"]` —— 直接传数组会被飞书拒：
   *    `InvalidFieldNames (Code: 1254024)`（2026-10-12 在测试 Base 上实测踩到过）。
   *
   * ⚠️ 分页是 `page_token` 串行翻页（飞书的游标只能一路往后取）——**这一层不做并行翻页**：
   *    一页 500 条，562 条 = 2 次请求，为它引并发只会让"哪一页丢了"更难查。
   */
  async listAll(tableKey, options = {}) {
    const table = this.tableWithId(tableKey);
    const fieldNames = Array.isArray(options.fieldNames)
      ? options.fieldNames.map((name) => String(name).trim()).filter(Boolean)
      : [];
    const records = [];
    let pageToken;
    do {
      const response = await this.client.bitable.appTableRecord.list({
        path: { app_token: this.schema.appToken, table_id: table.tableId },
        params: {
          page_size: 500,
          page_token: pageToken,
          // ⚠️ 空数组要**整个不带这个参数**（带空 `field_names` 会变成"一列都不要"）；
          //    非空必须 `JSON.stringify`（官方类型是 string，见上面的注释）。
          ...(fieldNames.length ? { field_names: JSON.stringify(fieldNames) } : {}),
        },
      });
      this.assertSuccess(response, `读取“${table.tableName}”记录列表`);
      records.push(...(response.data?.items || []));
      pageToken = response.data?.has_more ? response.data?.page_token : undefined;
    } while (pageToken);
    return records;
  }

  /**
   * ⭐ **按条件读**记录（GET `.../records` 的 `filter` 参数，官方
   * 《记录筛选的开发指南》：`CurrentValue.[字段名]="值"` / `.contains("…")` / `AND(...)` `OR(...)`）
   * —— 只读回需要的那些行，不把整张表拉回来。
   *
   * 为什么新增而不是改 `listAll`：`listAll`（同一个 GET 接口、不带 filter）有**二十多个调用方**，
   * 语义是"整表读"；本方法是"按条件读"。两个方法并存，谁在自己链路上更合适就用谁 ——
   * 改 `listAll` 等于把所有人的行为一起改了。
   *
   * 🔴 为什么是 **GET + filter 公式**，而不是官方更推荐的
   *    `POST .../records/search`（结构化 filter）—— **本机只读实测的硬事实**：
   *    两个接口**返回的记录形状不一样**：
   *      · GET list   ：公式列 → `[{text:"…",type:"text"}]`、数字公式 → `1`、
   *                     关联 → `[{record_ids:[…],text:"…",text_arr:[…]}]`（**带显示文本**）；
   *      · POST search：公式列 → `{type:1,value:[{text:"…"}]}`、数字公式 → `{type:2,value:[1]}`、
   *                     关联 → `{link_record_ids:[…]}`（**没有显示文本**）。
   *    ⇒ 用 search 读，扫码页的 `textValue` / `findProduct` 得跟着改，而且**关联列的显示文本拿不到**
   *      （例：没有库存的货品，「品类」会从「休闲鞋」掉成空）—— 那与"页面内容一个字都不许变"正面冲突。
   *    ⇒ 用 GET + filter 读，返回体与 `listAll` **逐字同形状**，页面口径不可能漂。
   *    ⚠️ 代价（已实测）：GET 的 filter **区分大小写**（`货号="x7601"` 匹配不到 `X7601`），
   *      且它被官方标注为"历史接口" —— 但 `listAll` 本来就走这个接口，没有新增风险面。
   *      大小写不一致的输入（她照标签手打）由调用方**回退整表读**兜住：慢一次，但对。
   *
   * `filter` 是**公式字符串**，由调用方按 schema 的物理列名拼好（本层不认识任何业务字段名）。
   * ⚠️ 值嵌进公式是有语法的 ⇒ 调用方必须先过安全字符检查（本层也会拦：空白公式直接退回整表读）。
   *
   * `options.maxRecords`：**读够这么多行就停**（不再翻页）。默认不限。
   * 调用方按 `上限 + 1` 传，就能一眼看出"是不是超了"（超了明确报错，不静默截断）。
   */
  async listByFilter(tableKey, filter, options = {}) {
    const table = this.tableWithId(tableKey);
    const expression = String(filter ?? '').trim();
    // 没有可用的条件 ⇒ 语义上等价于"整表读"（调用方一般不会走到这里，走到了也不该炸）。
    if (!expression) return this.listAll(tableKey);
    const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0 ? options.maxRecords : 0;
    const requested = Number.isInteger(options.pageSize) && options.pageSize > 0 ? options.pageSize : 500;
    const pageSize = Math.min(requested, 500);
    const records = [];
    let pageToken;
    do {
      const response = await this.client.bitable.appTableRecord.list({
        path: { app_token: this.schema.appToken, table_id: table.tableId },
        params: { page_size: pageSize, page_token: pageToken, filter: expression },
      });
      this.assertSuccess(response, `按条件读取“${table.tableName}”记录`);
      records.push(...(response.data?.items || []));
      pageToken = response.data?.has_more ? response.data?.page_token : undefined;
    } while (pageToken && (!maxRecords || records.length < maxRecords));
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
