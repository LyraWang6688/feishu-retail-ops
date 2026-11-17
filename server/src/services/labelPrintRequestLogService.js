'use strict';

/**
 * 「打印请求 → 飞书『标签打印』表」的写入器 —— **只记录请求，不记录状态**。
 *
 * 业务负责人 2026-11-17 的口径：
 *   · 扫码打印 / 库存调整打印 / 销售录单打印 / 验收录单打印的**请求**要出现在「标签打印」表；
 *   · 同一「打印货号 + 来源」**只保留一行**：搜到就把「申请次数」+1，搜不到就新建（次数=1）；
 *   · 「申请次数」= **打印任务创建次数**，不是物理出纸成功次数；
 *   · 批量打印表单**不参与**（一行可挂多个货号，无法按货号计数；表单记录本身就是批量请求）；
 *   · 一次打印请求**新建打印任务**才写；队列复用（防连点）不重复写。
 *
 * ⚠️ **不能写进表单监听循环**：这张表同时是「批量打印」表单的输入表。
 *   监听端只处理「来源为空 / 批量打印」的记录；本 service 写的记录一律带来源，
 *   所以不会再次触发打印（见 `labelPrintFormIntakeService` 的来源守卫）。
 *
 * ⚠️ **搜索的实现**：`打印货号` 是关联列，飞书 GET filter 对关联列不生效（实测会回整表）
 *   ⇒ 这里读整表后在本地按 record_id + 来源匹配。表小够用；大了再加文本匹配键。
 *
 * ⚠️ **best-effort**：飞书写失败只记 warn，**绝不阻塞/回滚打印**；
 *   队列（`server/data/label_print_jobs`）仍是打印任务的唯一事实源。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { LABEL_PRINT_REQUEST_LOG } = require('../config/labelPrintRequestLog');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { textValue } = require('./v1Gateway/cells');
const { logInfo, logWarn } = require('../utils/logger');

/**
 * 关联字段 cell → record_id 数组。
 * ⚠️ 这里刻意**不只用** `linkedRecordIds`（它只认 record_ids / link_record_ids）：
 *    本表是单向关联（type 18），读回来可能是 `[{id}]` / `[{record_ids}]` / 字符串，
 *    历史形状见 issue #1074。只为了"找到同一货品那一行"，认得出就够，不做全局兼容承诺。
 */
const recordIdsOf = (value) => {
  const ids = [];
  const push = (id) => {
    const text = String(id ?? '').trim();
    if (text) ids.push(text);
  };
  const walk = (item) => {
    if (item === null || item === undefined) return;
    if (typeof item === 'string') return push(item);
    if (Array.isArray(item)) return item.forEach(walk);
    if (Array.isArray(item.record_ids)) return item.record_ids.forEach(walk);
    if (item.recordId) return push(item.recordId);
    if (item.id) return push(item.id);
    return undefined;
  };
  walk(value);
  return [...new Set(ids)];
};

/**
 * @param {object} deps
 * @param {object} deps.gateway 飞书网关（listAll / create / update）
 * @param {object} [deps.config]
 * @param {object} [deps.logger] `{ logInfo, logWarn }`（用例注入）
 */
