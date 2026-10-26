'use strict';

/**
 * 统一配置表快照（2026-10-26）。
 *
 * 背景：收款方式 / 尺码 / 行为 / 配品 / 供应商 / 团购券这些配置表
 * 被多条链路各自 `listAll`，各自缓存、各自失败兜底 ⇒ 页面显示与写库校验会不一致。
 * 本模块只做一件事：**同一张配置表在进程内只有一份快照**：
 *   · TTL 内直接返回；
 *   · 过期后重读；重读失败 ⇒ 返回**最后一次成功**的快照（不退回配置里的旧选项）；
 *   · 收到飞书 record_changed 事件时 `invalidate`，下一次读取重读。
 * 快照 key = appToken + tableId + tableKey（同一 Base 的所有 gateway 实例共享）。
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000;
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

const loadEntry = async (entry, loader, now) => {
  if (entry.loading) return entry.loading;
  entry.loading = (async () => {
    try {
      const rows = await (loader ? loader() : entry.gateway.listAll(entry.tableKey));
      entry.rows = Array.isArray(rows) ? rows : [];
      entry.lastGood = entry.rows;
      entry.at = now();
      entry.lastError = null;
      return entry.rows;
    } catch (error) {
      entry.lastError = error;
      if (entry.lastGood) return entry.lastGood;
      throw error;
    } finally {
      entry.loading = null;
    }
  })();
  return entry.loading;
};

/**
 * @param {{gateway: object, tableKey: string, ttlMs?: number, loader?: Function}} options
 * @returns {Promise<Array>} 行数组；从未成功读过且读失败 ⇒ 抛错
 */
const getConfigRows = async ({ gateway, tableKey, ttlMs = DEFAULT_TTL_MS, loader, now = () => Date.now() } = {}) => {
  if (!gateway || !tableKey) throw new Error('getConfigRows requires gateway + tableKey');
  const key = keyOf(gateway, tableKey);
  let entry = entries.get(key);
  if (!entry) {
    entry = { gateway, tableKey, rows: null, lastGood: null, at: 0, loading: null, lastError: null };
    entries.set(key, entry);
  } else {
    entry.gateway = gateway;
  }
  const ttl = Number(ttlMs);
  if (entry.rows && ttl > 0 && now() - entry.at < ttl) return entry.rows;
  return loadEntry(entry, loader, now);
};

/** 事件驱动：把某张表标记为过期；下一次读取会重读，失败则用 lastGood。 */
const invalidateConfigTable = (tableKeyOrId) => {
  const wanted = String(tableKeyOrId || '');
  let count = 0;
  for (const entry of entries.values()) {
    if (entry.tableKey === wanted || keyOf(entry.gateway, entry.tableKey).includes(`:${wanted}:`)) {
      entry.at = Number.NEGATIVE_INFINITY;
      count += 1;
    }
  }
  return count;
};

/** 启动预热 / 测试用：强制重读。 */
const warmConfigTable = async ({ gateway, tableKey, loader, now = () => Date.now() } = {}) => {
  const key = keyOf(gateway, tableKey);
  const entry = entries.get(key) || { gateway, tableKey, rows: null, lastGood: null, at: 0, loading: null, lastError: null };
  entries.set(key, entry);
  entry.at = 0;
  return loadEntry(entry, loader, now);
};

const resetConfigTableCache = () => entries.clear();

module.exports = {
  DEFAULT_TTL_MS,
  getConfigRows,
  invalidateConfigTable,
  warmConfigTable,
  resetConfigTableCache,
};
