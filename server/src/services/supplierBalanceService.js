'use strict';

/**
 * 「供应 → 供应分析」只读聚合：
 *   · 供应商 / 初始化 / P交易明细三张表；
 *   · 显示最新余额 != 0、或最近窗口内有交易的供应商；
 *   · 余额：有 P 交易取最新交易日的最新余额，否则取初始化期初余额；
 *   · 交易明细：P交易明细，最近 N 天，按交易日倒序。
 */
const { textValue } = require('./v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SUPPLIER_BALANCE } = require('../config/supplierBalance');
const { getConfigRows } = require('./configTableCache');
const { CRITICAL_READ_RETRY } = require('../config/gatewayReadRetry');

const num = (value) => {
  const raw = textValue(value).replace(/,/g, '').trim();
  const number = Number(raw);
  return Number.isFinite(number) ? number : 0;
};
const dateMs = (value) => {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
};
const isoDate = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');

const createSupplierBalanceService = ({
  gateway,
  config = SUPPLIER_BALANCE,
  now = () => Date.now(),
} = {}) => {
  if (!gateway) throw new Error('SupplierBalanceService requires gateway');
  const supplierFields = V1_BITABLE_SCHEMA.tables.supplier.fields;
  const initFields = V1_BITABLE_SCHEMA.tables.supplierBalanceInit.fields;
  const txSchema = V1_BITABLE_SCHEMA.tables.paymentTransaction;
  const txFields = { ...txSchema.fields, ...config.transactionFields };

  const supplierNameOf = (row) => textValue(row?.fields?.[txFields.supplierName]).trim();

  const classify = (row) => {
    const fields = row.fields || {};
    for (const family of config.transactionFamilies) {
      const match = family.match || {};
      if (match.field === 'tradeDirection') {
        const direction = textValue(fields[txFields.tradeDirection]).trim();
        if ((match.values || []).includes(direction)) {
          return { type: family.labels?.[direction] || direction, amountField: family.amountField };
        }
        continue;
      }
      if (match.field === 'behavior') {
        const behavior = textValue(fields[txFields.behavior]).trim();
        if (match.nonEmpty ? Boolean(behavior) : false) {
          const contains = family.labels?.contains || {};
          const hit = Object.entries(contains).find(([needle]) => behavior.includes(needle));
          return { type: hit ? hit[1] : family.labels?.default || behavior, amountField: family.amountField };
        }
      }
    }
    return null;
  };

  const transactionOf = (row) => {
    const fields = row.fields || {};
    const classified = classify(row);
    if (!classified) return null;
    const ms = dateMs(fields[txFields.tradeDate]);
    return {
      recordId: row.record_id,
      type: classified.type,
      tradeDate: isoDate(ms),
      amount: Math.abs(num(fields[txFields[classified.amountField]])),
      balance: num(fields[txFields.latestBalance]),
      _ms: ms,
    };
  };

  const list = async () => {
    const supplierFieldNames = [...new Set([supplierFields.name])];
    const initFieldNames = [...new Set([initFields.supplierName, initFields.initialBalance])];
    const txFieldNames = [...new Set([
      txFields.supplierName, txFields.tradeDate, txFields.tradeDirection, txFields.behavior,
      txFields.latestBalance,
      ...config.transactionFamilies.map((family) => txFields[family.amountField]),
    ].filter(Boolean))];
    const [supplierRows, initRows, txRows] = await Promise.all([
      // 供应商 / 期初余额是配置表：走统一缓存 + 关键读重试。
      getConfigRows({
        gateway, tableKey: 'supplier', fields: supplierFieldNames,
        loader: () => gateway.listAll('supplier', { fieldNames: supplierFieldNames, retry: CRITICAL_READ_RETRY }),
      }),
      getConfigRows({
        gateway, tableKey: 'supplierBalanceInit', fields: initFieldNames,
        loader: () => gateway.listAll('supplierBalanceInit', { fieldNames: initFieldNames, retry: CRITICAL_READ_RETRY }),
      }),
      // 交易流水是业务表，只裁字段，不按 30 天过滤（余额要取全量最新一笔）。
      gateway.listAll('paymentTransaction', { fieldNames: txFieldNames, retry: CRITICAL_READ_RETRY }),
    ]);

    const byName = new Map();
    const ensure = (name) => {
      if (!name) return null;
      if (!byName.has(name)) byName.set(name, { name, recordId: '', initialBalance: 0 });
      return byName.get(name);
    };

    for (const row of supplierRows || []) {
      const name = textValue(row?.fields?.[supplierFields.name]).trim();
      const entry = ensure(name);
      if (entry) entry.recordId = row.record_id || '';
    }

    for (const row of initRows || []) {
      const name = textValue(row?.fields?.[initFields.supplierName]).trim();
      const entry = ensure(name);
      if (entry) entry.initialBalance += num(row?.fields?.[initFields.initialBalance]);
    }

    const txBySupplier = new Map();
    for (const row of txRows || []) {
      const name = supplierNameOf(row);
      const entry = ensure(name);
      if (!entry) continue;
      const tx = transactionOf(row);
      if (!tx) continue;
      if (!txBySupplier.has(name)) txBySupplier.set(name, []);
      txBySupplier.get(name).push(tx);
    }

    const cutoff = now() - config.windowDays * 24 * 60 * 60 * 1000;
    const suppliers = [];
    for (const entry of byName.values()) {
      const all = (txBySupplier.get(entry.name) || []).slice()
        .sort((a, b) => (b._ms - a._ms) || String(b.recordId).localeCompare(String(a.recordId)));
      const latest = all[0] || null;
      let balance = 0;
      for (const rule of config.balanceRules) {
        if (rule.when === 'hasTransactions' && latest) {
          balance = latest.balance;
          break;
        }
        if (rule.when === 'always') {
          balance = entry.initialBalance;
          break;
        }
      }
      const recent = all.filter((tx) => Number.isFinite(tx._ms) && tx._ms >= cutoff);
      const visible = config.visibility.includeWhen.some((rule) => {
        if (rule.rule === 'numberNotZero') return rule.field === 'balance' && Number(balance) !== 0;
        if (rule.rule === 'hasRecentTransactions') return recent.length > 0;
        return false;
      });
      if (!visible) continue;
      suppliers.push({
        recordId: entry.recordId,
        name: entry.name,
        balance,
        transactions: recent.map(({ _ms, ...tx }) => tx),
      });
    }

    suppliers.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    return {
      asOf: new Date(now()).toISOString(),
      windowDays: config.windowDays,
      suppliers,
    };
  };

  return { list };
};

module.exports = { createSupplierBalanceService };
