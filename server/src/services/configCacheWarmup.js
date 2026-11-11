'use strict';

/**
 * 配置表缓存启动预热（2026-11-11）。
 *
 * 背景：缓存是**进程内存**，部署/重启后第一次真正用到某张配置表时才读飞书。
 * 例如「货品完善」第一次要读 559 条货品，生产实测约 3.4 秒，页面只能先显示加载态。
 * 服务启动后后台按**已有配置表注册表**逐张预热一次，用户第一次点页面时直接命中。
 *
 * 边界：
 *   · 只在启动后后台跑，不阻塞 listen；
 *   · 失败只记 warn，服务照常；
 *   · 用 `getConfigRows` 同一个缓存入口，不另造缓存；
 *   · `giftAccessory` 是虚拟缓存（只存配品=true），由资金页自己按需加载，启动不预热。
 */
const { getConfigRows } = require('./configTableCache');
const { CONFIG_TABLE_KEYS } = require('../config/configTables');
const { logInfo, logWarn } = require('../utils/logger');

/** 物理 Base 配置表顺序：小表先、货品/库存大表后，尽量不让启动瞬间同时打飞书。 */
const WARM_TABLES = Object.freeze(CONFIG_TABLE_KEYS.filter((key) => key !== 'giftAccessory'));

const warmConfigCaches = async ({ gateway, tables = WARM_TABLES } = {}) => {
  if (!gateway || typeof gateway.listAll !== 'function') {
    throw new Error('warmConfigCaches requires gateway.listAll');
  }
  const results = [];
  for (const tableKey of tables) {
    try {
      const rows = await getConfigRows({
        gateway,
        tableKey,
        loader: () => gateway.listAll(tableKey),
      });
      results.push({ tableKey, ok: true, rows: Array.isArray(rows) ? rows.length : 0 });
    } catch (error) {
      results.push({ tableKey, ok: false, rows: 0 });
      logWarn('config_cache.warm.failed', {
        table_key: tableKey,
        error: String(error?.message || error).slice(0, 200),
        hint: '配置表预热失败，首次使用时会按正常路径重读，不影响服务',
      });
    }
  }
  const warmed = results.filter((item) => item.ok).length;
  logInfo('config_cache.warm.done', {
    warmed,
    total: results.length,
    rows: results.reduce((sum, item) => sum + item.rows, 0),
    failed: results.filter((item) => !item.ok).map((item) => item.tableKey),
  });
  return results;
};

module.exports = { warmConfigCaches, WARM_TABLES };