const createLabelPrintRequestLogService = ({
  gateway,
  config = LABEL_PRINT_REQUEST_LOG,
  logger = { logInfo, logWarn },
} = {}) => {
  if (!gateway) throw new Error('LabelPrintRequestLogService requires gateway');
  const log = {
    info: typeof logger.logInfo === 'function' ? logger.logInfo : logInfo,
    warn: typeof logger.logWarn === 'function' ? logger.logWarn : logWarn,
  };
  // 同一「货品 + 来源」的搜索/建行/加次数串行 —— 两下同时打印不会把次数写丢。
  const lock = new KeyedSerialQueue();

  const tableOf = () => V1_BITABLE_SCHEMA.tables[config.tableKey];

  const existingOf = (records, productRecordId, sourceLabel, productField, sourceField) => {
    const hits = (records || []).filter((row) => {
      const ids = recordIdsOf(row?.fields?.[productField]);
      const source = textValue(row?.fields?.[sourceField]).trim();
      return ids.includes(productRecordId) && source === sourceLabel;
    });
    if (hits.length > 1) {
      log.warn('label_print.request_log.duplicate_rows', {
        product_record_id: productRecordId,
        source_label: sourceLabel,
        rows: hits.length,
        hint: config.texts?.duplicateRowsHint || '',
      });
    }
    return hits[0] || null;
  };

  /**
   * 记录一次**新建**打印任务的请求。返回 `{ ok, action, record_id?, skipped?, reason?, count? }`，**从不抛错**。
   * ⚠️ 表单来源直接跳过：表单记录本身就是这次批量打印的请求。
   */
  const record = async (job) => {
    if (!config.enabled) return { ok: false, skipped: true, reason: 'disabled' };
    if (!job || !job.job_id) return { ok: false, skipped: true, reason: 'missing_job' };
    if (job.source === config.formSource) return { ok: true, skipped: true, reason: 'form_has_own_record' };

    const table = tableOf();
    if (!table || !table.tableId) {
      log.warn('label_print.request_log.skipped', {
        job_id: job.job_id, reason: 'table_not_configured', table_key: config.tableKey,
      });
      return { ok: false, skipped: true, reason: 'table_not_configured' };
    }
    const productField = table.fields?.[config.fields.product];
    const sourceField = table.fields?.[config.fields.source];
    const countField = table.fields?.[config.fields.count];
    if (!productField || !sourceField || !countField) {
      log.warn('label_print.request_log.skipped', {
        job_id: job.job_id,
        reason: 'field_mapping_missing',
        product_field: Boolean(productField),
        source_field: Boolean(sourceField),
        count_field: Boolean(countField),
      });
      return { ok: false, skipped: true, reason: 'field_mapping_missing' };
    }

    const productRecordId = String(job.request?.recordId || '').trim();
    if (!productRecordId) {
      log.warn('label_print.request_log.skipped', {
        job_id: job.job_id, reason: 'missing_product_record_id',
      });
      return { ok: false, skipped: true, reason: 'missing_product_record_id' };
    }
    const sourceLabel = config.sourceLabels[job.source];
    if (!sourceLabel) {
      log.warn('label_print.request_log.skipped', {
        job_id: job.job_id, reason: 'unknown_source', source: job.source || '',
      });
      return { ok: false, skipped: true, reason: 'unknown_source' };
    }

    return lock.run('request-log:' + productRecordId + '|' + sourceLabel, async () => {
      let records;
      try {
        // ⚠️ 这里刻意**不用** configTableCache：本表每次打印都会 create/update，
        //   写完必须失效；缓存反而每次都被打穿。表是「每个货品+来源一行」，不是每次打印一行，
        //   当前规模读整表可接受；真变大再加本地索引。
        records = await gateway.listAll(config.tableKey);
      } catch (error) {
        log.warn('label_print.request_log.failed', {
          job_id: job.job_id,
          action: 'search',
          product_record_id: productRecordId,
          source_label: sourceLabel,
          error: error.message,
        });
        return { ok: false, reason: 'search_failed', error: error.message };
      }

      const existing = existingOf(records, productRecordId, sourceLabel, productField, sourceField);
      if (existing) {
        const recordId = String(existing.record_id || '').trim();
        const current = Number(existing?.fields?.[countField]);
        const from = Number.isFinite(current) && current > 0 ? current : 0;
        const next = from + 1;
        try {
          await gateway.update(config.tableKey, recordId, { [config.fields.count]: next });
          log.info('label_print.request_log.incremented', {
            job_id: job.job_id,
            source: job.source,
            source_label: sourceLabel,
            product_record_id: productRecordId,
            feishu_record_id: recordId,
            count: next,
          });
          return { ok: true, action: 'incremented', record_id: recordId, count: next };
        } catch (error) {
          log.warn('label_print.request_log.failed', {
            job_id: job.job_id,
            action: 'update',
            product_record_id: productRecordId,
            source_label: sourceLabel,
            feishu_record_id: recordId,
            error: error.message,
          });
          return { ok: false, reason: 'update_failed', error: error.message };
        }
      }

      try {
        const created = await gateway.create(config.tableKey, {
          // 飞书「单向关联」type=18 的写入形状：简单数组 ['rec…']（或 { link_record_ids: [...] }）。
          // ⚠️ [{ id }] 和 [{ record_ids }] 都会 LinkFieldConvFail (1254067)；那是「读取」形状，不是写入形状。
          [config.fields.product]: [productRecordId],
          // 单选列写字符串，不包数组。
          [config.fields.source]: sourceLabel,
          [config.fields.count]: 1,
        });
        const recordId = String(created?.recordId || '').trim();
        log.info('label_print.request_log.created', {
          job_id: job.job_id,
          source: job.source,
          source_label: sourceLabel,
          product_record_id: productRecordId,
          feishu_record_id: recordId,
          count: 1,
        });
        return { ok: true, action: 'created', record_id: recordId, count: 1 };
      } catch (error) {
        log.warn('label_print.request_log.failed', {
          job_id: job.job_id,
          action: 'create',
          product_record_id: productRecordId,
          source_label: sourceLabel,
          error: error.message,
        });
        return { ok: false, reason: 'create_failed', error: error.message };
      }
    });
  };

  return { record };
};

module.exports = { createLabelPrintRequestLogService };
