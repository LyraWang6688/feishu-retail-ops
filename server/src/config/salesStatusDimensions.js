// 「销售主表」四个状态维度的字段映射与取值规则（配置先行）。
//
// 背景（业务负责人 2026-10-06）：她在生产「销售主表」新建了四个字段：
//   · 「确认状态」← **用户**在消息卡片上的操作
//   · 「销售状态」← **货**（= 销售明细）
//   · 「资金状态」← **钱**（= 收款明细）⚠️ 它是**文本字段**（type=1），不是单选
//   · 「库存状态」← **库存流水 ＋ 实时库存**
//
// 🔴 同一天她又把**两个旧字段整列删掉**：「确认状态（旧）」与「订单状态」。
//    飞书删字段 = **连值一起删、不可恢复** ⇒ 那两列里的历史值（含 76 条「已入账」）
//    **已经没了**；老单在这四个维度上**为空**。
//    ⇒ 本模块因此**只读新字段**：那两列在真表里已不存在，任何 legacy 回退
//      都只会读到 `undefined`，留着就是自欺（还会让 schema 闸门报「缺少 V1 字段」）。
//
// ⭐ 这一层**只做取值，不做任何业务判断**：
//    「是不是账做完了」这个判据由调用点用 `isPosted(postedOf(...))` 表达
//    （判据本体也在本文件里：POSTED_VALUES）。
//
// ⭐ 值域（SALES_STATUS_VALUE_DOMAINS）已由业务负责人 2026-10-06 **最终拍板**（逐字）。
//    代码要**写**的值在 SALES_STATUS_WRITE_VALUES（同一文件，配置驱动）。
//
// ⚠️ 本模块必须保持**纯函数、零依赖**（config 层不引 service，避免把飞书 SDK
//    拖进任何读配置的地方）。所以下面 textOf 是 v1BitableGateway.textValue 的同义实现，
//    由 salesStatusDimensions.test.js 钉住两者等价。

// 与 services/v1BitableGateway 的 textValue 同义：单选/文本取字符串，多选拼接。
// ⚠️ 刻意**不 trim**：调用点原来的比较（多数没有 trim）要逐字保持等价。
const textOf = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};

// 四个状态字段的真实名字。**改字段名只改这里**。
const SALES_STATUS_FIELDS = Object.freeze({
  userAction: '确认状态',
  sales: '销售状态',
  funds: '资金状态',
  stock: '库存状态',
});

// 值域 —— **业务负责人 2026-10-06 最终拍板，逐字**（「按上面每列各自的说法」）。
// ⚠️ 这四组是**口径**，不是建议：改它们等于改产品定义，必须她点头。
//   · 确认状态 ← **用户**（卡片操作）
//   · 销售状态 / 资金状态 ← 代码写入的进度
//   · 库存状态 ← 库存流水 ＋ 实时库存
// （表里的**选项**由她自己加：测试表随便写，生产表等她加完再写。）
const SALES_STATUS_VALUE_DOMAINS = Object.freeze({
  userAction: Object.freeze(['未确认', '已确认', '已取消', '待修改']),
  sales: Object.freeze(['未写入', '部分写入', '已写入', '写入失败']),
  funds: Object.freeze(['未写入', '已写入', '写入失败']),
  stock: Object.freeze(['未写入', '部分写入', '已写入', '写入失败']),
});

