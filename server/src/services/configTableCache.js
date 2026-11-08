'use strict';

/**
 * 统一配置表快照（2026-10-26；2026-11-08 收口注册表/TTL/过期告警）。
 *
 * 规则：
 *   · 同一张配置表在进程内只有一份快照；
 *   · TTL 来自 `config/configTables.js`（不再由调用方各自传）；
 *   · TTL 内直接返回；过期后重读；
 *   · 重读失败 ⇒ 返回最后一次成功快照 lastGood（并打 `config_table_cache.last_good_used` 告警）；
 *   · 收到飞书 record_changed 事件时 `invalidate`，下一次读取重读。
 *
 * 快照 key = appToken + tableId + tableKey（同一 Base 的所有 gateway 实例共享）。
 */
const { configTableTtlMs, CONFIG_TABLE_KEYS } = require('../config/configTables');
const { logWarn } = require('../utils/logger');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const STALE_WARN_INTERVAL_MS = 5 * 60 * 1000;
const entries = new Map();
// 真实 gateway 按 appToken 共享（生产同一 Base 多实例共享一份）；
// 测试/替身没有 appToken ⇒ 按 gateway 实例隔离（避免不同用例串数据）。
const fakeIds = new WeakMap();
let fakeSeq = 0;
const keyOf = (gateway, tableKey) => {
  let tableId = tableKey;
  let appToken = '';
  try { tableId = gateway?.table?.(tableKey)?.tableId || tableKey; } catch (error) { /* 测试缺 env：退回 tableKey */ }
  try { appToken = gateway?.schema?.appToken || gateway?.appToken || ''; } catch (error) { /* 同上 */ }
  if (appToken) return `${appToken}:${tableId}:${tableKey}`;
  if (!fakeIds.has(gateway)) fakeIds.set(gateway, ++fakeSeq);
  return `fake:${fakeIds.get(gateway)}:${tableKey}`;
};

/** 过期重读失败时用 lastGood，但必须留下可观测的告警（同一张表 5 分钟内只打一次）。 */
const warnLastGoodUsed = (entry, now, ttl) => {
  const at = now();
  if (entry.lastWarnAt && at - entry.lastWarnAt < STALE_WARN_INTERVAL_MS) return;
  entry.lastWarnAt = at;
  const ageMs = Math.max(0, at - Number(entry.at || 0));
  logWarn('config_table_cache.last_good_used', {
    table_key: entry.tableKey,
    age_ms: ageMs,
    ttl_ms: ttl,
    last_error: String(entry.lastError?.message || entry.lastError || '').slice(0, 200),
    hint: '配置表重读失败，继续使用最后一次成功快照；请检查飞书读接口/配置表权限',
  });
};

const loadEntry = async (entry, loader, now, ttl) => {
  if (entry.loading) return entry.loading;
  entry.loading = (async () => {
    try {
      const rows = await (loader ? loader() : entry.gateway.listAll(entry.tableKey));
      entry.rows = Array.isArray(rows) ? rows : [];
      entry.lastGood = entry.rows;
      entry.at = now();
      entry.lastWarnAt = 0;
      entry.lastError = null;
      return entry.rows;
    } catch (error) {
      entry.lastError = error;
      if (entry.lastGood) {
        warnLastGoodUsed(entry, now, ttl);
        return entry.lastGood;
      }
      throw error;
    } finally {
      entry.loading = null;
    }
  })();
  return entry.loading;
};

/**
 * @param {{gateway: object, tableKey: string, loader?: Function}} options
 * @returns {Promise<Array>} 行数组；从未成功读过且读失败 ⇒ 抛错
 */
const getConfigRows = async ({ gateway, tableKey, loader, now = () => Date.now() } = {}) => {
  if (!gateway || !tableKey) throw new Error('getConfigRows requires gateway + tableKey');
  const key = keyOf(gateway, tableKey);
  const ttl = configTableTtlMs(tableKey);
  let entry = entries.get(key);
  if (!entry) {
    entry = { gateway, tableKey, rows: null, lastGood: null, at: 0, loading: null, lastError: null, lastWarnAt: 0 };
    entries.set(key, entry);
  } else {
    entry.gateway = gateway;
  }
  if (entry.rows && ttl > 0 && now() - entry.at < ttl) return entry.rows;
  return loadEntry(entry, loader, now, ttl);
};

/** 事件驱动：把某张表标记为过期；下一次读取会重读，失败则用 lastGood。 */
const invalidateConfigTable = (tableKeyOrId) => {
  const wanted = String(tableKeyOrId || '');
  let count = 0;
  for (const entry of entries.values()) {
    if (entry.tableKey === wanted || keyOf(entry.gateway, entry.tableKey).includes(`:${wanted}:`)) {
      entry.at = Number.NEGATIVE_INFINITY;
      entry.lastWarnAt = 0;
      count += 1;
    }
  }
  return count;
};

/** 启动预热 / 测试用：强制重读。 */
const warmConfigTable = async ({ gateway, tableKey, loader, now = () => Date.now() } = {}) => {
  const key = keyOf(gateway, tableKey);
  const entry = entries.get(key) || { gateway, tableKey, rows: null, lastGood: null, at: 0, loading: null, lastError: null, lastWarnAt: 0 };
  entries.set(key, entry);
  entry.at = 0;
  return loadEntry(entry, loader, now, configTableTtlMs(tableKey));
};

const resetConfigTableCache = () => entries.clear();

module.exports = {
  DEFAULT_TTL_MS,
  CONFIG_TABLE_KEYS,
  getConfigRows,
  invalidateConfigTable,
  warmConfigTable,
  resetConfigTableCache,
};
