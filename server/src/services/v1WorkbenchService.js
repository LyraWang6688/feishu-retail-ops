const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
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

  const getTodaySales = async ({ date = todayKey(), requestId } = {}) => {
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
    const rows = sales
      .map((record) => {
        const soldAt = fieldValue(schema, 'salesDetail', record, 'soldAt');
        const productIds = asLinks(schema, 'salesDetail', record, 'product');
        const salesEntryIds = asLinks(schema, 'salesDetail', record, 'salesEntry');
        const orderId = salesEntryIds[0] || '';
        const order = entriesById.get(orderId);
        const receiptRows = receiptsByOrder.get(orderId) || [];
        const saleDate = asDate(soldAt) || asDate(fieldValue(schema, 'salesEntry', order, 'sentAt'));
        return {
          record_id: record.record_id,
          detail_id: asText(schema, 'salesDetail', record, 'detailId'),
          sales_entry_record_id: salesEntryIds[0] || '',
          sales_order_no: relationLabel(schema, 'salesEntry', entriesById, salesEntryIds, 'orderNo') || asText(schema, 'salesDetail', record, 'salesEntry'),
          sold_at: saleDate?.toISOString() || '',
          ...buildProductLabel(schema, productsById, productIds),
          size: asText(schema, 'salesDetail', record, 'size'),
          quantity: asNumber(fieldValue(schema, 'salesDetail', record, 'quantity')),
          receivable_amount: asOptionalNumber(fieldValue(schema, 'salesDetail', record, 'actualAmount')),
          list_amount: asOptionalNumber(fieldValue(schema, 'salesDetail', record, 'receivableAmount')),
          gift: asText(schema, 'salesDetail', record, 'gift'),
          payment_method: [...new Set(receiptRows.map((payment) => relationLabel(schema, 'paymentMethod', paymentsById,
            asLinks(schema, 'paymentRecord', payment, 'method'), 'name')))].filter(Boolean).join('＋') || '未收款',
          confirmed: asText(schema, 'salesEntry', order, 'confirmStatus') === '已入账',
        };
      })
      .filter((row) => row.confirmed && row.sold_at && shanghaiDayKey(row.sold_at) === date)
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
        const status = asText(schema, 'paymentRecord', receipt, 'status') || '已收清';
        const method = relationLabel(schema, 'paymentMethod', paymentsById,
          asLinks(schema, 'paymentRecord', receipt, 'method'), 'name') || '未填写';
        if (status === '待平台结算') summary.platform_pending_amount += paid;
        else {
          summary.paid_amount += paid;
          paymentSummary[method] = (paymentSummary[method] || 0) + paid;
        }
      }
    }
    return { date, summary: { ...summary, payment_summary: paymentSummary }, rows };
  };

  const getLiveInventory = async ({ keyword = '', size = '', requestId } = {}) => {
    const [inventory, products] = await Promise.all([
      listAllWithRetry(gateway, 'liveInventory', requestId),
      listAllWithRetry(gateway, 'product', requestId),
    ]);
    const productsById = indexByRecordId(products);
    const normalizedKeyword = String(keyword).trim().toLowerCase();
    const rawRows = inventory.map((record) => {
      const productIds = asLinks(schema, 'liveInventory', record, 'product');
      const product = buildProductLabel(schema, productsById, productIds);
      return {
        record_id: record.record_id,
        stock_key: asText(schema, 'liveInventory', record, 'stockKey'),
        ...product,
        size: asText(schema, 'liveInventory', record, 'size'),
        state: asText(schema, 'liveInventory', record, 'state'),
        updated_at: asDate(fieldValue(schema, 'liveInventory', record, 'updatedAt'))?.toISOString() || '',
      };
    }).filter((row) => {
      const matchesKeyword = !normalizedKeyword || [row.stock_key, row.product_number, row.item_no, row.color].some((value) => String(value).toLowerCase().includes(normalizedKeyword));
      const matchesSize = !String(size).trim() || row.size === String(size).trim();
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

  return { getTodaySales, getLiveInventory };
};

module.exports = {
  createWorkbenchService,
  todayKey,
  shanghaiDayKey,
};
