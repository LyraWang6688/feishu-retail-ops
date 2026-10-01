const { textValue } = require('../services/v1BitableGateway');
const { logInfo, logWarn } = require('../utils/logger');

// 远端幂等键字段的语义名（中文列名见 v1BitableSchema）。
// 采购批次、采购申请、实时库存的创建都依赖它：只有远端自己记得「这条记录是
// 哪次操作的第几条」，才能在本地记录丢失时判断「已经写过」还是「还没写」。
const IDEMPOTENCY_KEY_FIELD = 'idempotencyKey';
const OPERATION_ITEM_KEY_FIELD = 'operationItemKey';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const keyOf = (record, fieldName) => textValue(record?.fields?.[fieldName]).trim();

const duplicateError = (label, keyValue, count) => {
  const error = new Error(
    `${label} 的幂等键 ${keyValue} 在远端命中 ${count} 条记录，属于重复业务事实，已停止自动处理，请人工核对`,
  );
  // 标记出来，避免在「结果未知」的回查循环里被当成读失败吞掉。
  error.duplicateBusinessFact = true;
  return error;
};

const listByKey = async ({ gateway, tableKey, keyField, keyValue }) => {
  const table = gateway.table(tableKey);
  const fieldName = table.fields?.[keyField];
  if (!fieldName) {
    throw new Error(`“${table.tableName}”未在 v1BitableSchema 声明 ${keyField} 字段，无法核对幂等键`);
  }
  const records = await gateway.listAll(tableKey);
  return records.filter((record) => keyOf(record, fieldName) === keyValue);
};

/**
 * 先按幂等键回查远端，再决定是否创建。
 *
 * 引入它的原因是一个真实存在、本地日志无法覆盖的窗口：
 *   飞书 create 已经成功 → 进程崩溃 / 响应丢失 → 本地不知道已写入 → 用户重试
 * 这种情况下「再创建一次」会写出重复的采购事实，而「直接放弃」会让业务卡住。
 * 唯一的出路是让远端自己有稳定标识，重试前先按标识回查。
 *
 * 返回 { recordId, reused }：reused=true 表示这条记录是上一次已经写好的。
 */
const createOnceByKey = async ({
  gateway,
  tableKey,
  keyField = IDEMPOTENCY_KEY_FIELD,
  keyValue,
  values,
  label,
  attempts = 3,
  pause = 400,
}) => {
  if (!keyValue) throw new Error(`${label} 缺少幂等键，拒绝创建`);
  let matches = await listByKey({ gateway, tableKey, keyField, keyValue });
  if (matches.length > 1) throw duplicateError(label, keyValue, matches.length);
  if (matches.length === 1) {
    logInfo('idempotency.reused', { table_key: tableKey, key: keyValue, record_id: matches[0].record_id });
    return { recordId: matches[0].record_id, reused: true };
  }

  try {
    const created = await gateway.create(tableKey, values);
    return { recordId: created.recordId, reused: false };
  } catch (error) {
    // 飞书结构化拒绝（例如字段不存在）说明请求被处理且明确失败，可以确定没有写入，
    // 直接把原始错误抛出去，保留可诊断的信息。
    if (error?.bitableRejected) throw error;

    // 其余情况（超时、连接重置、5xx）写入结果未知：不再重发 create，
    // 只在 read-after-write 窗口内按幂等键回查。
    logWarn('idempotency.unknown_outcome', { table_key: tableKey, key: keyValue, error: error.message });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        matches = await listByKey({ gateway, tableKey, keyField, keyValue });
        if (matches.length > 1) throw duplicateError(label, keyValue, matches.length);
        if (matches.length === 1) {
          logInfo('idempotency.reconciled_after_unknown', {
            table_key: tableKey, key: keyValue, record_id: matches[0].record_id,
          });
          return { recordId: matches[0].record_id, reused: true };
        }
      } catch (readError) {
        if (readError?.duplicateBusinessFact) throw readError;
        logWarn('idempotency.reconcile_read_failed', { table_key: tableKey, key: keyValue, error: readError.message });
      }
      if (attempt + 1 < attempts) await sleep(pause);
    }
    const unknown = new Error(
      `${label} 的创建结果未知（幂等键 ${keyValue}）：无法确认远端是否已写入，已停止自动创建，请人工核对。` +
      `原始错误：${error.message}`,
    );
    unknown.unknownOutcome = true;
    throw unknown;
  }
};

// 幂等依赖的字段必须真实存在且是文本（type 1）。只校验列名不够：
// 数字或关联字段存不下 "purchase_request:..." 这种键，写进去会静默变成空值。
const validateIdempotencyKeyFields = async ({ gateway, tableKeys = [] }) => {
  if (typeof gateway.listFields !== 'function') return [];
  const checked = [];
  for (const tableKey of tableKeys) {
    const table = gateway.table(tableKey);
    const fieldName = table.fields?.[IDEMPOTENCY_KEY_FIELD];
    if (!fieldName) throw new Error(`“${table.tableName}”未声明幂等键字段`);
    const fields = await gateway.listFields(tableKey);
    const field = fields.find((item) => item.field_name === fieldName);
    if (!field) {
      throw new Error(
        `“${table.tableName}”缺少「${fieldName}」字段：采购与库存的幂等写入依赖它，请先在多维表格新增该文本字段`,
      );
    }
    if (field.type !== 1) throw new Error(`“${table.tableName}”的「${fieldName}」必须是文本字段`);
    checked.push({ tableKey, fieldName });
  }
  return checked;
};

module.exports = {
  IDEMPOTENCY_KEY_FIELD,
  OPERATION_ITEM_KEY_FIELD,
  createOnceByKey,
  listByKey,
  validateIdempotencyKeyFields,
};
