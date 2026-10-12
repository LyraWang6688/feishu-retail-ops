/**
 * ⭐⭐ 「订单列表」读取结果的 **TTL 缓存**（业务负责人 2026-10-12：「它一直说正在读取订单」）。
 *
 * **它只干一件事**：把 `SalesFollowupService.listOrders()` 的**整份结果**按 TTL 存一小会儿 ——
 * 连着点几下 / 在几个子 tab 之间来回切 ⇒ 后面几次**一次飞书读都不发**（≈0 秒）。
 *
 * 为什么是"整份结果"而不是按表缓存：
 *   · 页面拿到的本来就是一整份（三份单子 + 收款方式清单），按表缓存还要在内存里重拼一遍；
 *   · 失效判据也简单：**任何一笔写库之后整份作废**（下面 `invalidate()`）。
 *
 * ⚠️ **TTL 之后必须能失效**：补收款 / 补实收 / 交付 / 售后 / 二次交付 / 补样品**六条写入路径**
 *    成功之后都由**路由层**调一次 `invalidate()`（缓存层不认业务，路由层才认）——
 *    否则她会看到旧数据（那是比"慢"坏得多的事）。
 *
 * ⚠️ **实例是显式注入的**（`options.ordersCache`）：默认**每个 service 实例一个**（不搞进程级单例），
 *    这样同一个进程里的两套接线不会互相污染，测试也不会串味。
 *    `ttlMs <= 0` ⇒ **显式关掉缓存**（每次真读，行为与优化前一致）。
 *
 * ⚠️ 并发：命中间隔内**同时**来的两个请求会各读一次（没有做"single-flight"）——
 *    这是**故意**的：她一个人用，没必要为它引入排队与共享 Promise 的复杂度。
 */
const { DEFAULT_ORDERS_CACHE_MS } = require('../config/workbenchOrders');

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs] 存活毫秒数；`0`（或负数）= 关掉缓存
 * @param {() => number} [options.now] 取当前时间的函数（用例注入，便于"拨表"到过期）
 */
const createWorkbenchOrdersCache = (options = {}) => {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_ORDERS_CACHE_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let entry = null; // { value, expiresAt }
  const stats = { hits: 0, misses: 0, stores: 0, invalidations: 0 };

  return {
    ttlMs,

    /** 命中且没过期 ⇒ 返回结果；否则 `undefined`（调用方去真读）。 */
    get() {
      if (ttlMs <= 0 || !entry) {
        stats.misses += 1;
        return undefined;
      }
      if (now() >= entry.expiresAt) {
        entry = null;
        stats.misses += 1;
        return undefined;
      }
      stats.hits += 1;
      return entry.value;
    },

    /** 存一份结果（`ttlMs <= 0` 时直接不存）。 */
    set(value) {
      if (ttlMs <= 0) return;
      entry = { value, expiresAt: now() + ttlMs };
      stats.stores += 1;
    },

    /** 任何一笔写库之后调它 —— 下一次读一定是真读。 */
    invalidate() {
      entry = null;
      stats.invalidations += 1;
    },

    /** 只读的计数（测试 / 排查用）。 */
    stats() {
      return { ...stats, cached: Boolean(entry) };
    },
  };
};

module.exports = { createWorkbenchOrdersCache };
