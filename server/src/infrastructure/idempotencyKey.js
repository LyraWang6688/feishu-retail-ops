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

/** 幂等键那一个列名（没配就当场抛）：批量与逐条**必须**用同一处解析 ✓。 */
const keyFieldNameOf = (gateway, tableKey, keyField) => {
  const table = gateway.table(tableKey);
  const fieldName = table.fields?.[keyField];
  if (!fieldName) {
    throw new Error(`“${table.tableName}”未在 v1BitableSchema 声明 ${keyField} 字段，无法核对幂等键`);
  }
  return fieldName;
};

const listByKey = async ({ gateway, tableKey, keyField, keyValue }) => {
  const fieldName = keyFieldNameOf(gateway, tableKey, keyField);
  const records = await gateway.listAll(tableKey);
  return records.filter((record) => keyOf(record, fieldName) === keyValue);
};

/** 一次整表读 ⇒ `幂等键 → [记录…]` 的索引（批量回查用；逐条回查与它读的是**同一张表** ✓）。 */
const indexByKey = (records, fieldName) => {
  const index = new Map();
  for (const record of records || []) {
    const key = keyOf(record, fieldName);
    if (!key) continue;
    const bucket = index.get(key) || [];
    bucket.push(record);
    index.set(key, bucket);
  }
  return index;
};

/**
 * ⭐⭐ 2026-10-16（采购写入提速 · 业务负责人当天点名「**补货和验收两个都需要**」）：
 * **一批多行 = 一次幂等回查 + 一次批量创建**。
 *
 * 为什么要有它（真账）：补货那条链的明细是**逐条** `createOnceByKey` 建的，而它每条都要
 * **一次整表读**（`listByKey` → `gateway.listAll`，飞书单次 RT 实测 8~11 秒）＋ **一次 create**
 * ⇒ 5 条明细 = 5 次整表读 + 5 次 create。同一批次的多行明细是**同一次提交的一部分**，
 * 没有任何理由一条一条敲。
 *
 * 🔴 **语义与「逐条 `createOnceByKey`」逐条一致**（这是硬要求，别在这里"顺手优化"）：
 *   · 回查是**一次**整表读（`options.records` 给了快照就**一次都不读** —— 调用方与
 *     "明细取号"共用同一次读时传它 ✓）；
 *   · 空 `rows` ⇒ **零请求**；
 *   · 同一把键在远端命中 **>1** 条 ⇒ 抛**同一条** `duplicateError`
 *     （文案 / `duplicateBusinessFact` 标记都与逐条路径逐字相同 ✓）；
 *   · 命中 **1** 条 ⇒ 复用（`reused: true`，**整段 values 都不重发** ⇒ 值不变、不累加 ✓）；
 *   · 只对"确实没有的"那些行创建；返回与入参**同序**的 `[{ recordId, reused }]`；
 *   · 🔴 **飞书结构化拒绝**（`bitableRejected`，例如字段不存在）⇒ 原样抛（可以确定没写）；
 *   · ⚠️ **其余失败**（超时 / 连接重置 / 5xx，写入结果未知）⇒ **不重发批量 create**，
 *     回落**逐条 `createOnceByKey`** —— 它自己会先按幂等键回查再决定建不建 ⇒
 *     已经写进去的那几条被命中复用、没写的补上，**绝不会重复建行**，
 *     而且错误语义（含"结果未知 ⇒ 停下来请人工核对"）与改动前**逐字相同** ✓。
 *
 * 参数：
 *   · `rows` = `[{ keyValue, values, label? }]`（`keyValue` 空 ⇒ 当场抛，与逐条同一条错）；
 *   · `label` = 批量级的说明（每条自己的 `label` 优先，用于"采购申请 t:3"这种逐条可读的错）；
 *   · `records` = 调用方**已经读过**的那一份快照（省掉这次整表读）。
 */
