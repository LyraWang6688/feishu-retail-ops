/**
 * 扫码页（第一版：**只读查库存**）的取数与聚合。
 *
 * 输入：`编号`（= `货号|颜色|类别`，扫码 URL 里那一段）。
 * 输出：一个**给渲染层用的视图模型**（身份 / 单价 / 每个尺码 × 每种状态的库存 / 缺码标记）。
 *
 * 🔴 **只读**：本文件只调 `gateway.listAll`（外加共享的 `SizeReferenceService` 读尺码表），
 *    全文件**没有任何 `create` / `update` / `delete`** ——
 *    这条链路是"扫码就能看"，写操作（补货 / 销售 / 验收）是下一版的事，
 *    而且必须落到 `入口隔离`（`docs/entry-isolation-2026-10-08.md`）允许共享的**业务处理层**去。
 *    `test/scanPage.test.js` 有一条用例**逐字扫这三个文件**，出现写调用就判红。
 *
 * 口径与降级（都是业务负责人拍过的，见 `config/scanPage.js` 的注释）：
 *   · 「实时库存」一双一条 ⇒ **数量 = 记录条数**（与工作台 `getLiveInventory` 同一口径）；
 *   · 缺码 = 「尺码管理」里**这个类别**有的尺码、但库存为 0；
 *   · 读不到「类别」列 / 这个类别没有尺码 ⇒ **降级**：只显示有库存的尺码 + warn（**不编造**）；
 *   · 状态里出现配置外的取值 / 读不出尺码 ⇒ **不丢**，另列一行/一列 + warn（"共 N 双"必须对得上）。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { SCAN_PAGE, fillText } = require('../config/scanPage');
const { logInfo, logWarn } = require('../utils/logger');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const fieldName = (schema, tableKey, semanticKey) => schema?.tables?.[tableKey]?.fields?.[semanticKey] || '';
const readField = (schema, tableKey, record, semanticKey) => {
  const name = fieldName(schema, tableKey, semanticKey);
  return name ? record?.fields?.[name] : undefined;
};

/**
 * 路由参数 → 编号。
 *
 * Express 已经对 `:number` 做过一次百分号解码，这里**再解**是为了容忍
 * "客户端把中文原样塞进路径 / 双重编码"这两种形状：
 *   · 只有"还看得见 `%XX`"才继续解（最多 `number.decodePasses` 次）；
 *   · 编号里出现孤立的 `%`（例：`50%OFF`）时**一个字都不动** ——
 *     `decodeURIComponent` 会抛，绝不让一个字符把整页打成 500。
 *
 * ⚠️ 只 trim 首尾：**颜色里可能真有空格**（`tagQrCodeService` 的用例里就有 `A B`），
 *    不能把中间的空格折叠掉，否则会与表里的编号对不上。
 */
const decodeScanNumber = (raw, config = SCAN_PAGE) => {
  let text = String(raw ?? '');
  const passes = Number.isInteger(config.number.decodePasses) && config.number.decodePasses > 0
    ? config.number.decodePasses
    : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    if (!/%[0-9A-Fa-f]{2}/.test(text)) break;
    try {
      const next = decodeURIComponent(text);
      if (next === text) break;
      text = next;
    } catch (_) {
      break;
    }
  }
  return text.trim();
};

/** 编号 → 三段。切不出第 3 段就没有类别（缺码判定随之降级）。 */
const parseNumberSegments = (number, config = SCAN_PAGE) => {
  const parts = String(number ?? '').split(config.number.separator);
  const { itemNo, color, category } = config.number.segment;
  return {
    itemNo: String(parts[itemNo] ?? '').trim(),
    color: String(parts[color] ?? '').trim(),
    categoryCode: String(parts[category] ?? '').trim(),
  };
};

const positiveInteger = (value) => {
  const text = typeof value === 'number' ? String(value) : textValue(value).trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
};

/**
 * 「尺码管理.类别」的取值 → 一组类别。
 *
 * ⚠️ 本机测试 Base（生产同形状）只读实测：这一列是**多选**（`type=4`，选项 A/B），
 *    记录 API 回的是**数组**（例：`['A','B']` = 这个尺码男女鞋都用）。
 *    ⇒ 判断"这个尺码属不属于类别 X"必须是**成员判断**，不能拿整格文本做等号比较
 *      （`'A,B' === 'A'` 永远不成立 —— 那会让 38 码在男鞋里变成"缺码"，是错的）。
 *    单选/文本形状（`'A'`）也一并认，防的是"她哪天把这一列改成单选"。
 */
