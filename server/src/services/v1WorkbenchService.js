const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { LIVE_STATES } = require('./inventoryService');
const {
  SALES_QUERY_MAX_RANGE_DAYS,
  WORKBENCH_PRODUCT_SEARCH_LIMIT,
  WORKBENCH_CATEGORY_LIMIT,
} = require('../config/workbenchQuery');
const { logWarn } = require('../utils/logger');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const fieldValue = (schema, tableKey, record, semanticKey) => {
  const fieldName = schema.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? record?.fields?.[fieldName] : undefined;
};

const asText = (schema, tableKey, record, semanticKey) => textValue(fieldValue(schema, tableKey, record, semanticKey)).trim();
const asLinks = (schema, tableKey, record, semanticKey) => linkedRecordIds(fieldValue(schema, tableKey, record, semanticKey));
const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(textValue(value).replace(/,/g, '').replace(/¥/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
const asOptionalNumber = (value) => textValue(value).trim() === '' ? null : asNumber(value);

const asDate = (value) => {
  if (value == null || value === '') return null;
  // ⚠️ Date 实例必须单独认：`textValue(new Date())` 取的是 `.text/.name/.value`，
  // 全是 undefined → 空串。`todayKey()` 传的正是 `new Date()`，少了这一行
  // `/sales/today` 不传日期时算出来的"今天"是空串，筛出来一条都没有
  //（2026-10-06 修：老接口不带 ?date= 时页面永远显示空）。
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = typeof value === 'number' ? value : textValue(value).trim();
  if (raw === '') return null;
  const timestamp = typeof raw === 'number' || /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = timestamp === null ? new Date(raw) : new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

const shanghaiDayKey = (date) => {
  const parsed = asDate(date);
  if (!parsed) return '';
  return new Date(parsed.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
};

const todayKey = (now = new Date()) => shanghaiDayKey(now);

// 入参错误（她日期填错 / 范围太大）与系统错误分开：前者回 400 并原样告诉她，
// 后者回 502/500 且不回显内部细节。与 InventoryAdjustmentService 用同一个约定。
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const parseDay = (value, label) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (!DAY_PATTERN.test(text)) throw userError(`${label}的格式必须是 YYYY-MM-DD`);
  return text;
};

/**
 * 「销售查询」的日期入参归一化。三种调用方式都收敛成同一个 [from, to]：
 *   · `date=2026-10-06`        → 按某日（from = to = date）
 *   · `from=…&to=…`            → 按区间（含首尾）
 *   · 都不传                    → 今天（保持 /sales/today 的既有行为）
 * 返回的 `date`：单日查询时是那一天，区间查询时是空串 —— 页面据此决定文案。
 */
const resolveSalesRange = ({ date, from, to } = {}) => {
  const day = parseDay(date, '业务日期');
  if (day) return { from: day, to: day, date: day };
  let start = parseDay(from, '开始日期');
  let end = parseDay(to, '结束日期');
  if (!start && !end) {
    const today = todayKey();
    return { from: today, to: today, date: today };
  }
  if (!start) start = end;
  if (!end) end = start;
  if (start > end) throw userError('开始日期不能晚于结束日期');
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > SALES_QUERY_MAX_RANGE_DAYS) {
    throw userError(`一次最多查询 ${SALES_QUERY_MAX_RANGE_DAYS} 天，请缩小日期范围`);
  }
  return { from: start, to: end, date: start === end ? start : '' };
};

const indexByRecordId = (records) => new Map(records.map((record) => [record.record_id, record]));

const isDataNotReady = (error) => /1254607|data not ready|数据未准备好/i.test(String(error?.message || error || ''));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const listAllWithRetry = async (gateway, tableKey, requestId) => {
  const delays = [0, 1000, 3000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await wait(delays[attempt]);
    try {
      return await gateway.listAll(tableKey);
    } catch (error) {
      if (!isDataNotReady(error) || attempt === delays.length - 1) throw error;
      logWarn('workbench.query.retry', {
        request_id: requestId,
        table_key: tableKey,
        attempt: attempt + 1,
        reason: 'feishu_data_not_ready',
      });
    }
  }
  return [];
};

const relationLabel = (schema, tableKey, recordsById, ids, semanticKey) => {
  const labels = ids.map((id) => asText(schema, tableKey, recordsById.get(id), semanticKey)).filter(Boolean);
  return labels.join('、');
};

const buildProductLabel = (schema, productsById, ids) => {
  const product = productsById.get(ids[0]);
  if (!product) return { product_record_id: ids[0] || '', product_number: '', item_no: '', color: '' };
  return {
    product_record_id: product.record_id || '',
    product_number: asText(schema, 'product', product, 'number'),
    item_no: asText(schema, 'product', product, 'itemNo'),
    color: asText(schema, 'product', product, 'color'),
  };
};

const createWorkbenchService = (gateway, options = {}) => {
  const schema = options.schema || V1_BITABLE_SCHEMA;
  const getSizeReferences = createSizeReferenceAccess({ gateway, sizeReferences: options.sizeReferences });

  // 尺码字段已改为关联「尺码管理」：必须走共享的尺码解析，不能靠关联单元格
  // 自带的显示文本——飞书部分接口只返回 record_ids 而不返回 text，
  // 那时 asText 会拿到空字符串，页面就静默显示成没有尺码。
  // 单条记录的尺码关联损坏不应该让整个查询失败，但要留下日志。
  const resolveSize = async (tableKey, record) => {
    try {
      return (await getSizeReferences().resolveLinkedCell(fieldValue(schema, tableKey, record, 'size'))).size;
    } catch (error) {
      logWarn('workbench.size.unresolved', {
        table_key: tableKey,
        record_id: record?.record_id,
        error: error.message,
      });
      return null;
    }
  };

  // 「销售查询」：**按某日**和**按区间**都走这一个实现，`/sales/today` 只是它的一种入参。
  // 这样"今日"与"区间"不会长出两套口径（两套口径迟早在汇总数字上分家）。
  const getSalesReport = async ({ date, from, to, requestId } = {}) => {
    const range = resolveSalesRange({ date, from, to });
    const [sales, products, paymentMethods, entries, receipts] = await Promise.all([
      listAllWithRetry(gateway, 'salesDetail', requestId),
      listAllWithRetry(gateway, 'product', requestId),
      listAllWithRetry(gateway, 'paymentMethod', requestId),
      listAllWithRetry(gateway, 'salesEntry', requestId),
      listAllWithRetry(gateway, 'paymentRecord', requestId),
    ]);
    const productsById = indexByRecordId(products);
    const paymentsById = indexByRecordId(paymentMethods);
    const entriesById = indexByRecordId(entries);
    const receiptsByOrder = new Map();
    for (const receipt of receipts) {
      const orderId = asLinks(schema, 'paymentRecord', receipt, 'salesEntry')[0];
      if (!orderId) continue;
      if (!receiptsByOrder.has(orderId)) receiptsByOrder.set(orderId, []);
      receiptsByOrder.get(orderId).push(receipt);
    }
    const rows = (await Promise.all(sales
      .map(async (record) => {
        const soldAt = fieldValue(schema, 'salesDetail', record, 'soldAt');
        const productIds = asLinks(schema, 'salesDetail', record, 'product');
        const salesEntryIds = asLinks(schema, 'salesDetail', record, 'salesEntry');
        const orderId = salesEntryIds[0] || '';
        const order = entriesById.get(orderId);
        const receiptRows = receiptsByOrder.get(orderId) || [];
        const saleDate = asDate(soldAt) || asDate(fieldValue(schema, 'salesEntry', order, 'recordedAt'));
        const quantity = 1;
        const listUnitPrice = asOptionalNumber(fieldValue(schema, 'salesDetail', record, 'listUnitPrice'));
        return {
          record_id: record.record_id,
          detail_id: asText(schema, 'salesDetail', record, 'detailId'),
          sales_entry_record_id: salesEntryIds[0] || '',
          sales_order_no: relationLabel(schema, 'salesEntry', entriesById, salesEntryIds, 'orderNo') || asText(schema, 'salesDetail', record, 'salesEntry'),
          sold_at: saleDate?.toISOString() || '',
          ...buildProductLabel(schema, productsById, productIds),
          size: await resolveSize('salesDetail', record),
          quantity,
          receivable_amount: asOptionalNumber(fieldValue(schema, 'salesDetail', record, 'actualAmount')),
          list_amount: listUnitPrice === null ? null : Math.round(listUnitPrice * quantity * 100) / 100,
          gift: asText(schema, 'salesDetail', record, 'gift'),
          payment_method: [...new Set(receiptRows.map((payment) => relationLabel(schema, 'paymentMethod', paymentsById,
            asLinks(schema, 'paymentRecord', payment, 'method'), 'name')))].filter(Boolean).join('＋') || '未收款',
          // 取值来源走配置：**只读「资金状态」**（旧「确认状态（旧）」已被业务负责人整列删除，
          // 没有回退可言）；判据入口不变（postedOf + isPosted，内部保持 trim）。
          confirmed: isPosted(postedOf(order, schema.tables.salesEntry?.fields)),
        };
      })))
      // 区间是**含首尾**的闭区间（她说"按某日和按区间查询"）。
      .filter((row) => {
        if (!row.confirmed || !row.sold_at) return false;
        const day = shanghaiDayKey(row.sold_at);
        return day >= range.from && day <= range.to;
      })
      .sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)));

    const paymentSummary = {};
    const orderIds = new Set();
    const summary = rows.reduce((result, row) => {
      result.quantity += row.quantity;
      if (row.sales_entry_record_id) orderIds.add(row.sales_entry_record_id);
      return result;
    }, { detail_count: rows.length, order_count: 0, quantity: 0, paid_amount: 0, platform_pending_amount: 0 });
    summary.order_count = orderIds.size || rows.length;
    summary.receivable_amount = rows.every((row) => row.receivable_amount !== null)
      ? rows.reduce((sum, row) => sum + row.receivable_amount, 0) : null;
    for (const orderId of orderIds) {
      for (const receipt of receiptsByOrder.get(orderId) || []) {
        const paid = asNumber(fieldValue(schema, 'paymentRecord', receipt, 'amount'));
        const status = asText(schema, 'paymentRecord', receipt, 'status') || '已收款';
        const method = relationLabel(schema, 'paymentMethod', paymentsById,
          asLinks(schema, 'paymentRecord', receipt, 'method'), 'name') || '未填写';
        if (status === '待平台结算') summary.platform_pending_amount += paid;
        else if (status === '已收款' || status === '已收清' || status === '已结清') {
          summary.paid_amount += paid;
          paymentSummary[method] = (paymentSummary[method] || 0) + paid;
        }
      }
    }
    return {
      // `date` 保持旧字段（单日查询时就是那一天），`from`/`to` 是网页选择器要的区间；
      // 页面按 from === to 判断该说"今日/某日"还是"某区间"。
      date: range.date,
      from: range.from,
      to: range.to,
      is_range: range.from !== range.to,
      summary: { ...summary, payment_summary: paymentSummary },
      rows,
    };
  };

  // 「今日销售」的旧入口：等价于 getSalesReport({ date })，响应形状一字不改，
  // 保证 `/api/workbench/sales/today` 的既有调用方不受影响。
  const getTodaySales = (options = {}) => getSalesReport(options);

  // 工作台「盘点调整 / 换季调整」要按 货号 找货品：返回 record_id 供库存接口用。
  const findProducts = async ({ keyword = '', limit = WORKBENCH_PRODUCT_SEARCH_LIMIT, requestId } = {}) => {
    const products = await listAllWithRetry(gateway, 'product', requestId);
    const normalized = String(keyword).trim().toLowerCase();
    const rows = products.map((record) => ({
      record_id: record.record_id,
      product_number: asText(schema, 'product', record, 'number'),
      item_no: asText(schema, 'product', record, 'itemNo'),
      color: asText(schema, 'product', record, 'color'),
    })).filter((row) => !normalized || [row.product_number, row.item_no, row.color]
      .some((value) => String(value).toLowerCase().includes(normalized)));
    return { rows: rows.slice(0, limit), total: rows.length };
  };

  // 某个 货号 + 尺码 在三种「所属状态」下各有多少双 —— 「实时库存」是一双一条，
  // 所以**数量 = 记录条数**（与 getLiveInventory 的分组口径一致）。
  const getInventoryStockLevels = async ({ productRecordId, size, requestId } = {}) => {
    const product = String(productRecordId ?? '').trim();
    if (!product) throw userError('缺少货号 record_id');
    const requestedSize = String(size ?? '').trim();
    if (requestedSize && !/^[1-9]\d*$/.test(requestedSize)) throw userError('尺码必须是正整数');
    const inventory = await listAllWithRetry(gateway, 'liveInventory', requestId);
    const counts = new Map(LIVE_STATES.map((state) => [state, 0]));
    let total = 0;
    for (const record of inventory) {
      if (!asLinks(schema, 'liveInventory', record, 'product').includes(product)) continue;
      if (requestedSize) {
        const rowSize = await resolveSize('liveInventory', record);
        if (String(rowSize) !== requestedSize) continue;
      }
      const state = asText(schema, 'liveInventory', record, 'state');
      if (!counts.has(state)) continue;
      counts.set(state, counts.get(state) + 1);
      total += 1;
    }
    return {
      product_record_id: product,
      size: requestedSize ? Number(requestedSize) : null,
      total,
      rows: LIVE_STATES.map((state) => ({ state, quantity: counts.get(state) })),
    };
  };

  // 「换季调整（按品类批量）」的品类清单。品类取自「实时库存」的「品类」公式列
  // （读生产/测试真表核过：liveInventory.品类 type=20 公式，返回品类名）。
  const listInventoryCategories = async ({ requestId, limit = WORKBENCH_CATEGORY_LIMIT } = {}) => {
    const inventory = await listAllWithRetry(gateway, 'liveInventory', requestId);
    const counts = new Map();
    for (const record of inventory) {
      const category = asText(schema, 'liveInventory', record, 'category');
      if (!category) continue;
      counts.set(category, (counts.get(category) || 0) + 1);
    }
    const rows = [...counts.entries()]
      .map(([category, quantity]) => ({ category, quantity }))
      .sort((a, b) => b.quantity - a.quantity || a.category.localeCompare(b.category, 'zh-CN'));
    return { rows: rows.slice(0, limit), total: rows.length };
  };

  const getLiveInventory = async ({ keyword = '', size = '', requestId } = {}) => {
    const [inventory, products] = await Promise.all([
      listAllWithRetry(gateway, 'liveInventory', requestId),
      listAllWithRetry(gateway, 'product', requestId),
    ]);
    const productsById = indexByRecordId(products);
    const normalizedKeyword = String(keyword).trim().toLowerCase();
    const rawRows = (await Promise.all(inventory.map(async (record) => {
      const productIds = asLinks(schema, 'liveInventory', record, 'product');
      const product = buildProductLabel(schema, productsById, productIds);
      return {
        record_id: record.record_id,
        stock_key: asText(schema, 'liveInventory', record, 'stockKey'),
        ...product,
        size: await resolveSize('liveInventory', record),
        state: asText(schema, 'liveInventory', record, 'state'),
        // 「品类」是实时库存上的公式列：工作台「换季调整（按品类批量）」靠它分组。
        category: asText(schema, 'liveInventory', record, 'category'),
        updated_at: asDate(fieldValue(schema, 'liveInventory', record, 'updatedAt'))?.toISOString() || '',
      };
    }))).filter((row) => {
      const matchesKeyword = !normalizedKeyword || [row.stock_key, row.product_number, row.item_no, row.color].some((value) => String(value).toLowerCase().includes(normalizedKeyword));
      // size 现在是整数（解析关联得到），筛选参数是字符串，统一按字符串比较。
      const matchesSize = !String(size).trim()
        || (row.size !== null && String(row.size) === String(size).trim());
      return matchesKeyword && matchesSize;
    });
    const grouped = new Map();
    rawRows.forEach((row) => {
      const key = `${row.product_record_id}|${row.size}|${row.state}`;
      const current = grouped.get(key);
      if (current) {
        current.quantity += 1;
        if (row.updated_at > current.updated_at) current.updated_at = row.updated_at;
      } else {
        grouped.set(key, { ...row, quantity: 1 });
      }
    });
    const rows = [...grouped.values()].sort((a, b) => String(a.stock_key).localeCompare(String(b.stock_key), 'zh-CN'));
    return { rows, duplicate_stock_keys: [] };
  };

  return {
    getTodaySales,
    getSalesReport,
    getLiveInventory,
    findProducts,
    getInventoryStockLevels,
    listInventoryCategories,
  };
};

module.exports = {
  createWorkbenchService,
  resolveSalesRange,
  todayKey,
  shanghaiDayKey,
};
