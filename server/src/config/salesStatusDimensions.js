// 「销售主表」四个状态维度的字段映射与取值规则（配置先行）。
//
// 背景（业务负责人 2026-10-06）：她在生产「销售主表」新建了四个字段，
// 并把**旧的**「确认状态」改名为「确认状态（旧）」（选项和历史值都还在，只是改了名）。
//   · 「确认状态」← **用户**在消息卡片上的操作（本次新建，现在全是空的）
//   · 「销售状态」← **货**（= 销售明细）
//   · 「资金状态」← **钱**（= 收款明细）⚠️ 它是**文本字段**（type=1），不是单选
//   · 「库存状态」← **库存流水 ＋ 实时库存**
//
// ⚠️ 这正是当时的故障来源：代码按**字段名**找字段，代码读「确认状态」，
//    而这个名字现在指向**新建的那个空字段** → 6 处闸门 `!== '已入账'` 全读到空 → 全关闸。
//    所以这一层把「**新字段优先、为空则退回旧字段**」的取值规则集中到配置里，
//    调用点只换「取值来源」，判据与文案一个字都不改。
//
// ⭐ 这一层**只做取值，不做任何业务判断**：
//    「是不是账做完了」这个判据由调用点用 `isPosted(postedOf(...))` 表达
//    （判据本体也在本文件里：POSTED_VALUES —— 两代字面量）。
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

// 四个新字段的真实名字。**改字段名只改这里**。
const SALES_STATUS_FIELDS = Object.freeze({
  userAction: '确认状态',
  sales: '销售状态',
  funds: '资金状态',
  stock: '库存状态',
});

// 旧字段（本次只改名、没删）：新字段为空时退回读它们。
// ⚠️ 「确认状态（旧）」现在由 v1BitableSchema 的 `confirmStatus` 指过来——
//    「写」那一路（larkMvpService / salesOrderService / afterSalesService）因此不用改。
const LEGACY_SALES_STATUS_FIELDS = Object.freeze({
  legacyConfirm: '确认状态（旧）',
  legacyOrder: '订单状态',
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
  stock: Object.freeze(['未扣减', '部分扣减', '已扣减', '扣减失败']),
});

// ⭐⭐「账做完了没有」= **两代字面量都算做完**（裁决 2026-10-06 明确）。
//   · 旧代：76 条历史单子把「已入账」写在**「确认状态（旧）」**里；
//   · 新代：从这次起，代码把**「已写入」**写在**「资金状态」**里。
// 🔴 只认其中一代，就会重演 2026-10-06 那次「闸门静默全关」：
//    新单资金状态写「已写入」，而判据若是 `=== '已入账'` → `'已写入' !== '已入账'` → 闸门立刻关。
// ⚠️ 6 处闸门**一律**写 `isPosted(postedOf(...))`，**不许再各自散落字面量**。
// ⚠️ 这里 trim：单元格里多一个空格是同一个事实，不能因此把闸门关掉
//    （这正是本次事故的失败形状：判据读不到"它认识的那个字符串"就静默关闸）。
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
    none: '未扣减', partial: '部分扣减', done: '已扣减', failed: '扣减失败',
  }),
});

// 「空」= 取不到、空串、或只有空白。⚠️ 用 trim 判断是为了**多读一层兜底**：
// 旧字段今天是有值的，新字段哪怕是几个空格也不能把它挡在外面。
const isBlank = (value) => textOf(value).trim() === '';

// 在调用方给的「语义键 → 字段名」映射里找一个能用的名字（通常是
// gateway.table('salesEntry').fields）；找不到就用本文件里的字段名。
const pickFieldName = (table, keys = [], fallback = '') => {
  for (const key of keys) {
    const name = table?.[key];
    if (typeof name === 'string' && name) return name;
  }
  return fallback;
};

// 取值：按 `primary` 链取第一个非空值，全空再按 `legacy` 链取。
// ⚠️ 返回的是**原始值**（不做任何判据），调用点自己比。
const readStatus = (entry, table, { primary = [], legacy = [] } = {}) => {
  const names = [
    ...primary.map(([key, fallback]) => pickFieldName(table, [key], fallback)),
    ...legacy.map(([key, fallback]) => pickFieldName(table, [key], fallback)),
  ];
  for (const name of names) {
    const value = textOf(entry?.fields?.[name]);
    if (!isBlank(value)) return value;
  }
  return '';
};

/**
 * 「账入完了没有」的取值来源：**先读「资金状态」，为空退回「确认状态（旧）」**。
 *
 * ⚠️ 刻意**返回取值本身、不返回布尔**：判据（`!== '已入账'`）留在调用点，
 *    这样「新字段空 → 退回旧字段」时与今天**逐字等价**，将来换了判据也只改调用点。
 *
 * @param {object} entry 销售主表记录（飞书记录对象，取值走 entry.fields）
 * @param {object} [table] 可选：语义键 → 字段名 的映射（gateway.table('salesEntry').fields）
 * @returns {string} 「资金状态」或「确认状态（旧）」的值；都没有则空串
 */
const postedOf = (entry, table) => readStatus(entry, table, {
  primary: [['funds', SALES_STATUS_FIELDS.funds]],
  legacy: [
    ['legacyConfirm', LEGACY_SALES_STATUS_FIELDS.legacyConfirm],
    // 兼容直接把 schema 的 fields 传进来的场景（schema 里旧字段挂在 confirmStatus 上）。
    ['confirmStatus', LEGACY_SALES_STATUS_FIELDS.legacyConfirm],
  ],
});

/** 「用户在消息卡片上的操作」：先读新「确认状态」，为空退回「确认状态（旧）」。 */
const userActionOf = (entry, table) => readStatus(entry, table, {
  primary: [['userAction', SALES_STATUS_FIELDS.userAction]],
  legacy: [
    ['legacyConfirm', LEGACY_SALES_STATUS_FIELDS.legacyConfirm],
    ['confirmStatus', LEGACY_SALES_STATUS_FIELDS.legacyConfirm],
  ],
});

/** 「货」的状态：先读「销售状态」，为空退回旧的「订单状态」。 */
const salesStatusOf = (entry, table) => readStatus(entry, table, {
  primary: [['sales', SALES_STATUS_FIELDS.sales]],
  legacy: [
    ['legacyOrder', LEGACY_SALES_STATUS_FIELDS.legacyOrder],
    ['orderStatus', LEGACY_SALES_STATUS_FIELDS.legacyOrder],
  ],
});

/**
 * 「库存」的状态：先读「库存状态」。
 *
 * ⚠️ 这一维**今天没有旧字段可退回**（「库存状态」是本次新加的列），
 *    所以链条只有一段；将来若要退回哪一列，往 legacy 里加一条即可。
 */
const stockStatusOf = (entry, table) => readStatus(entry, table, {
  primary: [['stock', SALES_STATUS_FIELDS.stock]],
  legacy: [],
});

module.exports = {
  SALES_STATUS_FIELDS,
  LEGACY_SALES_STATUS_FIELDS,
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
