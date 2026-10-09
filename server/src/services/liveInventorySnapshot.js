/**
 * 「实时库存」的**进程内内存快照**（业务负责人 2026-10-09 同意的第二项优化）。
 *
 * 她的口径（要点）：「**首屏毫秒级，不再依赖 filter、也不会回退整表**」；
 * 前提是她要的「**库存准确**」⇒ **任何写操作必须立刻失效**（不是等 30 秒）。
 *
 * 背景（线上真机证据，2026-10-09 服务器只读日志 + nginx access.log）：
 *   · 每次扫码都要打飞书读「实时库存」——按条件读 2~5 秒；
 *   · 条件没命中 / 接口不认这个公式时会**回退整表读**（「货品信息」那张 20000 行的表
 *     也读了一遍），线上有一次 **25 秒**还没回来：她在飞书 webview 里等成一张白页，
 *     nginx 记 **499**（她没等到就先关了）。
 *   ⇒ 把这**整张表**搬进内存（后台每一拍重拉一次），扫码时直接查内存。
 *
 * 🔴 三条不许破的边界（用例 `test/liveInventorySnapshot.test.js` 钉着）：
 *   ① **只读**：本模块只调 `gateway.listAll`，**一个字都不写**；
 *   ② **不改业务语义**：命中快照时用的是**同一份内存判据**（`belongsToNumber`），
 *      行集与"按编号过滤读"逐字一致；
 *   ③ **未就绪 / 过期 / 刷新失败一律回退**老路径并记日志 —— 不静默、不猜。
 *
 * ⚠️ 为什么**刷新失败就当场作废**（而不是留着旧数据继续吃）：
 *    她的第一要求是「库存**准确**」。刷新失败时我们**不知道**手上这份还是不是最新，
 *    宁可这一趟慢一点（走回退真读），也不给她看一份可能过期的库存。
 * ⚠️ 为什么**跨模块失效**用一张全局注册表：写库存的地方不止扫码页
 *    （销售入账 / 到货 / 手工库存调整 / 销售交付…都在别的 service 里）。
 *    那些 service 只要在写成功后调一行
 *    `require('../services/liveInventorySnapshot').invalidateLiveInventorySnapshot('原因')`，
 *    不需要认识扫码页、也不需要注入任何依赖（模块化 / 解耦）。
 *
 * ⚠️ 定时器**一律 `unref()`**：它只是后台刷新，绝不许把进程（或测试）吊住。
 */
const { logInfo, logWarn } = require('../utils/logger');
const { SCAN_PAGE } = require('../config/scanPage');

const DEFAULT_TABLE_KEY = 'liveInventory';

/**
 * 所有活着的快照实例（**跨模块失效**用）。
 * 每个实例在 `createLiveInventorySnapshot` 时注册、`dispose()` 时注销。
 */
const registry = new Set();
const registeredSnapshotCount = () => registry.size;

/**
 * 建一个「实时库存」整表快照。
 *
 * @param {object}   options
 * @param {object}   options.gateway              飞书网关（只用到 `listAll`）
 * @param {object}   [options.config]             取值 `config/scanPage.js` 的 `snapshot`
 * @param {object}   [options.limits]             取值 `config/scanPage.js` 的 `limits`（回退上限兜底）
 * @param {string}   [options.tableKey]           默认 `liveInventory`（虚拟表名，不是物理表名）
 * @param {Function} [options.now]                时钟（用例注入）
 * @param {Function} [options.setIntervalFn]      定时器（用例注入）
 * @param {Function} [options.clearIntervalFn]    清定时器（用例注入）
 * @param {object}   [options.events]             日志事件名（默认 `SCAN_PAGE.events`）
 */
