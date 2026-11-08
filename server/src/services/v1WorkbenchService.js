const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const {
  postedOf, isPosted, SALES_STATUS_VALUE_DOMAINS, SALES_STATUS_WRITE_VALUES,
} = require('../config/salesStatusDimensions');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { getConfigRows } = require('./configTableCache');
const { LIVE_STATES } = require('./inventoryService');
const {
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
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = typeof value === 'number' ? value : textValue(value).trim();
  if (raw === '') return null;
  const timestamp = typeof raw === 'number' || /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = timestamp === null ? new Date(raw) : new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

// 入参错误（她日期填错 / 范围太大）与系统错误分开：前者回 400 并原样告诉她，
// 后者回 502/500 且不回显内部细节。与 InventoryAdjustmentService 用同一个约定。

/**
 * ⭐⭐ 2026-10-14（业务负责人裁定 2）：工作台那一行**算不算"未完成"**。
 *
 *   incomplete = 销售状态 ∈ {未写入, 部分写入, 写入失败}
 *            或 库存状态 ∈ {未写入, 部分写入, 写入失败}
 *            或 资金状态 === 写入失败
 *
 * ⚠️ 资金"未写入"是**正常待补**（工作台本来就有"补记收款"）⇒ **不算**未完成 ✓；
 *    只有资金**写入失败**才是真失败 ✓。
 * 🔴 值域只从 `config/salesStatusDimensions.js` 取（**不写死中文** ✗）；拿不到 ⇒ **不猜**（返 false）✓。
 * ⚠️ 这只是**界面判据**：它**不**在表里新增"未完成"这个选项 ✗（"未完成，可点重试"是页面上的话 ✓）。
 */
const WRITE_VALUES = SALES_STATUS_WRITE_VALUES || {};
/** 语义键 → 取值：兼容"扁平"与"按维度嵌套"两种形状（值域真源在 config ✓）。 */
const writeValueOf = (dimension, key) => {
  const nested = WRITE_VALUES[dimension];
  if (nested && typeof nested === 'object' && nested[key]) return nested[key];
  return WRITE_VALUES[key];
};
const notDoneValues = (dimension) => {
  const done = writeValueOf(dimension, 'done');
  return new Set(((SALES_STATUS_VALUE_DOMAINS || {})[dimension] || []).filter((value) => value !== done));
};

const isOrderIncomplete = (row) => {
  if (!row || typeof row !== 'object') return false;
  const salesNotDone = notDoneValues('sales');
  const stockNotDone = notDoneValues('stock');
  if (typeof row.salesStatus === 'string' && salesNotDone.has(row.salesStatus)) return true;
  if (typeof row.stockStatus === 'string' && stockNotDone.has(row.stockStatus)) return true;
  return row.fundsStatus === writeValueOf('funds', 'failed');
};

const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

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

  // 工作台「盘点调整 / 换季调整」要按 货号 找货品：返回 record_id 供库存接口用。
  const findProducts = async ({ keyword = '', limit = WORKBENCH_PRODUCT_SEARCH_LIMIT, requestId } = {}) => {
    const products = await getConfigRows({ gateway, tableKey: 'product',
      loader: () => listAllWithRetry(gateway, 'product', requestId) });
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
      getConfigRows({ gateway, tableKey: 'product',
        loader: () => listAllWithRetry(gateway, 'product', requestId) }),
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
    getLiveInventory,
    findProducts,
    getInventoryStockLevels,
    listInventoryCategories,
  };
};

module.exports = {
  createWorkbenchService,
  isOrderIncomplete,
};
