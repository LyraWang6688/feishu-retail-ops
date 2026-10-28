'use strict';

/**
 * 采购页「上新」读模型的纯函数（无 I/O）—— 从 `procurementPageData.js` 按职责拆出
 * （新文件 ≤200 行的硬约束；口径一字未改）。
 *
 * 口径（2026-10-28 业务负责人确认，见 `docs/procurement-page-real-2026-10-28.md`）：
 *   · 上新 = `货品信息.上架日期` 今天（上海时区）；按记录 ID 分组；
 *   · 类别 A/B + `SCAN_PAGE.SIZE_SEGMENTS` 的 normal / special（normal 是闭区间 ⇒ 展开成逐码）；
 *   · 类别缺失 ⇒ **不猜**（categoryMissing + 空尺码）；
 *   · 顶部统计**只有「新增货品」**（业务负责人 2026-10-28 再确认）。
 */

const { DAY_MS, dayStart, dayIso, textOf, numberOf, linkedIdsOf } = require('./procurementPageData');

/** 上新窗口：`[今天 00:00, 明天 00:00)`（上海时区）。 */
const todayWindow = (now, config) => {
  const offset = config.window.offsetMinutes;
  const start = dayStart(now, offset);
  return {
    start, end: start + DAY_MS, from: dayIso(start, offset), to: dayIso(start, offset),
  };
};

/** 一条货品记录 → 上新/扫码共用 DTO（记录 ID 只作内部主键；类别缺失 ⇒ 不猜）。 */
const normalizeProduct = (record, fields, config) => {
  const fieldsOf = record?.fields || {};
  const category = textOf(fieldsOf[fields.category]).trim().toUpperCase();
  const sizes = config.sizes[category] || null;
  return {
    productRecordId: String(record?.record_id || ''),
    number: textOf(fieldsOf[fields.number]),
    itemNo: textOf(fieldsOf[fields.itemNo]),
    color: textOf(fieldsOf[fields.color]),
    category: sizes ? category : '',
    categoryMissing: !sizes,
    supplierName: textOf(fieldsOf[fields.supplier]),
    supplierRecordId: linkedIdsOf(fieldsOf[fields.supplier])[0] || '',
    createdAt: numberOf(fieldsOf[fields.createdAt]),
    sizes: { normal: sizes ? [...sizes.normal] : [], special: sizes ? [...sizes.special] : [] },
    defaults: { normal: config.defaults.normalQuantity, special: config.defaults.specialQuantity },
  };
};

/** 上新视图：今天新增的货品（按记录 ID 分组 = 一条记录一张卡；统计只有「新增货品」）。 */
const buildNewProductsView = ({ records, fields, config, now }) => {
  const range = todayWindow(now, config);
  const groups = [];
  let skippedRows = 0;
  for (const record of records || []) {
    const createdAt = numberOf(record?.fields?.[fields.createdAt]);
    if (createdAt === null || !(createdAt >= range.start && createdAt < range.end)) { skippedRows += 1; continue; }
    const product = normalizeProduct(record, fields, config);
    if (!product.productRecordId) { skippedRows += 1; continue; }
    groups.push(product);
  }
  if (config.sort.newProductCreatedAtAsc) {
    groups.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.number).localeCompare(String(b.number)));
  }
  return {
    range,
    stats: { productCount: groups.length },
    groups,
    skippedRows,
  };
};


module.exports = { todayWindow, normalizeProduct, buildNewProductsView };
