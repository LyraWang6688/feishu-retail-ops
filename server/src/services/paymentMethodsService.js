'use strict';

/**
 * 收款方式候选：**唯一数据源 = 「收款方式管理」表**（只读 ✓ 不写表 ✗）。
 *
 * 读取统一走 `configTableCache.getConfigRows()`：
 *   · TTL 内复用同一份快照；
 *   · 飞书 record_changed 命中配置表 ⇒ `invalidateConfigTable` 后下一次重读；
 *   · 读失败返回 lastGood；从未成功过才抛。
 * 🔴 本文件**不再维护自己的 cache**（否则事件失效会被外层旧列表挡住）。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { textValue, linkedRecordIds } = require('./v1BitableGateway');
const { getConfigRows } = require('./configTableCache');

/** 配置默认方式**只在表里真实存在时**排第一；否则用表里第一项。 */
const orderWithPreferred = (items = [], preferred = '') => {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return preferred && list.includes(preferred)
    ? [preferred, ...list.filter((item) => item !== preferred)]
    : list;
};

const createPaymentMethodsService = (gateway, options = {}) => {
  if (!gateway) throw new Error('PaymentMethodsService requires gateway');
  const tableKey = options.tableKey || 'paymentMethod';
  const fieldName = options.fieldName || V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.name || '收款方式';
  const voucherFieldName = options.voucherFieldName || V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.voucher || '';
  const orderFieldName = options.orderFieldName || V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.order || '';
  const ttlMs = options.ttlMs === undefined ? 30 * 60 * 1000 : Number(options.ttlMs);
  const now = options.now || (() => Date.now());

  const orderOf = (row) => {
    if (!orderFieldName) return Number.POSITIVE_INFINITY;
    const raw = textValue(row?.fields?.[orderFieldName]).trim();
    if (!raw) return Number.POSITIVE_INFINITY;
    const number = Number(raw);
    return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
  };

  const rowsToItems = (rows = []) => {
    const items = [];
    const detailed = [];
    const seen = new Set();
    const ordered = (rows || []).map((row, index) => ({ row, index, order: orderOf(row) }))
      .sort((a, b) => (a.order - b.order) || (a.index - b.index));
    for (const { row } of ordered) {
      const value = textValue(row?.fields?.[fieldName]).trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      items.push(value);
      detailed.push({
        name: value,
        recordId: String(row?.record_id || ''),
        voucherRecordId: voucherFieldName ? String(linkedRecordIds(row?.fields?.[voucherFieldName])[0] || '') : '',
      });
    }
    return { items, detailed };
  };

  const load = async () => {
    try {
      const rows = await getConfigRows({ gateway, tableKey, ttlMs, now });
      return { ok: true, ...rowsToItems(rows) };
    } catch (error) {
      return { ok: false, items: [], detailed: [], reason: 'payment_methods_unreadable', error: error?.message || 'unknown' };
    }
  };

  /** 名称那份（去重、去空、按表顺序）。 */
  const list = async () => {
    const loaded = await load();
    return loaded.ok
      ? { ok: true, items: loaded.items }
      : { ok: false, items: [], reason: loaded.reason, error: loaded.error };
  };

  /** 带券关联那份（与 list 同一份快照、同一套排序）。 */
  const listWithVouchers = async () => {
    const loaded = await load();
    return loaded.ok
      ? { ok: true, items: loaded.detailed }
      : { ok: false, items: [], reason: loaded.reason, error: loaded.error };
  };

  return { list, listWithVouchers, tableKey, fieldName, voucherFieldName, ttlMs };
};

module.exports = { createPaymentMethodsService, orderWithPreferred };
