'use strict';

/**
 * 采购页读模型里的**纯函数**（无 I/O、无 gateway、无时钟副作用）——
 * 时间窗口 / 归一化 / 分组 / 统计全在这里，用例直接喂假记录就能钉住边界。
 *
 * 🔴 口径（2026-10-28 业务负责人确认，见 `docs/procurement-page-real-2026-10-28.md`）：
 *   · 补货：**只查「销售明细」一张表**；库存数量 = 0；销售日 = 今天 00:00 往前 3 个自然日（上海时区）；
 *   · 上新：`货品信息` 上架日期 = 今天；按记录 ID 分组；普通码 1 / 特殊码 0；顶部统计只有「新增货品」；
 *   · 颜色只读字段；「品类」不读；「记录 ID」只作内部主键，不出现在展示文案里。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 上海时区某一天 00:00 的 epoch（毫秒）。offsetMinutes 默认 +480。 */
const dayStart = (epoch, offsetMinutes) => {
  const offset = Number(offsetMinutes) * 60 * 1000;
  return Math.floor((Number(epoch) + offset) / DAY_MS) * DAY_MS - offset;
};

/** epoch → 上海时区的 `YYYY-MM-DD`（统计范围文案用；页面自己再决定怎么显示）。 */
const dayIso = (epoch, offsetMinutes) => new Date(Number(epoch) + Number(offsetMinutes) * 60 * 1000)
  .toISOString().slice(0, 10);

/**
 * 补货窗口：默认 `[今天 00:00 - days 天, 今天 00:00)`（= 最近 days 个完整自然日，不含今天）。
 * `includeToday: true` 时改为 `[今天 - (days-1) 天, 现在]`。
 */
const replenishWindow = (now, config) => {
  const days = config.window.replenishDays;
  const offset = config.window.offsetMinutes;
  const today = dayStart(now, offset);
  // 业务负责人 2026-10-29 口径：开始 = **今天 00:00 - days 天**；结束 = **现在**
  // （例：10-29 00:57 ⇒ 10-26 00:00 ~ 10-29 00:57；跨月/跨年由 epoch 自动进位）
  const start = today - days * DAY_MS;
  if (config.window.includeToday) {
    return { start, end: Number(now), days, from: dayIso(start, offset), to: dayIso(now, offset) };
  }
  return { start, end: today, days, from: dayIso(start, offset), to: dayIso(today - 1, offset) };
};

/**
 * 文本单元格 → 纯文本（关联列 / 公式列 / 单选列都收敛成字符串）。
 * ⚠️ 2026-10-28（真测试 Base 验证 · Bug-2）：`getBatch`（batch_get）的形状是
 *   `{ type, value: [{ text }] }`（**没有顶层 text**），与列表接口不同 ⇒ 这里必须解包，
 *   否则会得到 `[object Object]`（例：`product_number`）。关联列 `{ link_record_ids }` 没有显示文本，
 *   显示名由 `procurementProductEnricher` 按 link id 再批量读（颜色管理）解析。
 */
const textOf = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(',');
  if (typeof value === 'object') {
    if (value.text != null) return String(value.text);
    if (value.name != null) return String(value.name);
    if (Array.isArray(value.value)) return value.value.map(textOf).filter(Boolean).join(',');
    if (value.value != null) return textOf(value.value);
  }
  return '';
};

/** 数字单元格 → number；认不出 ⇒ null（不把空串当 0）。 */
const numberOf = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = textOf(value).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

/** 关联列 → record_id 列表（GET list 的形状：`[{record_ids:[…], text}]`）。 */
const linkedIdsOf = (value) => {
  if (Array.isArray(value)) return value.flatMap(linkedIdsOf);
  if (typeof value === 'string') return value ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  const nested = [value.record_ids, value.link_record_ids].filter(Array.isArray);
  if (nested.length) return nested.flatMap(linkedIdsOf);
  const id = value.record_id || value.recordId || value.id;
  return id ? [String(id)] : [];
};

/** 一行销售明细 → 规整行；认不出（缺主键 / 尺码 / 编码）⇒ null（不猜）。 */
const normalizeSalesRow = (record, fields) => {
  const fieldsOf = record?.fields || {};
  const productIds = linkedIdsOf(fieldsOf[fields.product]);
  const productRecordId = productIds[0] || '';
  const size = numberOf(fieldsOf[fields.size]);
  const soldAt = numberOf(fieldsOf[fields.soldAt]);
  const stock = numberOf(fieldsOf[fields.stockQuantity]);
  if (!productRecordId || !Number.isInteger(size) || soldAt === null) return null;
  return {
    productRecordId, size, soldAt, stock,
    soldAtMs: soldAt,
    // 交易类型单元格原样带着（编码解析交给调用方注入的判据）
    tradeTypeCell: fieldsOf[fields.tradeType],
  };
};

