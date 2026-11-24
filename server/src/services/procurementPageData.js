'use strict';

/**
 * 采购页读模型里的**纯函数**（无 I/O、无 gateway、无时钟副作用）——
 * 时间窗口 / 归一化 / 分组 / 统计全在这里，用例直接喂假记录就能钉住边界。
 *
 * 🔴 口径（2026-10-28 业务负责人确认，2026-11-21 增加未到货）：
 *   · 补货：销售明细（库存数量 = 0；销售日 = 今天 00:00 往前 3 个自然日，上海时区）
 *     ＋ 采购明细（数量 - 已入库数量 > 0）；
 *   · 上新：`货品信息` 上架日期 = 最近 7 天（今天 + 往前 6 天）；按记录 ID 分组；普通码 1 / 特殊码 0；顶部统计只有「新增货品」；
 *   · 颜色只读字段；「品类」不读；「记录 ID」只作内部主键，不出现在展示文案里。
 */

const { linkedRecordIds } = require('./v1Gateway/cells');

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
 * 补货窗口：默认 `[今天 - (days-1) 天 00:00, 今天 00:00)`（= 最近 days 个完整自然日，不含今天）。
 * `includeToday: true` 时改为 `[今天 - (days-1) 天 00:00, 现在]`。
 */
const replenishWindow = (now, config) => {
  const days = config.window.replenishDays;
  const offset = config.window.offsetMinutes;
  const today = dayStart(now, offset);
  // 业务负责人 2026-10-29 口径：开始 = **今天 00:00 - days 天**；结束 = **现在**
  // （例：10-29 00:57 ⇒ 10-26 00:00 ~ 10-29 00:57；跨月/跨年由 epoch 自动进位）
  const start = today - Math.max(0, days - 1) * DAY_MS;
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

/** Lookup 原始值 → 数字合计；空值按 0，多个值求和。 */
const sumNumbers = (value) => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sumNumbers(item), 0);
  if (value == null || value === '') return 0;
  if (typeof value === 'object') {
    if (Array.isArray(value.value)) return sumNumbers(value.value);
    if (value.value != null) return sumNumbers(value.value);
    if (value.text != null) return sumNumbers(value.text);
    return 0;
  }
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : 0;
};

