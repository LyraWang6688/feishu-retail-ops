'use strict';

/**
 * 库存总览（只读）聚合（2026-11-25）。
 *
 * 两段数据源：
 *   · 库存现状 = 实时库存快照（品类取实时库存的公式列；类别 / 供应商按「编号」
 *     join「货品信息」，不另存一份口径）；
 *   · 库存变动 = 库存流水按「创建时间」区间聚合，行为方向取「行为管理.库存方向」
 *     （增加=入库 / 减少=出库 / 不影响=状态调整，不计入进出）。
 *
 * 纯读：不写任何表。写库路径一个字都不碰。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { INVENTORY_ANALYSIS } = require('../config/inventoryAnalysis');
const { textValue } = require('./v1BitableGateway');
const { strictLinkedRecordIds } = require('./strictLinkIds');
const { getConfigRows } = require('./configTableCache');
const { dateRangeFormula } = require('./bitableFilterFormula');
const { CRITICAL_READ_RETRY } = require('../config/gatewayReadRetry');
const { logWarn } = require('../utils/logger');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86400000;

const toDate = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = typeof value === 'number' ? value : textValue(value).trim();
  if (raw === '') return null;
  const timestamp = typeof raw === 'number' || /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = timestamp === null ? new Date(raw) : new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};
const dayKey = (date) => new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
const todayKey = (now) => dayKey(now);
const asNumber = (value) => {
  const parsed = Number(textValue(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

const createInventoryAnalysisService = ({ gateway, now = () => new Date() } = {}) => {
  if (!gateway) throw new Error('InventoryAnalysisService requires gateway');
  const schema = V1_BITABLE_SCHEMA;

  // 语义键 → 物理列名：可写字段与只读字段都认。
  const fieldName = (tableKey, semanticKey) => {
    const table = schema.tables[tableKey] || {};
    if (table.fields && table.fields[semanticKey]) return table.fields[semanticKey];
    const readOnly = table.readOnlyFields && table.readOnlyFields[semanticKey];
    return readOnly && readOnly.name ? readOnly.name : '';
  };

  const readLiveRecords = async () => {
    const loader = () => gateway.listAll('liveInventory', { retry: CRITICAL_READ_RETRY });
    try {
      // 「实时」口径：查询时强制重读快照；成功后同时刷新共享缓存。
      return await getConfigRows({ gateway, tableKey: 'liveInventory', loader, freshness: 'fresh' });
    } catch (error) {
      // 关键读重试后仍失败 ⇒ 退回最后一次成功快照（有旧数据比整页报错好），但要留告警。
      logWarn('workbench.inventory.overview_snapshot_fallback', {
        error: String((error && error.message) || error).slice(0, 200),
      });
      return getConfigRows({ gateway, tableKey: 'liveInventory', loader });
    }
  };

  const readBehaviorMap = async () => {
    const rows = await getConfigRows({
      gateway,
      tableKey: 'behavior',
      loader: () => gateway.listAll('behavior', { retry: CRITICAL_READ_RETRY }),
    });
    const nameField = fieldName('behavior', 'name');
    const directionField = fieldName('behavior', 'stockDirection');
    const map = new Map();
    for (const record of rows || []) {
      const fields = record.fields || {};
      map.set(record.record_id, {
        name: textValue(fields[nameField]).trim(),
        direction: textValue(fields[directionField]).trim(),
      });
    }
    return map;
  };

  // 类别 / 供应商 不在实时库存的 schema 映射里：从「货品信息」按 recordId join
  // （product.类别 是单选、product.供应商 是关联到「供应商管理」），与采购查询同一套写法。
  const readProductIndex = async () => {
    const [products, suppliers] = await Promise.all([
      getConfigRows({
        gateway,
        tableKey: 'product',
        loader: () => gateway.listAll('product', { retry: CRITICAL_READ_RETRY }),
      }),
      getConfigRows({
        gateway,
        tableKey: 'supplier',
        loader: () => gateway.listAll('supplier', { retry: CRITICAL_READ_RETRY }),
      }),
    ]);
    const supplierNameField = fieldName('supplier', 'name');
    const supplierNames = new Map((suppliers || []).map((record) => [
      record.record_id,
      textValue((record.fields || {})[supplierNameField]).trim(),
    ]));
    const productClassField = fieldName('product', 'category');
    const productSupplierField = fieldName('product', 'supplier');
    const index = new Map();
    for (const record of products || []) {
      const fields = record.fields || {};
      const supplierIds = strictLinkedRecordIds(fields[productSupplierField]);
      index.set(record.record_id, {
        classType: textValue(fields[productClassField]).trim(),
        supplier: supplierIds.length ? (supplierNames.get(supplierIds[0]) || '') : '',
      });
    }
    return index;
  };

  const buildSnapshot = (records, productIndex) => {
    const productField = fieldName('liveInventory', 'product');
    const seasonField = fieldName('liveInventory', 'season');
    const stateField = fieldName('liveInventory', 'state');
    const categoryField = fieldName('liveInventory', 'category');

    const totalStyles = new Set();
    const currentStyles = new Set();
    const offStyles = new Set();
    let totalPairs = 0;
    let currentPairs = 0;
    let offPairs = 0;
    const stateCounts = new Map();
    INVENTORY_ANALYSIS.stateBuckets.forEach((bucket) => stateCounts.set(bucket.key, 0));
    let otherStatePairs = 0;
    const dims = { category: new Map(), classType: new Map(), supplier: new Map() };
    const missing = { category_pairs: 0, classType_pairs: 0, supplier_pairs: 0 };

    const addDimension = (key, rawName, productId) => {
      const name = String(rawName || '').trim();
      if (!name) missing[key + '_pairs'] += 1;
      const label = name || INVENTORY_ANALYSIS.unknownLabel;
      if (!dims[key].has(label)) dims[key].set(label, { name: label, pairs: 0, styles: new Set() });
      const entry = dims[key].get(label);
      entry.pairs += 1;
      if (productId) entry.styles.add(productId);
    };

    for (const record of records || []) {
      const fields = (record && record.fields) || {};
      const productIds = strictLinkedRecordIds(fields[productField]);
      const productId = productIds[0] || '';
      totalPairs += 1;
      if (productId) totalStyles.add(productId);
      const isCurrent = fields[seasonField] === true;
      if (!isCurrent) {
        offPairs += 1;
        if (productId) offStyles.add(productId);
        continue;
      }
      currentPairs += 1;
      if (productId) currentStyles.add(productId);

      const state = textValue(fields[stateField]).trim();
      const bucket = INVENTORY_ANALYSIS.stateBuckets.find((item) => item.values.includes(state));
      if (bucket) stateCounts.set(bucket.key, (stateCounts.get(bucket.key) || 0) + 1);
      else otherStatePairs += 1;

      const product = productIndex.get(productId) || null;
      addDimension('category', textValue(fields[categoryField]), productId);
      addDimension('classType', product ? product.classType : '', productId);
      addDimension('supplier', product ? product.supplier : '', productId);
    }

    const rowsOf = (map) => [...map.values()]
      .map((entry) => ({
        name: entry.name,
        pairs: entry.pairs,
        styles: entry.styles.size,
        share: currentPairs ? Math.round((entry.pairs / currentPairs) * 1000) / 1000 : 0,
      }))
      .sort((left, right) => right.pairs - left.pairs
        || right.styles - left.styles
        || left.name.localeCompare(right.name, 'zh-CN'));

    const states = INVENTORY_ANALYSIS.stateBuckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      pairs: stateCounts.get(bucket.key) || 0,
    }));
    if (otherStatePairs) {
      states.push({ key: 'other', label: INVENTORY_ANALYSIS.otherStateLabel, pairs: otherStatePairs });
    }

    return {
      total: { pairs: totalPairs, styles: totalStyles.size },
      seasons: {
        current: {
          key: 'current',
          label: INVENTORY_ANALYSIS.seasonLabels.current,
          pairs: currentPairs,
          styles: currentStyles.size,
        },
        off: {
          key: 'off',
          label: INVENTORY_ANALYSIS.seasonLabels.off,
          pairs: offPairs,
          styles: offStyles.size,
        },
      },
      current: {
        pairs: currentPairs,
        styles: currentStyles.size,
        states,
        by_category: rowsOf(dims.category),
        by_class: rowsOf(dims.classType),
        by_supplier: rowsOf(dims.supplier),
      },
      missing: {
        season: 'current',
        category_pairs: missing.category_pairs,
        class_pairs: missing.classType_pairs,
        supplier_pairs: missing.supplier_pairs,
      },
    };
  };

  const validateRange = (from, to) => {
    const today = todayKey(now());
    const fromText = String(from || today).trim();
    const toText = String(to || today).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromText) || !/^\d{4}-\d{2}-\d{2}$/.test(toText) || fromText > toText) {
      throw badRequest(INVENTORY_ANALYSIS.invalidRangeMessage);
    }
    const days = Math.round((Date.parse(toText + 'T00:00:00Z') - Date.parse(fromText + 'T00:00:00Z')) / DAY_MS) + 1;
    if (!Number.isFinite(days) || days < 1 || days > INVENTORY_ANALYSIS.maxRangeDays) {
      throw badRequest(INVENTORY_ANALYSIS.invalidRangeMessage);
    }
    return { from: fromText, to: toText, today, days };
  };

  const readLedgerRows = async ({ from, to, today }) => {
    const createdAtField = fieldName('inventoryLedger', 'ledgerCreatedAt');
    const behaviorField = fieldName('inventoryLedger', 'behavior');
    const quantityField = fieldName('inventoryLedger', 'quantityChange');
    const fieldNames = [behaviorField, quantityField, createdAtField].filter(Boolean);
    const cap = INVENTORY_ANALYSIS.maxLedgerRecords;
    let records = null;
    const filter = dateRangeFormula(createdAtField, from, to, today);
    if (filter && typeof gateway.listByFilter === 'function') {
      try {
        records = await gateway.listByFilter('inventoryLedger', filter, {
          fieldNames,
          retry: CRITICAL_READ_RETRY,
          maxRecords: cap + 1,
        });
      } catch (error) {
        // 条件读失败 ⇒ 回退整表再本地按上海日期过滤（慢一次，但对）。
        logWarn('workbench.inventory.overview_filter_fallback', {
          from,
          to,
          error: String((error && error.message) || error).slice(0, 200),
        });
      }
    }
    if (!Array.isArray(records)) {
      records = await gateway.listAll('inventoryLedger', { fieldNames, retry: CRITICAL_READ_RETRY });
    }
    const inRange = (records || [])
      .map((record) => ({ record, date: toDate((record.fields || {})[createdAtField]) }))
      .filter((item) => {
        if (!item.date) return false;
        const key = dayKey(item.date);
        return key >= from && key <= to;
      })
      // 超上限时保留最近的那些（与库存流水页同一个倒序观感）。
      .sort((left, right) => right.date.getTime() - left.date.getTime());
    const truncated = inRange.length > cap;
    return {
      rows: (truncated ? inRange.slice(0, cap) : inRange).map((item) => item.record),
      truncated,
    };
  };

  const buildChange = ({ rows, truncated, behaviorMap, from, to }) => {
    const behaviorField = fieldName('inventoryLedger', 'behavior');
    const quantityField = fieldName('inventoryLedger', 'quantityChange');
    const groups = INVENTORY_ANALYSIS.groups.map((group) => ({
      key: group.key,
      label: group.label,
      direction: group.direction,
      records: 0,
      pairs: 0,
      behaviors: new Map(),
    }));
    const byKey = new Map(groups.map((group) => [group.key, group]));
    let stateAnomalies = 0;

    for (const record of rows) {
      const fields = record.fields || {};
      const behaviorIds = strictLinkedRecordIds(fields[behaviorField]);
      const behaviorId = behaviorIds[0] || '';
      const behavior = behaviorMap.get(behaviorId) || null;
      const direction = behavior ? behavior.direction : '';
      let groupKey = 'unknown';
      if (direction === INVENTORY_ANALYSIS.directions.increase) groupKey = 'inbound';
      else if (direction === INVENTORY_ANALYSIS.directions.decrease) groupKey = 'outbound';
      else if (direction === INVENTORY_ANALYSIS.directions.none) groupKey = 'state';
      const group = byKey.get(groupKey);
      const quantity = asNumber(fields[quantityField]);
      group.records += 1;
      group.pairs += quantity;

      const name = (behavior && behavior.name) || INVENTORY_ANALYSIS.unknownLabel;
      const itemKey = behaviorId || name;
      if (!group.behaviors.has(itemKey)) {
        group.behaviors.set(itemKey, { key: itemKey, name, records: 0, pairs: 0 });
      }
      const item = group.behaviors.get(itemKey);
      item.records += 1;
      item.pairs += quantity;

      // 状态类按口径数量恒 0；真出现非 0 要能被发现（页面只记笔数，不并进进出）。
      if (groupKey === 'state' && quantity !== 0) stateAnomalies += 1;
    }

    const sortedGroups = groups.map((group) => ({
      key: group.key,
      label: group.label,
      direction: group.direction,
      records: group.records,
      pairs: group.pairs,
      behaviors: [...group.behaviors.values()].sort((left, right) => right.pairs - left.pairs
        || right.records - left.records
        || left.name.localeCompare(right.name, 'zh-CN')),
    }));
    const inbound = byKey.get('inbound');
    const outbound = byKey.get('outbound');
    return {
      from,
      to,
      inbound: { records: inbound.records, pairs: inbound.pairs },
      outbound: { records: outbound.records, pairs: outbound.pairs },
      net_pairs: inbound.pairs - outbound.pairs,
      groups: sortedGroups,
      truncated,
      limit: INVENTORY_ANALYSIS.maxLedgerRecords,
      state_anomalies: stateAnomalies,
    };
  };

  const getOverview = async ({ from = '', to = '' } = {}) => {
    const range = validateRange(from, to);
    const [liveRecords, behaviorMap, ledger, productIndex] = await Promise.all([
      readLiveRecords(),
      readBehaviorMap(),
      readLedgerRows(range),
      readProductIndex(),
    ]);
    return {
      range: { from: range.from, to: range.to, days: range.days },
      snapshot: buildSnapshot(liveRecords, productIndex),
      change: buildChange({
        rows: ledger.rows,
        truncated: ledger.truncated,
        behaviorMap,
        from: range.from,
        to: range.to,
      }),
    };
  };

  return { getOverview };
};

module.exports = { createInventoryAnalysisService };
