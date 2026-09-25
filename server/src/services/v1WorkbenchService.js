const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const fieldValue = (schema, tableKey, record, semanticKey) => {
  const fieldName = schema.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? record?.fields?.[fieldName] : undefined;
};

const asText = (schema, tableKey, record, semanticKey) => textValue(fieldValue(schema, tableKey, record, semanticKey)).trim();
const asLinks = (schema, tableKey, record, semanticKey) => linkedRecordIds(fieldValue(schema, tableKey, record, semanticKey));
const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(/,/g, '').replace(/¥/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const asDate = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const shanghaiDayKey = (date) => {
  const parsed = asDate(date);
  if (!parsed) return '';
  return new Date(parsed.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
};

const todayKey = (now = new Date()) => shanghaiDayKey(now);

const indexByRecordId = (records) => new Map(records.map((record) => [record.record_id, record]));

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

  const getTodaySales = async ({ date = todayKey(), now } = {}) => {
    const [sales, products, payments, behaviors, entries] = await Promise.all([
      gateway.listAll('salesDetail'),
      gateway.listAll('product'),
      gateway.listAll('paymentMethod'),
      gateway.listAll('behavior'),
      gateway.listAll('salesEntry'),
    ]);
    const productsById = indexByRecordId(products);
    const paymentsById = indexByRecordId(payments);
    const behaviorsById = indexByRecordId(behaviors);
    const entriesById = indexByRecordId(entries);
    const rows = sales
      .map((record) => {
        const soldAt = fieldValue(schema, 'salesDetail', record, 'soldAt');
        const productIds = asLinks(schema, 'salesDetail', record, 'product');
        const salesEntryIds = asLinks(schema, 'salesDetail', record, 'salesEntry');
        const behaviorIds = asLinks(schema, 'salesDetail', record, 'behavior');
        const paymentIds = asLinks(schema, 'salesDetail', record, 'paymentMethod');
        return {
          record_id: record.record_id,
          detail_id: asText(schema, 'salesDetail', record, 'detailId'),
          sales_entry_record_id: salesEntryIds[0] || '',
          sales_order_no: relationLabel(schema, 'salesEntry', entriesById, salesEntryIds, 'orderNo') || asText(schema, 'salesDetail', record, 'salesEntry'),
          sold_at: asDate(soldAt)?.toISOString() || '',
          ...buildProductLabel(schema, productsById, productIds),
          size: asText(schema, 'salesDetail', record, 'size'),
          quantity: asNumber(fieldValue(schema, 'salesDetail', record, 'quantity')),
          paid_amount: asNumber(fieldValue(schema, 'salesDetail', record, 'paidAmount')),
          gift: asText(schema, 'salesDetail', record, 'gift'),
          payment_method: relationLabel(schema, 'paymentMethod', paymentsById, paymentIds, 'name') || asText(schema, 'salesDetail', record, 'paymentMethod'),
          sales_behavior: relationLabel(schema, 'behavior', behaviorsById, behaviorIds, 'name') || asText(schema, 'salesDetail', record, 'behavior'),
        };
      })
      .filter((row) => shanghaiDayKey(row.sold_at || now) === date)
      .sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)));

    const paymentSummary = {};
    const orderIds = new Set();
    const summary = rows.reduce((result, row) => {
      result.quantity += row.quantity;
      result.paid_amount += row.paid_amount;
      if (row.sales_entry_record_id) orderIds.add(row.sales_entry_record_id);
      const key = row.payment_method || '未填写';
      paymentSummary[key] = (paymentSummary[key] || 0) + row.paid_amount;
      return result;
    }, { detail_count: rows.length, order_count: 0, quantity: 0, paid_amount: 0 });
    summary.order_count = orderIds.size || rows.length;
    return { date, summary: { ...summary, payment_summary: paymentSummary }, rows };
  };

  const getLiveInventory = async ({ keyword = '', size = '' } = {}) => {
    const [inventory, products] = await Promise.all([gateway.listAll('liveInventory'), gateway.listAll('product')]);
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
        updated_at: asDate(fieldValue(schema, 'liveInventory', record, 'updatedAt'))?.toISOString() || '',
      };
    }).filter((row) => {
      const matchesKeyword = !normalizedKeyword || [row.stock_key, row.product_number, row.item_no, row.color].some((value) => String(value).toLowerCase().includes(normalizedKeyword));
      const matchesSize = !String(size).trim() || row.size === String(size).trim();
      return matchesKeyword && matchesSize;
    });
    const grouped = new Map();
    rawRows.forEach((row) => {
      const current = grouped.get(row.stock_key);
      if (current) {
        current.quantity += 1;
        if (row.updated_at > current.updated_at) current.updated_at = row.updated_at;
      } else {
        grouped.set(row.stock_key, { ...row, quantity: 1 });
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
