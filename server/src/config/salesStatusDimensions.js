// 「销售主表」写入状态字段的映射与取值规则（配置先行）。
//
// ⭐ 2026-10-18（业务负责人改表，逐字口径）：
//   · 生产「销售主表」已删除四个状态列：确认状态 / 销售状态 / 资金状态 / 库存状态；
//   · 统一改成**一个**「写入状态」（单选：成功 / 失败 / 部分失败 / 未完成）；
//   · 成功与否 = 三个双向关联字段（销售明细 / 收款明细 / 库存流水）都有数据
//     ＋ 前端收集的字段（总金额 / 赠品 / 每件实收 / 收款行…）全部落表；
//   · 历史订单**不回填**：读取方对空值兼容（视为"未写入"，不当作成功）。
//
// ⚠️ 本模块必须保持**纯函数、零依赖**（config 层不引 service）。
// ⚠️ 旧维度名（userAction / sales / funds / stock）**只为兼容读取方保留**：
//    它们现在都取同一个「写入状态」并映射成旧词义，**不再有对应的写入列**。

const textOf = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};

// 新字段名（唯一真源）。
const WRITE_STATUS_FIELD = '写入状态';

// 「写入状态」的值域（生产表选项，业务负责人维护）。
const WRITE_STATUS_VALUES = Object.freeze(['成功', '失败', '部分失败', '未完成']);

// 兼容旧读取方：四个旧语义键都指向同一个新字段。
const SALES_STATUS_FIELDS = Object.freeze({
  writeStatus: WRITE_STATUS_FIELD,
  userAction: WRITE_STATUS_FIELD,
  sales: WRITE_STATUS_FIELD,
  funds: WRITE_STATUS_FIELD,
  stock: WRITE_STATUS_FIELD,
});

// 旧维度值域（保留导出给读取方/用例做兼容；不再写入）。
const SALES_STATUS_VALUE_DOMAINS = Object.freeze({
  writeStatus: WRITE_STATUS_VALUES,
  userAction: Object.freeze(['未确认', '已确认', '已取消', '待修改']),
  sales: Object.freeze(['未写入', '部分写入', '已写入', '写入失败']),
  funds: Object.freeze(['未写入', '已写入', '写入失败']),
  stock: Object.freeze(['未写入', '部分写入', '已写入', '写入失败']),
});

// 代码要写的值。
const SALES_STATUS_WRITE_VALUES = Object.freeze({
  writeStatus: Object.freeze({
    pending: '未完成',
    done: '成功',
    partial: '部分失败',
    failed: '失败',
  }),
  // 旧值保留（仅供兼容/测试引用的常量；业务表里已没有这些列可写）。
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

// 「账做完了没有」= 写入状态为「成功」。
// 旧字面量（已写入 / 已入账）只为历史读取兼容保留（历史记录不会再有这些列，但保留判据不会误伤）。
const POSTED_VALUES = Object.freeze(['成功', '已写入', '已入账']);
const isPosted = (value) => POSTED_VALUES.includes(textOf(value).trim());

const isBlank = (value) => textOf(value).trim() === '';

const pickFieldName = (table, key, fallback = '') => {
  const name = table?.[key];
  return typeof name === 'string' && name ? name : fallback;
};

const readStatus = (entry, table, key, fallback) => {
  const name = pickFieldName(table, key, fallback);
  const value = textOf(entry?.fields?.[name]);
  return isBlank(value) ? '' : value;
};

/** 「写入状态」原值：成功 / 失败 / 部分失败 / 未完成（空 = 历史/未写）。 */
const writeStatusOf = (entry, table) =>
  readStatus(entry, table, 'writeStatus', WRITE_STATUS_FIELD);

/** 「账入完了没有」的取值来源（= 写入状态；空 = 未写/历史单，不猜）。 */
const postedOf = (entry, table) => writeStatusOf(entry, table);

const mapWriteStatusToLegacy = (status) => {
  switch (textOf(status).trim()) {
    case SALES_STATUS_WRITE_VALUES.writeStatus.done: return SALES_STATUS_WRITE_VALUES.sales.done;
    case SALES_STATUS_WRITE_VALUES.writeStatus.partial: return SALES_STATUS_WRITE_VALUES.sales.partial;
    case SALES_STATUS_WRITE_VALUES.writeStatus.failed: return SALES_STATUS_WRITE_VALUES.sales.failed;
    case SALES_STATUS_WRITE_VALUES.writeStatus.pending: return SALES_STATUS_WRITE_VALUES.sales.none;
    default: return '';
  }
};

/** 旧词义映射：确认状态（未完成 → 未确认；其余有值 → 已确认）。 */
const userActionOf = (entry, table) => {
  const status = writeStatusOf(entry, table);
  if (!status) return '';
  return status === SALES_STATUS_WRITE_VALUES.writeStatus.pending ? '未确认' : '已确认';
};

/** 旧词义映射：销售状态（成功/部分失败/失败/未完成 → 已写入/部分写入/写入失败/未写入）。 */
const salesStatusOf = (entry, table) => mapWriteStatusToLegacy(writeStatusOf(entry, table));

/** 旧词义映射：库存状态。 */
const stockStatusOf = (entry, table) => mapWriteStatusToLegacy(writeStatusOf(entry, table));

/** 旧词义映射：资金状态（与 postedOf 同源）。 */
const fundsStatusOf = (entry, table) => mapWriteStatusToLegacy(writeStatusOf(entry, table));

module.exports = {
  WRITE_STATUS_FIELD,
  WRITE_STATUS_VALUES,
  SALES_STATUS_FIELDS,
  SALES_STATUS_VALUE_DOMAINS,
  SALES_STATUS_WRITE_VALUES,
  POSTED_VALUES,
  isPosted,
  postedOf,
  writeStatusOf,
  userActionOf,
  salesStatusOf,
  stockStatusOf,
  fundsStatusOf,
  textOf,
};