const categoryValues = (cell) => {
  const values = Array.isArray(cell) ? cell : [cell];
  return values
    .flatMap((value) => (Array.isArray(value) ? value : String(value ?? '').split(/[,，、;；\s]+/)))
    .map((value) => textValue(value).trim())
    .filter(Boolean);
};

const asAmount = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = textValue(value).replace(/[¥,\s]/g, '');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 金额文案：整数不补零（`¥399`），带角分才显示小数（`¥399.50`）。 */
const formatPrice = (value, config = SCAN_PAGE) => {
  if (value === null || value === undefined) return config.texts.missingValue;
  const decimals = Number.isInteger(config.price.decimals) && config.price.decimals >= 0 ? config.price.decimals : 2;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(decimals);
  return `${config.price.prefix}${text}`;
};

/** 飞书时间字段 → 毫秒（Date / 数字 / 数字串 / 可解析文本都认；读不出回 0）。 */
const asTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = textValue(value).trim();
  if (!text) return 0;
  if (/^\d{10,13}$/.test(text)) {
    const number = Number(text);
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * 毫秒 → 上海时间文案（**UTC+8**）。
 * ⚠️ 服务端日志是 UTC，但**给她看的**一律 +8（AGENTS.md《协作纪律》第 6 条）。
 */
const shanghaiDateTimeText = (timestamp) => {
  if (!timestamp) return '';
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
};

const sortSizes = (sizes) => [...sizes].sort((left, right) => {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'zh-CN');
});

/** 上限超了：**明确报错**，不静默截断（截断出来的库存表是错的数据，比打不开更坏）。 */
const limitError = (tableName, actual, limit) => {
  const error = new Error(`「${tableName}」有 ${actual} 条记录，超过本页本次可读上限 ${limit}`);
  error.scanLimitExceeded = true;
  return error;
};

