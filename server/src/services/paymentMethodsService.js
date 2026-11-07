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
const { PAYMENT_METHODS } = require('../config/paymentMethods');

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
  // ⭐ 2026-11-08（业务负责人：售后能不能用哪些支付方式也做成配置）：
  //   「支付方式管理」可选加一列（默认名「可用于退款」，勾选框）——
  //   · **这一列不存在** ⇒ 全部可用（向后兼容：生产还没加这列时行为不变）；
  //   · 勾了 ⇒ 可用于退款；没勾 ⇒ 售后「直接退款」下拉里不出现、提交也会被拦。
  //   ⚠️ 列名可配（env `PAYMENT_METHOD_REFUNDABLE_FIELD`），代码里不绑死。
  const refundableFieldName = options.refundableFieldName || PAYMENT_METHODS.refundableField;

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
    // 列存在才按它过滤；不存在 ⇒ refundable 一律 true（= 今天的行为）
    const columnExists = (rows || []).some((row) =>
      row?.fields && Object.prototype.hasOwnProperty.call(row.fields, refundableFieldName));
    const seen = new Set();
    const ordered = (rows || []).map((row, index) => ({ row, index, order: orderOf(row) }))
      .sort((a, b) => (a.order - b.order) || (a.index - b.index));
    for (const { row } of ordered) {
      const value = textValue(row?.fields?.[fieldName]).trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      items.push(value);
      const refundable = columnExists ? row?.fields?.[refundableFieldName] === true : true;
      detailed.push({
        name: value,
        recordId: String(row?.record_id || ''),
        voucherRecordId: voucherFieldName ? String(linkedRecordIds(row?.fields?.[voucherFieldName])[0] || '') : '',
        refundable,
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

  /** 可用于「直接退款」的方式（给售后下拉用；列不存在时 = 全部）。 */
  const listRefundable = async () => {
    const loaded = await load();
    return loaded.ok
      ? { ok: true, items: loaded.detailed.filter((item) => item.refundable !== false) }
      : { ok: false, items: [], reason: loaded.reason, error: loaded.error };
  };

  return { list, listWithVouchers, listRefundable, tableKey, fieldName, voucherFieldName, refundableFieldName, ttlMs };
};

module.exports = { createPaymentMethodsService, orderWithPreferred };
