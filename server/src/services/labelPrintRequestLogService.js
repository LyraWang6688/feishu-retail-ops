'use strict';

/**
 * 「打印请求 → 飞书『标签打印』表」的写入器 —— **一个打印任务一行**。
 *
 * 2026-11-20 口径：
 *   · 每次**新建打印任务**都新增一行，只写「打印货号 + 来源」；
 *   · 不查历史、不合并、不累加「申请次数」；
 *   · 补打也是新任务 ⇒ 同样新增一行；
 *   · 队列复用（防连点）不重复写；
 *   · 批量打印表单不参与（表单记录本身就是请求）；
 *   · 「打印日」由飞书默认值填，代码不写。
 *
 * ⚠️ **不能写进表单监听循环**：这张表同时是「批量打印」表单的输入表。
 *   监听端只处理「来源为空 / 批量打印」的记录；本 service 写的记录一律带来源，
 *   所以不会再次触发打印（见 `labelPrintFormIntakeService` 的来源守卫）。
 *
 * ⚠️ **best-effort**：飞书写失败只记 warn，**绝不阻塞/回滚打印**；
 *   队列（`server/data/label_print_jobs`）仍是打印任务的唯一事实源。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { LABEL_PRINT_REQUEST_LOG } = require('../config/labelPrintRequestLog');
const { relation } = require('./v1ReferenceResolver');
const { logInfo, logWarn } = require('../utils/logger');

/**
 * @param {object} deps
 * @param {object} deps.gateway 飞书网关（create）
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

  const tableOf = () => V1_BITABLE_SCHEMA.tables[config.tableKey];

  /**
   * 记录一次**新建**打印任务的请求。返回 `{ ok, action, record_id?, skipped?, reason? }`，**从不抛错**。
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
    if (!productField || !sourceField) {
      log.warn('label_print.request_log.skipped', {
        job_id: job.job_id,
        reason: 'field_mapping_missing',
        product_field: Boolean(productField),
        source_field: Boolean(sourceField),
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

    try {
      const created = await gateway.create(config.tableKey, {
        // 关联字段写入形状的唯一入口 = v1ReferenceResolver.relation。
        [config.fields.product]: relation(productRecordId),
        // 单选列写字符串，不包数组。
        [config.fields.source]: sourceLabel,
      });
      const recordId = String(created?.recordId || '').trim();
      log.info('label_print.request_log.created', {
        job_id: job.job_id,
        source: job.source,
        source_label: sourceLabel,
        product_record_id: productRecordId,
        feishu_record_id: recordId,
      });
      return { ok: true, action: 'created', record_id: recordId };
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
  };

  return { record };
};

module.exports = { createLabelPrintRequestLogService };
