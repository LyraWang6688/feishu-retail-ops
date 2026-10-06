// 「销售主表」四个状态维度的**字段映射 + 值域 + 取值**（配置先行）。
//
// 业务负责人 2026-10-06 定的口径（原话）：
//   「你需要负责的是新的 4 个字段，你需要负责思考什么状态需要同步以及选项是什么。
//     我需要知道的是：**用户有没有点击确认按钮，有没有写进销售明细、收款明细、
//     库存流水以及实时库存**～ 我需要知道的是这些状态的达成情况」
//
// ⇒ 四个字段记的是**四个「做没做到」的检查点**，不是业务语义值：
//   · 确认状态 = 用户在卡片上点没点「确认」按钮      → 未确认 / 已确认 / 已取消 / 待修改
//   · 销售状态 = 销售明细写进去了没有                → 未写入 / 部分写入 / 已写入 / 写入失败
//   · 资金状态 = 收款明细写进去了没有                → 未写入 / 已写入 / 写入失败
//   · 库存状态 = 库存流水 ＋ 实时库存写进去了没有    → 未扣减 / 部分扣减 / 已扣减 / 扣减失败
//
// 🔴 刻意**不读旧字段**：没有 legacy 兜底、不双读、不回填。
//    她的口径是「旧的两个字段不用管，代码里也不需要了，schema 可以留着」。
//    ⇒ 旧字段（「确认状态（旧）」/「订单状态」）在 v1BitableSchema 里也不再映射，
//      代码里 grep 不到它们；要让历史单子显示达成情况，只能靠一次性的回填脚本，
//      那**不在本模块的职责里**（本模块只回答"当前这四个字段是什么值"）。
//    ⚠️ 代价要知情：新字段今天基本是空的 ⇒ 6 处闸门（交付 / 补记收款 / 二次交付 /
//      待成交提醒 / 今日销售 / 订单列表）对**历史单子会全部关闭**，直到那些单子
//      被新链路重新写过。这是她明确要的"只看真实达成情况"。
//
// ⚠️ 飞书会**自动新增选项**：往「0 个选项」的单选字段写值会成功、选项自己长出来
//    （2026-10-06 实测：测试表「确认状态」空 → 写成「未确认」→ 选项变成「未确认」）。
//    两个副作用都跟这里有关：
//      ① **写错的值会永久留在选项里** ⇒ 写入前必须过 assertStatusValue 校验，
//         值只能来自本文件的 SALES_STATUS_VALUES，不许在调用点拼字符串；
//      ② **选项的显示顺序 = 第一次写入的顺序** ⇒ 下面每个值域的数组顺序就是
//         建议的写入顺序（先写常见的、正向的，再写异常值）。
//
// ⚠️ 本模块必须保持**纯函数、零依赖**：config 层不引 service，
//    否则任何"只是读个配置"的地方都会被拖进飞书 SDK。

// 与 services/v1BitableGateway 的 textValue 同义：单选/文本取字符串，多选拼接。
// ⚠️ 只做取值，不做任何业务判断（"是不是已写入"这类判据留在调用点）。
const textOf = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};

// 四个字段的真实名字。**改字段名只改这里**（schema 的语义键见下面 DIMENSIONS）。
const SALES_STATUS_FIELDS = Object.freeze({
  userAction: '确认状态',
  sales: '销售状态',
  funds: '资金状态',
  stock: '库存状态',
});

// 维度 → v1BitableSchema.tables.salesEntry.fields 上的**语义键**。
// 写入走语义键（gateway 再翻译成字段名），所以键名就是这四个维度名；
// 集中列在这里是为了让"哪个维度写哪一列"只有一处定义。
const SALES_STATUS_DIMENSIONS = Object.freeze({
  userAction: 'userAction',
  sales: 'sales',
  funds: 'funds',
  stock: 'stock',
});