// ⭐⭐「账做完了没有」= 这两个字面量都算做完。
//   · 「已写入」= 代码写在**「资金状态」**里的值（SALES_STATUS_WRITE_VALUES.funds.done）；
//   · 「已入账」= 她嘴里的老说法。⚠️ 那 76 条历史值原本在「确认状态（旧）」里，
//     而那一列已被她删除、**值随之丢失**；保留这个字面量只是为了：
//     万一有人在「资金状态」里手工填了「已入账」，闸门不能因此静默关掉。
// 🔴 只认「已写入」的话，她手工填的「已入账」会让闸门关 → 重演 2026-10-06 那次「闸门静默全关」。
// ⚠️ 6 处闸门**一律**写 `isPosted(postedOf(...))`，**不许再各自散落字面量**。
// ⚠️ 这里 trim：单元格里多一个空格是同一个事实，不能因此把闸门关掉
//    （这正是那次事故的失败形状：判据读不到"它认识的那个字符串"就静默关闸）。
const POSTED_VALUES = Object.freeze(['已入账', '已写入']);
const isPosted = (value) => POSTED_VALUES.includes(textOf(value).trim());

// 代码**写**的值（配置驱动 —— 不许把这些字符串散落到各个 service 里）。
// 每一组都必须落在上面同一维度的值域内（salesStatusDimensions.test.js 钉住这条）。
const SALES_STATUS_WRITE_VALUES = Object.freeze({
  userAction: Object.freeze({
    pending: '未确认', confirmed: '已确认', cancelled: '已取消', toModify: '待修改',
  }),
  sales: Object.freeze({
    none: '未写入', partial: '部分写入', done: '已写入', failed: '写入失败',
  }),
  funds: Object.freeze({
    none: '未写入', done: '已写入', failed: '写入失败',
  }),
  stock: Object.freeze({
    none: '未写入', partial: '部分写入', done: '已写入', failed: '写入失败',
  }),
});

// 「空」= 取不到、空串、或只有空白。
const isBlank = (value) => textOf(value).trim() === '';

// 在调用方给的「语义键 → 字段名」映射里找字段名（通常是
// gateway.table('salesEntry').fields）；找不到就用本文件里的字段名。
const pickFieldName = (table, key, fallback = '') => {
  const name = table?.[key];
  return typeof name === 'string' && name ? name : fallback;
};

// 取值：读**这一个**维度（字段名优先用调用方给的映射，其次用本文件的默认名），
// 取不到或只有空白 → 空串。
// ⚠️ 返回的是**原始值**（不做任何判据），调用点自己比。
const readStatus = (entry, table, key, fallback) => {
  const name = pickFieldName(table, key, fallback);
  const value = textOf(entry?.fields?.[name]);
  return isBlank(value) ? '' : value;
};

/**
 * 「账入完了没有」的取值来源：**只读「资金状态」**。
 *
 * ⚠️ 刻意**返回取值本身、不返回布尔**：判据（`isPosted(...)`）留在调用点，
 *    将来换了判据也只改调用点。
 *
 * @param {object} entry 销售主表记录（飞书记录对象，取值走 entry.fields）
 * @param {object} [table] 可选：语义键 → 字段名 的映射（gateway.table('salesEntry').fields）
 * @returns {string} 「资金状态」的值；空着则空串
 */
const postedOf = (entry, table) =>
  readStatus(entry, table, 'funds', SALES_STATUS_FIELDS.funds);

/** 「用户在消息卡片上的操作」：只读「确认状态」。 */
const userActionOf = (entry, table) =>
  readStatus(entry, table, 'userAction', SALES_STATUS_FIELDS.userAction);

/** 「货」的状态：只读「销售状态」。 */
const salesStatusOf = (entry, table) =>
  readStatus(entry, table, 'sales', SALES_STATUS_FIELDS.sales);

/** 「库存」的状态：只读「库存状态」。 */
const stockStatusOf = (entry, table) =>
  readStatus(entry, table, 'stock', SALES_STATUS_FIELDS.stock);

module.exports = {
  SALES_STATUS_FIELDS,
  SALES_STATUS_VALUE_DOMAINS,
  SALES_STATUS_WRITE_VALUES,
  POSTED_VALUES,
  isPosted,
  postedOf,
  userActionOf,
  salesStatusOf,
  stockStatusOf,
  // 测试钉住「与 gateway.textValue 等价」用
  textOf,
};