const createBatchOnceByKey = async ({
  gateway,
  tableKey,
  keyField = IDEMPOTENCY_KEY_FIELD,
  rows = [],
  label,
  attempts = 3,
  pause = 400,
  correlation,
  records,
}) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const fieldName = keyFieldNameOf(gateway, tableKey, keyField);
  // "批次级说明"：调用方没给就用**第一条自己的**说明兜底（没有再用表键，绝不现编中文 ✗）。
  const groupLabel = label || list[0]?.label || tableKey;
  for (const row of list) {
    if (!row?.keyValue) throw new Error(`${row?.label || groupLabel} 缺少幂等键，拒绝创建`);
  }
  const labelOf = (row) => row?.label || groupLabel;

  /** 逐条回落：**与改动前的写法一字不差**（先回查、再决定建不建；未知结果由它自己处置）✓ */
  const createOneByOne = async (items) => {
    const out = [];
    for (const row of items) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await createOnceByKey({
        gateway, tableKey, keyField, keyValue: row.keyValue, values: row.values,
        label: labelOf(row), attempts, pause, correlation,
      }));
    }
    return out;
  };

  const snapshot = Array.isArray(records) ? records : await gateway.listAll(tableKey);
  const index = indexByKey(snapshot, fieldName);
  const results = new Array(list.length);
  const pending = [];
  list.forEach((row, position) => {
    const matches = index.get(row.keyValue) || [];
    if (matches.length > 1) throw duplicateError(labelOf(row), row.keyValue, matches.length);
    if (matches.length === 1) {
      logInfo('idempotency.reused', { table_key: tableKey, key: row.keyValue, record_id: matches[0].record_id });
      results[position] = { recordId: matches[0].record_id, reused: true };
      return;
    }
    pending.push({ position, row });
  });
  if (!pending.length) return results;
  // 网关没有批量口（既有用例里的替身）⇒ 逐条：**与改动前逐字同形** ✓
  if (typeof gateway.createBatch !== 'function') {
    const created = await createOneByOne(pending.map((entry) => entry.row));
    pending.forEach((entry, i) => { results[entry.position] = created[i]; });
    return results;
  }

  try {
    const created = await gateway.createBatch(tableKey, pending.map((entry) => entry.row.values), { correlation });
    if (!Array.isArray(created) || created.length !== pending.length) {
      // 网关自己保证同序同长（`createBatch` 的契约）；走到这里说明契约被破坏了。
      // ⚠️ 措辞用**英文键**表述 ⇒ 不引入新的硬编码中文（与 `batch_create_count_mismatch` 同一取舍）✓
      throw new Error(`batch_create_count_mismatch: expected ${pending.length}, got ${created?.length}`);
    }
    pending.forEach((entry, i) => { results[entry.position] = { recordId: created[i].recordId, reused: false }; });
    return results;
  } catch (error) {
    // 飞书结构化拒绝 ⇒ 可以确定没写，原样抛（保留可诊断的信息）
    if (error?.bitableRejected) throw error;
    logWarn('idempotency.batch_unknown_outcome', {
      table_key: tableKey,
      keys: pending.map((entry) => entry.row.keyValue),
      label: groupLabel,
      error: error.message,
      fallback: 'one_by_one',
    });
    // 写入结果未知 ⇒ **不重发批量**；回落逐条（它自己会先回查 ⇒ 已写进去的复用、没写的补上）
    const created = await createOneByOne(pending.map((entry) => entry.row));
    pending.forEach((entry, i) => { results[entry.position] = created[i]; });
    return results;
  }
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
  // 关联键（task_id / order_no / sales_entry_record_id）：**只进 gateway 的写入日志**，
  // 不改这里的任何判断。不传 = 行为逐字不变（见 utils/correlationFields）。
  correlation,
}) => {
  if (!keyValue) throw new Error(`${label} 缺少幂等键，拒绝创建`);
  let matches = await listByKey({ gateway, tableKey, keyField, keyValue });
  if (matches.length > 1) throw duplicateError(label, keyValue, matches.length);
  if (matches.length === 1) {
    logInfo('idempotency.reused', { table_key: tableKey, key: keyValue, record_id: matches[0].record_id });
    return { recordId: matches[0].record_id, reused: true };
  }

  try {
    const created = await gateway.create(tableKey, values, { correlation });
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
//
// tables 要给出每张表**各自**的键字段语义名：采购用 idempotencyKey，
// 实时库存用 operationItemKey，不能假定所有表都叫同一个名字。
const validateIdempotencyKeyFields = async ({ gateway, tables = [] }) => {
  if (typeof gateway.listFields !== 'function') return [];
  const checked = [];
  for (const { tableKey, keyField } of tables) {
    const table = gateway.table(tableKey);
    const fieldName = table.fields?.[keyField];
    if (!fieldName) throw new Error(`“${table.tableName}”未在 v1BitableSchema 声明 ${keyField} 字段`);
    const fields = await gateway.listFields(tableKey);
    const field = fields.find((item) => item.field_name === fieldName);
    if (!field) {
      throw new Error(
        `“${table.tableName}”缺少「${fieldName}」字段：幂等写入依赖它（采购 / 库存 / 售后都会用到），` +
        '请先在多维表格新增该文本字段',
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
  createBatchOnceByKey,
  listByKey,
  indexByKey,
  validateIdempotencyKeyFields,
};
