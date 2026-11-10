'use strict';

/**
 * 货品搜索专用快照（2026-11-11）。
 *
 * 为什么不用 `configTableCache`：货品信息是配置表，但样例图同步等写操作会触发
 * `record_changed` → 整张表失效 → 下一次搜索又整表读；飞书慢时搜索就跟着慢。
 *
 * 这里维护一份**独立快照**：
 *   · TTL 内直接用内存；
 *   · 过期时**先返回旧快照**，后台刷新（stale-while-revalidate）；
 *   · 刷新失败继续用旧快照；只有「从未成功读过」才抛错；
 *   · 不被 `record_changed` 清空。
 *
 * 只读：本模块不写飞书。
 */
const { PRODUCT_PROFILE } = require('../config/productProfile');
const { logInfo, logWarn } = require('../utils/logger');

const entries = new Map();
const fakeIds = new WeakMap();
let fakeSeq = 0;

const keyOf = (gateway) => {
  const appToken = gateway?.schema?.appToken || gateway?.appToken || '';
  let tableId = 'product';
  try { tableId = gateway?.table?.('product')?.tableId || 'product'; } catch (error) { /* 测试缺 env */ }
  if (appToken) return `${appToken}:${tableId}`;
  if (!fakeIds.has(gateway)) fakeIds.set(gateway, ++fakeSeq);
  return `fake:${fakeIds.get(gateway)}`;
};

const entryOf = (gateway) => {
  const key = keyOf(gateway);
  if (!entries.has(key)) {
    entries.set(key, { gateway, rows: [], at: 0, loading: null, lastError: null });
  }
  return entries.get(key);
};

const load = (entry, now) => {
  if (entry.loading) return entry.loading;
  entry.loading = (async () => {
    try {
      const rows = await entry.gateway.listAll('product');
      entry.rows = Array.isArray(rows) ? rows : [];
      entry.at = now();
      entry.lastError = null;
      logInfo('product_search.snapshot.refreshed', { rows: entry.rows.length });
      return entry.rows;
    } catch (error) {
      entry.lastError = error;
      logWarn('product_search.snapshot.refresh_failed', {
        error: String(error?.message || error).slice(0, 200),
        has_last_good: entry.rows.length > 0,
      });
      if (!entry.rows.length) throw error;
      return entry.rows;
    } finally {
      entry.loading = null;
    }
  })();
  return entry.loading;
};

const getProductSearchSnapshot = async ({
  gateway, now = () => Date.now(), ttlMs = PRODUCT_PROFILE.searchSnapshotTtlMs,
} = {}) => {
  if (!gateway) throw new Error('getProductSearchSnapshot requires gateway');
  const entry = entryOf(gateway);
  entry.gateway = gateway;
  const fresh = entry.rows.length > 0 && (now() - entry.at < ttlMs);
  if (fresh) return entry.rows;
  if (entry.rows.length) {
    // stale-while-revalidate：先把旧快照给她，刷新在后台跑，不阻塞搜索。
    if (!entry.loading) void load(entry, now).catch(() => {});
    return entry.rows;
  }
  return load(entry, now);
};

/** 启动预热 / 测试用：强制刷新一次。 */
const warmProductSearchSnapshot = async ({ gateway, now = () => Date.now() } = {}) => {
  if (!gateway) throw new Error('warmProductSearchSnapshot requires gateway');
  const entry = entryOf(gateway);
  entry.gateway = gateway;
  entry.at = 0;
  const rows = await load(entry, now);
  return rows.length;
};

const resetProductSearchSnapshot = () => entries.clear();

module.exports = {
  getProductSearchSnapshot,
  warmProductSearchSnapshot,
  resetProductSearchSnapshot,
};