/**
 * 补货视图：按货品记录 ID 分组 → 按尺码聚合「现货已售 / 预订待补」。
 * @param {object} input.records        销售明细原始记录
 * @param {Map}    input.products       recordId → 货品信息原始记录
 * @param {object} input.fields         schema 里的物理列名（salesDetail 段）
 * @param {object} [input.productFields] schema 里的物理列名（product 段；默认与 fields 同一份）
 * @param {object} input.config         `PROCUREMENT_PAGE`
 * @param {(cell:any)=>string} input.tradeTypeCodeOf 交易类型单元格 → `SALE_CASH` / `SALE_PREPAID` / ''（判据注入）
 * @param {number} input.now            epoch（毫秒）
 */
const buildReplenishView = ({ records, products, fields, productFields = fields, config, tradeTypeCodeOf, now }) => {
  const range = replenishWindow(now, config);
  const roles = config.behavior;
  const groupsByKey = new Map();
  let skippedRows = 0;
  for (const record of records || []) {
    const row = normalizeSalesRow(record, fields);
    if (!row) { skippedRows += 1; continue; }
    // 防御性再判一次（飞书 filter 已按库存=0 筛过；这里保证"公式返回非 0 / 空"绝不计入）
    if (row.stock !== 0) { skippedRows += 1; continue; }
    if (!(row.soldAt >= range.start && row.soldAt < range.end)) { skippedRows += 1; continue; }
    const code = tradeTypeCodeOf(row.tradeTypeCell);
    if (code !== roles.spot && code !== roles.prepaid) { skippedRows += 1; continue; }
    const group = groupsByKey.get(row.productRecordId) || { key: row.productRecordId, sizes: new Map() };
    const entry = group.sizes.get(row.size) || { size: row.size, spotSold: 0, prepaidSold: 0 };
    if (code === roles.spot) entry.spotSold += 1; else entry.prepaidSold += 1;
    group.sizes.set(row.size, entry);
    groupsByKey.set(row.productRecordId, group);
  }
  // products 的 value 是**已归一化**的 DTO（`procurementProductEnricher` 的产物）——
  // 不在本纯函数里直接读飞书 batch 形状（那样会把 `[object Object]` 带进页面/载荷）。
  const productOf = (recordId) => {
    const dto = products instanceof Map ? (products.get(recordId) || {}) : {};
    return {
      productRecordId: recordId,
      number: textOf(dto.number),
      itemNo: textOf(dto.itemNo),
      color: textOf(dto.color),
      supplierRecordId: dto.supplierRecordId || '',
    };
  };
  const groups = [...groupsByKey.values()].map((group) => {
    const product = productOf(group.key);
    const sizes = [...group.sizes.values()].sort((a, b) => a.size - b.size);
    const prepaidTotal = sizes.reduce((sum, entry) => sum + entry.prepaidSold, 0);
    const spotTotal = sizes.reduce((sum, entry) => sum + entry.spotSold, 0);
    return { ...product, sizes, prepaidTotal, spotTotal };
  });
  const sortConfig = config.sort.replenishGroup;
  groups.sort((a, b) => {
    if (sortConfig.prepaidDesc && b.prepaidTotal !== a.prepaidTotal) return b.prepaidTotal - a.prepaidTotal;
    if (sortConfig.spotDesc && b.spotTotal !== a.spotTotal) return b.spotTotal - a.spotTotal;
    if (!sortConfig.numberAsc) return 0;
    return String(a.itemNo || a.number).localeCompare(String(b.itemNo || b.number), 'zh-Hans-CN', { numeric: true });
  });
  return {
    range,
    stats: {
      spotSold: groups.reduce((sum, group) => sum + group.spotTotal, 0),
      prepaidPending: groups.reduce((sum, group) => sum + group.prepaidTotal, 0),
      productCount: groups.length,
    },
    groups,
    skippedRows,
  };
};

module.exports = {
  DAY_MS,
  dayStart,
  dayIso,
  replenishWindow,
  textOf,
  numberOf,
  linkedIdsOf,
  normalizeSalesRow,
  buildReplenishView,
};