/** 一行销售明细 → 规整行；认不出（缺主键 / 尺码 / 编码）⇒ null（不猜）。 */
const normalizeSalesRow = (record, fields) => {
  const fieldsOf = record?.fields || {};
  const productIds = linkedRecordIds(fieldsOf[fields.product]);
  // 生产「销售明细.recordID」是公式列（= 编号关联货品的 record_id）；优先用它，旧数据回退关联列。
  const formulaRecordId = textOf(fieldsOf[fields.recordId]).trim();
  const productRecordId = formulaRecordId || productIds[0] || '';
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
/** 采购明细 → 未到货行；缺货品 / 尺码 / 数量或已全部入库 ⇒ null。 */
const normalizePendingRow = (record, fields = {}) => {
  const fieldsOf = record?.fields || {};
  const productIds = linkedRecordIds(fieldsOf[fields.product]);
  const productRecordId = productIds[0] || '';
  const size = numberOf(fieldsOf[fields.size]);
  const requested = numberOf(fieldsOf[fields.quantity]);
  if (!productRecordId || !Number.isInteger(size) || requested === null || requested <= 0) return null;
  const arrived = sumNumbers(fieldsOf[fields.arrivedQuantity]);
  const notArrived = Math.max(requested - arrived, 0);
  if (notArrived <= 0) return null;
  return { productRecordId, size, requested, arrived, notArrived };
};

const buildReplenishView = ({
  records, pendingRecords = [], products, fields, productFields = fields,
  purchaseFields = {}, config, tradeTypeCodeOf, now,
}) => {
  const range = replenishWindow(now, config);
  const roles = config.behavior;
  const groupsByKey = new Map();
  let skippedRows = 0;
  let delistedRows = 0;
  const delistedProduct = (id) => products instanceof Map && products.get(id)?.delisted === true;
  // 只有**真的认不出交易类型**的行才进 tradeTypeUnknownRows。
  let tradeTypeUnknownRows = 0;
  for (const record of records || []) {
    const row = normalizeSalesRow(record, fields);
    if (!row) { skippedRows += 1; continue; }
    // 已下架货品不进入建议报货清单：用户看不到，也就选不到。
    if (delistedProduct(row.productRecordId)) { skippedRows += 1; delistedRows += 1; continue; }
    if (!(row.soldAt >= range.start && row.soldAt < range.end)) { skippedRows += 1; continue; }
    const code = tradeTypeCodeOf(row.tradeTypeCell);
    if (code !== roles.spot && code !== roles.prepaid) {
      skippedRows += 1;
      tradeTypeUnknownRows += 1;
      continue;
    }
    const group = groupsByKey.get(row.productRecordId) || {
      key: row.productRecordId, sizes: new Map(), standardSizes: new Set(), hasSales: false,
    };
    group.hasSales = true;
    group.standardSizes.add(row.size);
    if (row.stock === 0) {
      const entry = group.sizes.get(row.size) || { size: row.size, spotSold: 0, prepaidSold: 0, notArrived: 0 };
      if (code === roles.spot) entry.spotSold += 1; else entry.prepaidSold += 1;
      group.sizes.set(row.size, entry);
    }
    groupsByKey.set(row.productRecordId, group);
  }
  // 补货来源 B：采购明细「数量 - 已入库数量」> 0 的未到货行。
  for (const record of pendingRecords || []) {
    const row = normalizePendingRow(record, purchaseFields);
    if (!row) continue;
    // 未到货来源同样按货品下架状态过滤，避免只过滤销售来源的半套效果。
    if (delistedProduct(row.productRecordId)) { delistedRows += 1; continue; }
    const group = groupsByKey.get(row.productRecordId) || {
      key: row.productRecordId, sizes: new Map(), standardSizes: new Set(), hasSales: false,
    };
    const entry = group.sizes.get(row.size) || { size: row.size, spotSold: 0, prepaidSold: 0, notArrived: 0 };
    entry.notArrived += row.notArrived;
    group.sizes.set(row.size, entry);
    group.standardSizes.add(row.size);
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
      category: textOf(dto.category),
      supplierRecordId: dto.supplierRecordId || '',
      supplierName: dto.supplierName || '',
      product_missing_text: dto.product_missing_text || '',
      product_record_url: dto.product_record_url || '',
      product_adjust_url: dto.product_adjust_url || '',
      product_action_labels: dto.product_action_labels || null,
    };
  };
  const groups = [...groupsByKey.values()].map((group) => {
    const product = productOf(group.key);
    const sizes = [...group.sizes.values()].sort((a, b) => a.size - b.size);
    const standardSizes = [...group.standardSizes].sort((a, b) => a - b);
    const prepaidTotal = sizes.reduce((sum, entry) => sum + entry.prepaidSold, 0);
    const spotTotal = sizes.reduce((sum, entry) => sum + entry.spotSold, 0);
    const notArrivedTotal = sizes.reduce((sum, entry) => sum + (entry.notArrived || 0), 0);
    const stockMode = sizes.length ? (config.stockPresentation?.zero || 'standard') : (config.stockPresentation?.noZeroProduct || 'custom-only');
    return { ...product, sizes, standardSizes, stockMode, prepaidTotal, spotTotal, notArrivedTotal };
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
      notArrived: groups.reduce((sum, group) => sum + group.notArrivedTotal, 0),
      productCount: groups.length,
    },
    groups,
    skippedRows,
    delistedRows,
    // #950：跳过原因拆分（既有 `skippedRows` 保持总数，向后兼容）
    tradeTypeUnknownRows,
  };
};

module.exports = {
  DAY_MS,
  dayStart,
  dayIso,
  replenishWindow,
  textOf,
  numberOf,
  sumNumbers,
  normalizeSalesRow,
  normalizePendingRow,
  buildReplenishView,
};