const createScanPageService = (gateway, options = {}) => {
  if (!gateway) throw new Error('ScanPageService requires gateway');
  const schema = options.schema || V1_BITABLE_SCHEMA;
  const config = options.config || SCAN_PAGE;
  const getSizeReferences = createSizeReferenceAccess({ gateway, sizeReferences: options.sizeReferences });
  const limits = config.limits;

  const tableName = (tableKey) => schema?.tables?.[tableKey]?.tableName || tableKey;

  const readAllCapped = async (tableKey, cap, requestId) => {
    const records = await gateway.listAll(tableKey);
    if (cap > 0 && records.length > cap) {
      logWarn(config.events.limitExceeded, {
        request_id: requestId, table_key: tableKey, records: records.length, limit: cap,
      });
      throw limitError(tableName(tableKey), records.length, cap);
    }
    return records;
  };

  const findProduct = (products, number) => {
    const numberField = fieldName(schema, 'product', 'number');
    if (!numberField) return null;
    const exact = products.find((record) => textValue(record?.fields?.[numberField]).trim() === number);
    if (exact) return exact;
    if (!config.number.caseInsensitiveFallback) return null;
    const lower = number.toLowerCase();
    return products.find((record) => textValue(record?.fields?.[numberField]).trim().toLowerCase() === lower) || null;
  };

  /**
   * 一条「实时库存」属于不属于这个编号？
   *   ① 首选**关联记录 id**（「实时库存.编号」→「货品信息」）—— 这是权威判据；
   *   ② 关联单元格为空时，用「库存键」公式（`货号|颜色|类别|尺码`）的**前缀**兜底
   *      —— 只在"关联被清空、但公式还在"这种数据残缺时才生效，不会重复计数。
   */
  const belongsToNumber = (record, { productId, number, stockKeyField }) => {
    const ids = linkedRecordIds(readField(schema, 'liveInventory', record, 'product'));
    if (productId && ids.includes(productId)) return true;
    if (ids.length || !config.number.stockKeyPrefixFallback || !stockKeyField) return false;
    const key = textValue(record?.fields?.[stockKeyField]).trim();
    return key.startsWith(`${number}${config.number.separator}`);
  };

  /** 一行的尺码：关联记录（共享解析，带 30 秒缓存）→ 「库存键」最后一段 → 读不出。 */
  const resolveRowSize = async (record, stockKeyField) => {
    const cell = readField(schema, 'liveInventory', record, 'size');
    try {
      const entry = await getSizeReferences().resolveLinkedCell(cell);
      return entry.size;
    } catch (_) {
      if (!stockKeyField) return null;
      const key = textValue(record?.fields?.[stockKeyField]).trim();
      if (!key) return null;
      const parts = key.split(config.number.separator);
      return positiveInteger(parts[parts.length - 1]);
    }
  };

  /**
   * 缺码判定用的尺码清单：**「尺码管理」里这个「类别」（A/B）的全部尺码**。
   * 拿不到就降级（`degraded: true`），由调用方改成"只显示有库存的尺码"。
   */
  const loadSizeScope = async ({ sizeRecords, categoryCode }) => {
    const sizeField = fieldName(schema, 'sizeManagement', 'size');
    const categoryField = config.fieldNamesPendingSchema?.sizeCategory || '';
    const byCategory = new Map();
    for (const record of sizeRecords) {
      const categories = categoryField ? categoryValues(record?.fields?.[categoryField]) : [];
      const size = positiveInteger(readField(schema, 'sizeManagement', record, 'size') ?? record?.fields?.[sizeField]);
      if (!categories.length || size === null) continue;
      for (const category of categories) {
        if (!byCategory.has(category)) byCategory.set(category, new Set());
        byCategory.get(category).add(size);
      }
    }
    if (!categoryField || !byCategory.size) return { degraded: true, reason: 'no_category_column', sizes: [] };
    if (!categoryCode) return { degraded: true, reason: 'number_without_category', sizes: [] };
    if (!byCategory.has(categoryCode)) return { degraded: true, reason: 'no_sizes_for_category', sizes: [] };
    return { degraded: false, reason: '', sizes: sortSizes([...byCategory.get(categoryCode)]) };
  };

  /**
   * 查一个编号。
   * 返回 `{ found: false, number, reason }`（`reason`: `empty` / `unknown`）或
   *      `{ found: true, ...视图模型 }`。
   */
  const lookup = async ({ number: rawNumber, requestId } = {}) => {
    const number = decodeScanNumber(rawNumber, config);
    if (!number) return { found: false, number, reason: 'empty' };

    const products = await readAllCapped('product', limits.productRecords, requestId);
    const product = findProduct(products, number);
    if (!product) {
      logInfo(config.events.notFound, { request_id: requestId, number });
      return { found: false, number, reason: 'unknown' };
    }

    const parsed = parseNumberSegments(number, config);
    const stockKeyField = fieldName(schema, 'liveInventory', 'stockKey');
    const productId = product.record_id || '';
    const inventory = await readAllCapped('liveInventory', limits.inventoryRecords, requestId);
    const rows = inventory.filter((record) => belongsToNumber(record, { productId, number, stockKeyField }));

    const stateField = fieldName(schema, 'liveInventory', 'state');
    const updatedAtField = fieldName(schema, 'liveInventory', 'updatedAt');
    const inventoryCategoryField = fieldName(schema, 'liveInventory', 'category');
    const buckets = new Map();
    const stateCounts = new Map();
    const unresolvedByState = new Map();
    let unresolvedRows = 0;
    let inventoryCategory = '';
    let updatedAt = 0;

    for (const record of rows) {
      const size = await resolveRowSize(record, stockKeyField);
      const state = stateField ? textValue(record?.fields?.[stateField]).trim() : '';
      stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
      const timestamp = updatedAtField ? asTimestamp(record?.fields?.[updatedAtField]) : 0;
      if (timestamp > updatedAt) updatedAt = timestamp;
      if (!inventoryCategory && inventoryCategoryField) {
        inventoryCategory = textValue(record?.fields?.[inventoryCategoryField]).trim();
      }
      if (size === null) {
        unresolvedRows += 1;
        unresolvedByState.set(state, (unresolvedByState.get(state) || 0) + 1);
        continue;
      }
      const bucket = buckets.get(size) || { size, counts: new Map() };
      bucket.counts.set(state, (bucket.counts.get(state) || 0) + 1);
      buckets.set(size, bucket);
    }
    const total = rows.length;

    const sizeRecords = await readAllCapped('sizeManagement', limits.sizeRecords, requestId);
    const scope = await loadSizeScope({ sizeRecords, categoryCode: parsed.categoryCode });
    if (!scope.degraded) {
      // 只有**没有库存**的那些清单尺码才需要限流：有库存的尺码一行都不许丢，
      // 否则"共 N 双"会与明细对不上。
      const stockSizes = new Set(buckets.keys());
      const scopeOnly = scope.sizes.filter((size) => !stockSizes.has(size));
      if (scopeOnly.length > limits.sizesPerNumber) {
        scope.sizes = scope.sizes.filter((size) => stockSizes.has(size) || scopeOnly.indexOf(size) < limits.sizesPerNumber);
        scope.truncated = true;
      }
    }
    if (scope.degraded) {
      logWarn(config.events.sizesDegraded, {
        request_id: requestId, number, category: parsed.categoryCode, reason: scope.reason,
      });
    }

    const configuredStates = config.states.columns;
    const extraStates = [...stateCounts.keys()].filter((state) => state && !configuredStates.includes(state));
    const columns = [
      ...configuredStates.map((state) => ({ key: state, label: state })),
      ...extraStates.map((state) => ({ key: state, label: state })),
    ];
    const emptyStateRows = stateCounts.get('') || 0;
    if (emptyStateRows) columns.push({ key: '', label: config.states.emptyLabel });
    const unexpectedStateRows = extraStates.reduce((sum, state) => sum + (stateCounts.get(state) || 0), 0);
    if (unexpectedStateRows) {
      logWarn(config.events.unknownState, {
        request_id: requestId, number, states: extraStates, records: unexpectedStateRows,
      });
    }
    if (unresolvedRows) {
      logWarn(config.events.unknownSize, { request_id: requestId, number, records: unresolvedRows });
    }

    // `counts` 可能是 `undefined`：**缺码那一行**（清单里有、库存一条都没有）根本没有 bucket。
    const countOf = (counts, state) => (counts ? counts.get(state) || 0 : 0);
    const scopeSet = new Set(scope.sizes);
    const renderSizes = sortSizes([...new Set([...buckets.keys(), ...scope.sizes])]);
    const viewRows = renderSizes.map((size) => {
      const bucket = buckets.get(size);
      const cells = columns.map((column) => ({ key: column.key, count: countOf(bucket?.counts, column.key) }));
      const rowTotal = cells.reduce((sum, cell) => sum + cell.count, 0);
      return {
        size_text: String(size),
        cells,
        total: rowTotal,
        // 缺码 = 这个尺码在「尺码管理」的该类别清单里、但三种状态都没有库存。
        missing: Boolean(config.missingSize.enabled && !scope.degraded && scopeSet.has(size) && rowTotal === 0),
      };
    });
    if (unresolvedRows) {
      viewRows.push({
        size_text: config.texts.unknownSizeLabel,
        cells: columns.map((column) => ({ key: column.key, count: countOf(unresolvedByState, column.key) })),
        total: unresolvedRows,
        missing: false,
        unknown_size: true,
      });
    }

    const notes = [];
    if (scope.degraded) notes.push(config.texts.degradedSizesNote);
    if (scope.truncated) notes.push(fillText(config.texts.truncatedSizesNote, { count: limits.sizesPerNumber }));
    if (unexpectedStateRows) notes.push(fillText(config.texts.unknownStateNote, { count: unexpectedStateRows }));
    if (unresolvedRows) notes.push(fillText(config.texts.unknownSizeNote, { count: unresolvedRows }));
    const missingCount = viewRows.filter((row) => row.missing).length;
    if (missingCount) notes.push(config.missingSize.hint);

    const productText = (semanticKey) => textValue(readField(schema, 'product', product, semanticKey)).trim();
    const categoryNameField = config.fieldNamesPendingSchema?.productCategoryName || '';
    const view = {
      found: true,
      number,
      item_no: productText('itemNo') || parsed.itemNo,
      color: productText('color') || parsed.color,
      category_code: productText('category') || parsed.categoryCode,
      // 「品类」（休闲鞋 / 单鞋…）：优先「货品信息.品类」，再退「实时库存.品类」公式。
      category_name: (categoryNameField ? textValue(product?.fields?.[categoryNameField]).trim() : '') || inventoryCategory,
      price_text: formatPrice(asAmount(readField(schema, 'product', product, 'price')), config),
      total,
      columns: columns.map((column) => ({ key: column.key, label: column.label })),
      rows: viewRows,
      missing_count: missingCount,
      sizes_degraded: scope.degraded,
      scope_reason: scope.reason,
      notes,
      updated_at_text: updatedAt ? shanghaiDateTimeText(updatedAt) : config.texts.updatedAtUnknown,
      product_record_id: productId,
    };

    logInfo(config.events.viewed, {
      request_id: requestId,
      number,
      product_record_id: productId,
      total,
      sizes: viewRows.length,
      missing: missingCount,
      sizes_degraded: scope.degraded,
    });
    return view;
  };

  return { lookup };
};

module.exports = {
  createScanPageService,
  decodeScanNumber,
  parseNumberSegments,
  formatPrice,
  shanghaiDateTimeText,
  sortSizes,
};
