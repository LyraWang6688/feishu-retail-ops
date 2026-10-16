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

/**
 * ⭐⭐ 2026-10-16（业务负责人**逐字**：「**退货也需要批量提速**」）：
 * **批量版**的「先回查幂等键、再创建」—— `createOnceByKey` 的攒批形态。
 *
 * 为什么需要它：`createOnceByKey` 每调一次都要**整表读一次**去认那一把键
 * （`listByKey` → `gateway.listAll`，而 `listAll` 是 **500 条/页的翻页读** ——
 * 表越大请求越多）。采购退货那条链原来**逐尺码**调用 ⇒ N 个尺码 =
 * **N 次整表读 ＋ N 次单条 create**；攒批之后 = **1 次整表读 ＋ 1 次批量 create**。
 *
 * 语义与逐条版**逐条对齐**（硬要求，别在这里"顺手优化"）：
 *   · 每一行的键**必须**在（缺 ⇒ 与逐条版**同一句**报错）；
 *   · 整表**只读一次**，把所有键一次认完；
 *   · 命中 **1** 条 ⇒ 复用（记同一条 `idempotency.reused`）；命中 **>1** 条 ⇒ **抛**
 *     （同一句"重复业务事实"报错 —— 绝不把它当成"已写过"悄悄滑过去）；
 *   · 都不命中 ⇒ **一次** `gateway.createBatch`（分片由网关负责，≤500/请求）；
 *   · 批量口**不存在**（老替身 / 未接线）或**失败** ⇒ 退回**逐条** `createOnceByKey`
 *     —— 它自带"结果未知 ⇒ 读后回查 + 重试"那套语义 ⇒ **不重不漏**，
 *     与改前**逐字一致**（飞书结构化拒绝也照样如实抛）。
 *   · 返回值与入参**同序**（调用方按位置对账）。
 * 🔴 与逐条版**唯一的差别**是"少打几次飞书"：落表内容**一字不差**。
 *
 * ⭐⭐ 2026-10-16 下半场（**补货**那条链 · 业务负责人同一天点名「**补货和验收两个都需要**」）：
 *   补货那条链（`purchaseWebhookService.confirmPurchaseRequest` 的明细那一段）**也是逐条**
 *   `createOnceByKey` ⇒ 同一个 N+1，**复用本函数**（**不另发明第二套批量形态** ✗）。
 *   ⚠️ 它比退货多一个约束：那一段还要给明细**取号**（`采购明细ID = {批次号}-01/02…`），
 *   而取号本身也要**读一次同一张表**。两次读写的是**逐字相同的一份数据** ⇒ 读两遍纯属浪费
 *   （飞书单次整表读实测 8~11 秒）。所以这里加一个**尾部可选**的 `records`：
 *     · 传了 ⇒ 用调用方**已经读过**的那一份快照，**这次一次都不读**（零额外请求 ✓）；
 *     · 不传 ⇒ 与今天**逐字不变**（自己读一次 —— 退货那条链就是这么调的 ✓）。
 */
const createOnceByKeys = async ({
  gateway,
  tableKey,
  keyField = IDEMPOTENCY_KEY_FIELD,
  rows = [],
  label = '',
  correlation,
  // ⭐ 调用方已经读过的那一份快照（与"明细取号"共用同一次整表读时传它）。不传 = 自己读。
  records,
}) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const table = gateway.table(tableKey);
  const fieldName = table.fields?.[keyField];
  if (!fieldName) {
    throw new Error(`“${table.tableName}”未在 v1BitableSchema 声明 ${keyField} 字段，无法核对幂等键`);
  }
  list.forEach((row) => {
    if (!row?.keyValue) throw new Error(`${row?.label || label} 缺少幂等键，拒绝创建`);
  });

  /** 逐条兜底：**完全**回到既有 `createOnceByKey`（每次自己回查、自己处理"结果未知"）。 */
  const createSequentially = async (entries) => {
    const created = new Array(entries.length);
    for (let position = 0; position < entries.length; position += 1) {
      const { row } = entries[position];
      created[position] = await createOnceByKey({
        gateway,
        tableKey,
        keyField,
        keyValue: row.keyValue,
        values: row.values,
        label: row.label || label,
        correlation,
      });
    }
    return created;
  };

  // ⭐ 批量口**不在**（老替身 / 未接线）⇒ **直接逐条**：与改前**逐字一致**
  //    （不多读一次表 —— 那一次白读会让"改前调用次数"失真）。
  if (typeof gateway.createBatch !== 'function') {
    return createSequentially(list.map((row, index) => ({ index, row })));
  }

  // ① 整表**只读一次**：把所有幂等键一次认完（这是"快"的全部来源）。
  //    ⭐ `records` 传了 ⇒ 用调用方那一份快照（补货那条链与"明细取号"共用同一次读 ⇒ 零额外请求）。
  const indexed = new Map();
  for (const record of (Array.isArray(records) ? records : await gateway.listAll(tableKey))) {
    const key = keyOf(record, fieldName);
    if (!key) continue;
    const bucket = indexed.get(key);
    if (bucket) bucket.push(record); else indexed.set(key, [record]);
  }

  // ② 按入参顺序逐行判：重复事实 ⇒ 抛；已写过 ⇒ 复用；没写过 ⇒ 攒起来。
  const results = new Array(list.length);
  const missing = [];
  list.forEach((row, index) => {
    const matches = indexed.get(row.keyValue) || [];
    if (matches.length > 1) throw duplicateError(row.label || label, row.keyValue, matches.length);
    if (matches.length === 1) {
      logInfo('idempotency.reused', {
        table_key: tableKey, key: row.keyValue, record_id: matches[0].record_id,
      });
      results[index] = { recordId: matches[0].record_id, reused: true };
      return;
    }
    missing.push({ index, row });
  });
  if (!missing.length) return results;

  // ③ 一次性建完。
  try {
    const created = await gateway.createBatch(
      tableKey, missing.map((entry) => entry.row.values), { correlation },
    );
    // ⚠️ 条数对不上 ⇒ **绝不当成功**（上面那段注释本来就是这么写的，这里把它做实）：
    //    真网关自己会抛 `batch_create_count_mismatch`；弱替身若"少返几条"，
    //    这里若不拦，会把**空的 recordId** 当成绩落进进度（重放时就找不回那一行了）✗。
    if (!Array.isArray(created) || created.length !== missing.length) {
      throw new Error(`batch_create_count_mismatch: expected ${missing.length}, got ${created?.length}`);
    }
    missing.forEach((entry, position) => {
      results[entry.index] = { recordId: created[position].recordId, reused: false };
    });
    return results;
  } catch (error) {
    // 批量口失败（瞬时故障 / 结构化拒绝 / 条数对不上）⇒ **绝不当成功**：
    // 退回逐条 —— 逐条那套会把"明确拒绝"如实抛、把"结果未知"读后回查（不重不漏）。
    logWarn('idempotency.batch_create_failed', {
      table_key: tableKey, count: missing.length, error: error?.message,
    });
  }
  const retried = await createSequentially(missing);
  missing.forEach((entry, position) => { results[entry.index] = retried[position]; });
  return results;
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
  createOnceByKeys,
  listByKey,
  validateIdempotencyKeyFields,
};
