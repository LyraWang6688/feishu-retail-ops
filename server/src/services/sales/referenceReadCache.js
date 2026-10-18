'use strict';

/**
 * ⭐⭐ 2026-10-12：**只读引用数据的进程内短缓存**（提交链路提速；她真机收过 504 网关超时）。
 * ⭐⭐ 2026-10-18（第 4 步提速 · 文件大小门禁）：从 `services/scanWriteService.js` **原样搬出**
 *   （那个文件是存量超限件，基线只许变小；本模块是**纯搬家**，逻辑一个字节没改 ✓）。
 *
 * 线上量级实测（假网关 + 每趟 60ms）：一趟"提交这一单"打 **47 次飞书调用**，其中
 * `尺码管理` 被 `listAll` **5 次**、`货品信息` 2 次、`行为管理` 2 次 —— 而这几次
 * **同在一次提交里、结果逐字相同**。缓存之后这些重复读只打一次。
 *
 * 🔴 **三条硬边界**（与 `config/scanWrite.js` 的 `READ_CACHE` 注释同一份口径）：
 *   ① **只用白名单**：名单里只有只读引用表（尺码管理 / 货品信息 / 行为管理 / 收款方式管理）；
 *      **销售主表 / 销售明细 / 收款记录 / 实时库存 / 库存流水一律不在名单里**
 *      ⇒ 幂等回查、单号分配、库存判据**碰不到这个缓存**；
 *   ② **写方法原样透传**（`create` / `update` / `delete` 连包都不包）；
 *   ③ **同键在飞去重**（她连点 14 次 / 并发请求打同一张表 ⇒ 只有一趟真的去读）。
 *
 * ⚠️ 返回的数组**浅拷贝一份**给调用方：缓存里那份不被调用方 `sort` / `splice` 弄脏。
 * ⚠️ 关掉它的办法：`config.readCache.enabled = false` 或 `createScanWriteService({readCache:false})`
 *    —— 两条都是显式的（不靠 `||` 兜底，清空变量不会"关不掉"）。
 */
const createReadOnlyReferenceCache = (gateway, policy, now = () => Date.now()) => {
  const settings = policy || {};
  const tables = new Set(Array.isArray(settings.tables) ? settings.tables : []);
  const ttlMs = Number(settings.ttlMs);
  if (settings.enabled !== true || !tables.size || !(ttlMs > 0)) return gateway;
  const found = new Map();
  const inflight = new Map();
  const readThroughCache = (key, run) => {
    const hit = found.get(key);
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const pending = Promise.resolve().then(run).then((value) => {
      found.set(key, { at: now(), value });
      return value;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
    return pending;
  };
  const cachedRead = (name) => async (tableKey, ...rest) => {
    if (!tables.has(tableKey)) return gateway[name](tableKey, ...rest);
    const value = await readThroughCache(`${name}:${tableKey}:${JSON.stringify(rest)}`,
      () => gateway[name](tableKey, ...rest));
    // 浅拷贝数组：调用方 `find` / `filter` / 偶尔 `sort` 都弄不脏缓存那一份。
    return Array.isArray(value) ? value.slice() : value;
  };
  // `Object.create(gateway)`：继承它的其余属性/方法（`this` 仍然指得对），
  // 只在**自己这一层**替换那四个**只读**方法。写方法连覆盖都不做。
  const facade = Object.create(gateway);
  facade.listAll = cachedRead('listAll');
  facade.get = cachedRead('get');
  facade.listByFilter = cachedRead('listByFilter');
  facade.findOneByText = cachedRead('findOneByText');
  return facade;
};

module.exports = { createReadOnlyReferenceCache };
