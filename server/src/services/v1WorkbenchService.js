const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_STATUS_VALUE_DOMAINS, SALES_STATUS_WRITE_VALUES } = require('../config/salesStatusDimensions');
const {textValue} = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { getConfigRows } = require('./configTableCache');
const { LIVE_STATES } = require('./inventoryService');
const { WORKBENCH_CATEGORY_LIMIT } = require('../config/workbenchQuery');
const { logWarn } = require('../utils/logger');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const fieldValue = (schema, tableKey, record, semanticKey) => {
  const fieldName = schema.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? record?.fields?.[fieldName] : undefined;
};

const asText = (schema, tableKey, record, semanticKey) => textValue(fieldValue(schema, tableKey, record, semanticKey)).trim();
const asLinks = (schema, tableKey, record, semanticKey) => strictLinkedRecordIds(fieldValue(schema, tableKey, record, semanticKey));
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

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// 读表瞬时错误重试：判据与订单列表/扫码页同一份（config/orderReadRetry → pushRetry），
// 不另写第二套。覆盖飞书 1254607、HTTP 429/5xx（含 504）与网络类错误。
const { resolveOrderReadRetryConfig, isRetriableOrderReadError } = require('../config/orderReadRetry');
const listAllWithRetry = async (gateway, tableKey, requestId) => {
  const retry = resolveOrderReadRetryConfig();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await gateway.listAll(tableKey, { retry: false });
    } catch (error) {
      if (!isRetriableOrderReadError(error) || attempt >= retry.maxRetries) throw error;
      const delayMs = Math.max(0, Number(retry.delayMs)) * (attempt + 1);
      logWarn('workbench.query.retry', {
        request_id: requestId,
        table_key: tableKey,
        attempt: attempt + 1,
        of: retry.maxRetries + 1,
        delay_ms: delayMs,
        reason: 'transient_read',
      });
      if (delayMs > 0) await wait(delayMs);
    }
  }
};

/**
 * 「实时库存」读统一走配置表快照（5 分钟 TTL，record_changed/写操作失效）。
 * 库存状态页、品类清单、盘点调整共用同一份，不再每次整表读飞书。
 */
const readLiveInventory = (gateway, requestId) => getConfigRows({
  gateway,
  tableKey: 'liveInventory',
  loader: () => listAllWithRetry(gateway, 'liveInventory', requestId),
});

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

  // 「换季调整（按品类批量）」的品类清单：走统一配置表缓存（品类管理），
  // 不再整表读 1335 行实时库存。
  const listInventoryCategories = async ({ requestId, limit = WORKBENCH_CATEGORY_LIMIT } = {}) => {
    const records = await getConfigRows({
      gateway, tableKey: 'category',
      loader: () => listAllWithRetry(gateway, 'category', requestId),
    });
    const names = new Set();
    for (const record of records) {
      const name = asText(schema, 'category', record, 'name');
      if (name) names.add(name);
    }
    const rows = [...names]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .slice(0, limit)
      .map((category) => ({ category }));
    return { rows, total: names.size };
  };

  const getLiveInventory = async ({ keyword = '', size = '', requestId } = {}) => {
    const [inventory, products] = await Promise.all([
      getConfigRows({ gateway, tableKey: 'liveInventory',
        loader: () => listAllWithRetry(gateway, 'liveInventory', requestId) }),
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
        season: fieldValue(schema, 'liveInventory', record, 'season') === true,
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
    listInventoryCategories,
  };
};

module.exports = {
  createWorkbenchService,
  isOrderIncomplete,
};