// 值域（**她还没最终拍板，先按上面口径写；她定了只改这一个文件**）。
const SALES_STATUS_VALUES = Object.freeze({
  // 用户有没有点确认按钮。售后卡片也走"用户点确认"这条路（见 afterSalesService.ensureMaster）。
  userAction: Object.freeze({
    PENDING: '未确认',
    CONFIRMED: '已确认',
    CANCELLED: '已取消',
    TO_MODIFY: '待修改',
  }),
  // 销售明细写进去了没有。
  sales: Object.freeze({
    NONE: '未写入',
    PARTIAL: '部分写入',
    WRITTEN: '已写入',
    FAILED: '写入失败',
  }),
  // 收款明细写进去了没有。
  funds: Object.freeze({
    NONE: '未写入',
    WRITTEN: '已写入',
    FAILED: '写入失败',
  }),
  // 库存流水 ＋ 实时库存写进去了没有（售后是"回补"，用同一套值）。
  stock: Object.freeze({
    NONE: '未扣减',
    PARTIAL: '部分扣减',
    DONE: '已扣减',
    FAILED: '扣减失败',
  }),
});

// 值域的数组形态（顺序 = 建议的写入顺序 = 选项显示顺序；校验与测试都读它）。
const SALES_STATUS_VALUE_DOMAINS = Object.freeze(Object.fromEntries(
  Object.entries(SALES_STATUS_VALUES).map(([dimension, values]) => [dimension, Object.freeze(Object.values(values))]),
));

const dimensionFieldName = (dimension) => {
  const name = SALES_STATUS_FIELDS[dimension];
  if (!name) throw new Error(`未知的销售状态维度：${dimension}`);
  return name;
};

const dimensionSemanticKey = (dimension) => {
  const key = SALES_STATUS_DIMENSIONS[dimension];
  if (!key) throw new Error(`未知的销售状态维度：${dimension}`);
  return key;
};

/**
 * 值必须在值域里——**这是防止"写错的值永久留在飞书选项里"的唯一闸门**。
 * 允许空值/空串（= 还没走到这一步，什么都不写），因为"留空"本身是合法状态。
 */
const assertStatusValue = (dimension, value) => {
  if (value == null || value === '') return '';
  const domain = SALES_STATUS_VALUE_DOMAINS[dimension];
  if (!domain) throw new Error(`未知的销售状态维度：${dimension}`);
  const text = String(value);
  if (!domain.includes(text)) {
    throw new Error(`「${dimensionFieldName(dimension)}」不接受值「${text}」；只能是：${domain.join(' / ')}`);
  }
  return text;
};

/**
 * 组装"写一个维度"的语义键/值对（给 gateway.create / gateway.update 用）。
 *
 * ⚠️ 语义键必须是 schema 里配过的（`v1BitableSchema.tables.salesEntry.fields`），
 *    否则 gateway 会报「未配置语义字段」——这里刻意**不**回退成字段名。
 */
const statusPatch = (dimension, value) => ({ [dimensionSemanticKey(dimension)]: assertStatusValue(dimension, value) });

// 在调用方给的「语义键 → 字段名」映射里找字段名；找不到就用本文件里的字段名。
// 两个来源等价，取调用方的只是为了跟 gateway 的映射保持同一份事实。
const pickFieldName = (table, dimension) => {
  const fromTable = table?.[dimensionSemanticKey(dimension)];
  return typeof fromTable === 'string' && fromTable ? fromTable : dimensionFieldName(dimension);
};

// **单读**：只读这一个维度自己的列，读不到就是空串（没有兜底、没有第二条链）。
const readStatus = (entry, table, dimension) =>
  textOf(entry?.fields?.[pickFieldName(table, dimension)]).trim();

/** 「用户在卡片上的操作」：未确认 / 已确认 / 已取消 / 待修改。 */
const userActionOf = (entry, table) => readStatus(entry, table, 'userAction');

/** 「货」的达成情况：销售明细写进去了没有。 */
const salesStatusOf = (entry, table) => readStatus(entry, table, 'sales');

/** 「钱」的达成情况：收款明细写进去了没有（6 处闸门读它，判据 `!== 已写入`）。 */
const fundsStatusOf = (entry, table) => readStatus(entry, table, 'funds');

/** 「库存」的达成情况：库存流水 ＋ 实时库存写进去了没有。 */
const stockStatusOf = (entry, table) => readStatus(entry, table, 'stock');

module.exports = {
  SALES_STATUS_FIELDS,
  SALES_STATUS_DIMENSIONS,
  SALES_STATUS_VALUES,
  SALES_STATUS_VALUE_DOMAINS,
  dimensionFieldName,
  dimensionSemanticKey,
  assertStatusValue,
  statusPatch,
  userActionOf,
  salesStatusOf,
  fundsStatusOf,
  stockStatusOf,
  // 测试钉住「与 gateway.textValue 等价」用
  textOf,
};
