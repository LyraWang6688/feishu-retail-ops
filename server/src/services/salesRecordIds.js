/**
 * ⭐⭐ 销售「明细 ID」与「收款明细 ID」的生成 —— **全仓唯一一处**。
 *
 * 业务负责人 **2026-10-12** 定的格式与用途（原话要点）：
 *   · **销售明细ID** = `{销售单号}-{两位序号}`（例 `XSD-20261012-0001-01`、`…-02`）
 *   · **收款明细ID** = `{销售单号}-收款-{两位序号}`（例 `XSD-20261012-0001-收款-02`）
 *   · 「它们都是写在**明细表**里面的」「主表存的是**销售单号**」
 *   · 「明细 ID 相当于说，**这是这一次的第几双或者第几笔**」
 *
 * 🔴 三条不可动摇的规则：
 *   ① **按「同一个销售单号」内、行的创建顺序**排号（不是按 record_id、也不是按时间倒序）；
 *   ② **绝不重排已有行**：后补的行**接着往下排**（例：一单已有 2 行 ⇒ 第 3 行是 `-03`）；
 *   ③ **号跟着记录走**：那条【未收款】占位行**也占号** —— 它被"收清"时
 *      （`paymentService.collectPendingReceipt`）**记录不变、只改状态** ⇒ 号必须一开始就有，
 *      否则"同一行前半天没号、后半天有号"，她按号对账就断了。
 *
 * ⚠️ **售后单与它的原单共用同一个销售单号**（`afterSalesService` 的既有口径：
 *    「售后沿用原单号，不生成新号」）⇒ 排号时必须把**两张主表上的行一起数**
 *    （`listRowsForEntries` 收的是**主表 id 数组**），否则售后那批行会从 `-01` 重新开始，
 *    和原单撞号。
 *
 * 拿不到主表的「销售单号」（理论上不该发生）⇒ **返回空串**，调用方**不写这一列**并记日志 ——
 * 绝不自己编一个号。
 */
const { linkedRecordIds, textValue } = require('./v1BitableGateway');

// 「收款」这个中缀只在收款明细 ID 里出现（她口径逐字）。
const KIND_MARK = Object.freeze({ detail: '', receipt: '收款' });

const pad = (sequence) => String(sequence).padStart(2, '0');

/** 拼号（纯函数）：`formatId('XSD-…', 'receipt', 2)` ⇒ `XSD-…-收款-02`。 */
const formatId = (orderNo, kind, sequence) => {
  const order = String(orderNo || '').trim();
  if (!order) return '';
  const mark = KIND_MARK[kind] ? `${KIND_MARK[kind]}-` : '';
  return `${order}-${mark}${pad(sequence)}`;
};

/**
 * 建一份"排号状态"：`{ rowCount, ids }`。
 *   · `rowCount` = 这一单**已有的行数**（⚠️ 含**没有号**的存量行 —— 她口径是"第几双"，
 *      存量行没号也照样占着那个位置，不从 01 重来）；
 *   · `ids` = 已有行上**已经占掉的号**（用来兜住"跳号留下的空洞"，绝不让两个号撞车）。
 */
const createState = (rows = [], idField = '') => ({
  rowCount: (rows || []).length,
  ids: idField ? idsOf(rows, idField) : [],
});

/**
 * 从"这一单已有的行/号"里算出下一个号；算完把状态往前推一格（下一行接着排）。
 *
 * 序号 = `max(已有行数, 已有号里最大的那个) + 1`：
 *   · 取"行数"是为了**按创建顺序**排（存量行没号也不算没占位）；
 *   · 取"已有号里最大"是为了**避开跳号留下的空洞**（万一有人手工删过行 ⇒ 不会撞号）；
 *   · 最后再兜一层 `while (ids.has(id))`：撞了就往后挪，**绝不可能**发出重复号。
 *
 * @param {object} input
 * @param {{rowCount:number, ids:string[]}} input.state 排号状态（会被就地推进）
 * @param {string} input.orderNo 销售单号
 * @param {'detail'|'receipt'} input.kind
 * @returns {string} 新号；`orderNo` 为空时返回空串（调用方不写这一列、也不编号）
 */
const nextId = ({ state, orderNo, kind }) => {
  const order = String(orderNo || '').trim();
  if (!order) return '';
  if (!state || typeof state !== 'object' || !Array.isArray(state.ids)) {
    throw new Error('nextId 需要 { rowCount, ids } 形状的排号状态');
  }
  const prefix = `${order}-${KIND_MARK[kind] ? `${KIND_MARK[kind]}-` : ''}`;
  const used = new Set(state.ids.map((id) => String(id || '').trim()).filter(Boolean));
  let max = 0;
  for (const id of used) {
    if (!id.startsWith(prefix)) continue;
    const tail = id.slice(prefix.length);
    if (/^\d{1,4}$/.test(tail)) max = Math.max(max, Number(tail));
  }
  let sequence = Math.max(Number(state.rowCount) || 0, max) + 1;
  let id = formatId(order, kind, sequence);
  while (used.has(id)) {
    sequence += 1;
    id = formatId(order, kind, sequence);
  }
  state.ids.push(id);
  state.rowCount += 1;
  return id;
};

/** 读「这些主表记录上的行」（⚠️ 售后单要与原单一起传进来，见文件头）。 */
const listRowsForEntries = async (gateway, tableKey, entryIds) => {
  const fields = gateway.table(tableKey).fields;
  const wanted = new Set((entryIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  if (!wanted.size) return [];
  const rows = await gateway.listAll(tableKey);
  return (rows || []).filter((row) =>
    linkedRecordIds(row.fields?.[fields.salesEntry]).some((id) => wanted.has(id)));
};

/** 把一批记录上的某个列取成号字符串数组（跳过空值）。 */
const idsOf = (rows, fieldName) => (rows || [])
  .map((row) => textValue(row.fields?.[fieldName]).trim())
  .filter(Boolean);

/** 主表上的「销售单号」（拿不到 ⇒ 空串）。 */
const orderNoOf = async (gateway, salesEntryRecordId) => {
  const entry = await gateway.get('salesEntry', salesEntryRecordId);
  return textValue(entry?.fields?.[gateway.table('salesEntry').fields.orderNo]).trim();
};

/** 「这一单（含售后单）的排号状态」—— 建号前读一次，交给 `nextId` 往下排。 */
const stateFor = async ({ gateway, tableKey, entryIds, idField }) => {
  const rows = await listRowsForEntries(gateway, tableKey, entryIds);
  return { state: createState(rows, idField), rows };
};

module.exports = {
  formatId, nextId, createState, listRowsForEntries, idsOf, orderNoOf, stateFor,
};