const createLiveInventorySnapshot = (options = {}) => {
  const gateway = options.gateway;
  const config = options.config || SCAN_PAGE.snapshot || {};
  const limits = options.limits || SCAN_PAGE.limits || {};
  const events = options.events || SCAN_PAGE.events || {};
  const tableKey = options.tableKey || DEFAULT_TABLE_KEY;
  const now = options.now || Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;

  const refreshIntervalMs = Number(config.refreshIntervalMs) > 0 ? Number(config.refreshIntervalMs) : 0;
  const maxAgeMs = Number(config.maxAgeMs) > 0 ? Number(config.maxAgeMs) : 0;
  const maxRecords = Number(config.maxRecords) > 0 ? Number(config.maxRecords) : (limits.inventoryRecords || 0);
  // ⚠️ 网关连 `listAll` 都没有（测试桩）⇒ 这个快照根本用不了：显式关掉，调用方走老路径。
  const enabled = config.enabled !== false
    && typeof gateway?.listAll === 'function'
    && refreshIntervalMs > 0
    && maxAgeMs > 0
    && maxRecords > 0;

  let records = null;
  let loadedAt = 0;
  let lastError = null;
  let loading = false;
  let timer = null;
  let started = false;

  /** 把快照**当场作废**（不是删数据文件，就是"下次别再吃它了"）。 */
  const drop = () => { records = null; loadedAt = 0; };

  /**
   * 拉一次整表。
   * @returns {Promise<{ok:boolean, records:number, reason:string, error:string}>}
   *   ⚠️ **永不抛**：调用方有"起完就不管"（fire-and-forget）的用法。
   */
  const refresh = async ({ reason = 'tick' } = {}) => {
    if (!enabled) return { ok: false, records: 0, reason: 'disabled', error: '' };
    if (loading) return { ok: false, records: 0, reason: 'in_flight', error: '' };
    loading = true;
    try {
      const all = await gateway.listAll(tableKey);
      const list = Array.isArray(all) ? all : [];
      if (maxRecords > 0 && list.length > maxRecords) {
        // 🔴 超上限**不作快照**（回退老路径 + 记 warn）：截断出来的库存表是错的，
        //    而"错的库存"比"慢一次"坏得多（与 service 里 table 上限同一口径）。
        drop();
        lastError = 'limit_exceeded';
        logWarn(events.snapshotFailed, {
          reason: 'limit_exceeded', table_key: tableKey, records: list.length, limit: maxRecords,
        });
        return { ok: false, records: list.length, reason: 'limit_exceeded', error: '' };
      }
      records = list;
      loadedAt = now();
      lastError = null;
      // ⚠️ 每一拍都打一条就太吵了（30 秒一条 = 一天 2880 条）：只记"第一次"和"条数变了"。
      const changed = options.lastLoggedCount !== records.length;
      if (changed) {
        options.lastLoggedCount = records.length;
        logInfo(events.snapshotRefreshed, { reason, table_key: tableKey, records: records.length });
      }
      return { ok: true, records: records.length, reason: '', error: '' };
    } catch (error) {
      // 刷新失败 ⇒ **当场作废**：宁可这一趟慢（走回退真读），也不给可能过期的库存。
      drop();
      lastError = error?.message || 'refresh_failed';
      logWarn(events.snapshotFailed, {
        reason: 'refresh_failed', table_key: tableKey, error: lastError,
      });
      return { ok: false, records: 0, reason: 'refresh_failed', error: lastError };
    } finally {
      loading = false;
    }
  };

  /**
   * 现在能不能吃快照？
   * @returns {{ready:boolean, reason:string, records:Array|null, ageMs:number|null}}
   *   `reason`：`disabled` / `not_ready` / `stale` / `limit_exceeded` / `refresh_failed` / `''`
   */
  const get = () => {
    if (!enabled) return { ready: false, reason: 'disabled', records: null, ageMs: null };
    if (!records || !loadedAt) {
      return { ready: false, reason: lastError || 'not_ready', records: null, ageMs: null };
    }
    const ageMs = Math.max(0, now() - loadedAt);
    if (maxAgeMs > 0 && ageMs > maxAgeMs) {
      return { ready: false, reason: 'stale', records: null, ageMs };
    }
    return { ready: true, reason: '', records, ageMs };
  };

  /** 写操作后调它：当场作废（同步生效），并按配置立刻重拉一次。 */
  const invalidate = (reason = 'write') => {
    if (!enabled) return false;
    drop();
    logInfo(events.snapshotInvalidated, { reason, table_key: tableKey });
    if (config.refreshOnInvalidate !== false) {
      // fire-and-forget：refresh 自己永不抛；写入口不该为刷新多等一次飞书往返。
      refresh({ reason: `invalidate:${reason}` });
    }
    return true;
  };

  /** 起后台刷新（幂等）：**立刻先拉一次**（首屏不用等 30 秒），再按间隔跑。 */
  const start = () => {
    if (!enabled || started) return false;
    started = true;
    refresh({ reason: 'start' });
    if (refreshIntervalMs > 0) {
      timer = setIntervalFn(() => { refresh({ reason: 'tick' }); }, refreshIntervalMs);
      // ⚠️ 绝不许把进程（或测试）吊住：后台刷新不是"活着"的理由。
      timer?.unref?.();
    }
    return true;
  };

  const stop = () => {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    started = false;
  };

  const snapshot = {
    enabled,
    tableKey,
    refreshIntervalMs,
    maxAgeMs,
    maxRecords,
    get started() { return started; },
    refresh,
    get,
    invalidate,
    start,
    stop,
    /** 销毁（用例收尾用）：停定时器 + 退出全局注册表。 */
    dispose() { stop(); registry.delete(snapshot); },
  };
  registry.add(snapshot);
  return snapshot;
};

/**
 * ⭐ **跨模块失效**：任何写「实时库存」的动作在写成功之后调这一行就够了。
 *
 * 为什么是全局函数（而不是让每个 service 注入快照）：写库存的地方散在
 * `inventoryService`（销售 / 到货 / 手工调整）、`salesDeliveryService`（交付扣减）…
 * 让它们各自注入一个"扫码页的快照对象"会把两条链路**绑死**；
 * 这里只暴露一个**不认识的词**（invalidate），谁写的、为什么写都不关心。
 *
 * ⚠️ 没配快照 / 快照关掉时它就是个 no-op（不会报错、也不会拖慢写入口）。
 */
const invalidateLiveInventorySnapshot = (reason = 'write', options = {}) => {
  // ⭐ 2026-10-09：多了一个「只作废某一张表的快照」的可选过滤（`{ tableKey: 'product' }`）。
  //   为什么不直接作废全部：写「货品信息」（新建货品 / 改价 / 写标签二维码）**不影响库存**，
  //   把库存快照一起作废等于让它白重拉一次两万行（每改一次价就一次）。
  //   ⚠️ **不传 tableKey 时行为与改动前逐字相同**（作废全部）—— 库存写入口就是这么调的。
  const wanted = String(options?.tableKey || '').trim();
  let hit = 0;
  for (const snapshot of [...registry]) {
    if (wanted && snapshot.tableKey !== wanted) continue;
    if (snapshot.invalidate(reason)) hit += 1;
  }
  return hit;
};

module.exports = {
  createLiveInventorySnapshot,
  invalidateLiveInventorySnapshot,
  registeredSnapshotCount,
  DEFAULT_TABLE_KEY,
};
