/**
 * 扫码页的**进程内短 TTL 缓存**（`编号` → 视图模型）。
 *
 * 为什么要有它（业务负责人 2026-10-08：「扫码页打开有点慢」）：
 *   · 主提速手段是"**只读这一次真正需要的那几行**"（见 `scanPageService` 的 `reads`）；
 *   · 这一层是**兜底 + 连续扫码更快**：她连着扫同一款（或几个人扫同一款）时，
 *     第二次开始一次飞书请求都不打。
 *
 * ⚠️ 三条约束（brief 点名，缺一不可）：
 *   ① **不引入新依赖** —— 就是一个 `Map` + 时间戳；
 *   ② **TTL 必须短且进配置**（`config/scanPage.js` 的 `cache`，默认 45s）——
 *      这条链路本身只读，但**库存会变**（销售 / 到货 / 手工调整都会动「实时库存」），
 *      而写操作**不会**主动来清这个缓存（那要跨模块耦合）⟹ "脏窗口"就等于 TTL；
 *   ③ **容量有上限**，满了先清已过期的，再淘汰最久没用到的（LRU 近似）——
 *      编号是有限集合（货品数），但也不能无界增长。
 *
 * ⚠️ **只缓存 `found: true` 的结果**（调用方负责）：新品刚建档就该立刻扫得到，
 *    "没找到"这种否定结果缓存住最容易变成"她刚建完档还是打不开"。
 * ⚠️ 返回值是**同一个对象引用**（不深拷贝）：视图模型是给渲染层读的，
 *    渲染层（`views/scanPageRenderer.js`）只读不写 —— 调用方也不许改它。
 */

const createScanPageCache = ({ ttlMs = 0, maxEntries = 1, now = Date.now } = {}) => {
  const store = new Map();
  const effectiveTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;
  const enabled = effectiveTtl > 0;

  /** 满了：先清所有已过期的；还满就淘汰最久没被 `get` 到的（Map 的插入序）。 */
  const evict = () => {
    if (store.size <= limit) return;
    const current = now();
    for (const [key, entry] of [...store.entries()]) {
      if (entry.expiresAt <= current) store.delete(key);
    }
    while (store.size > limit) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  };

  return {
    enabled,
    ttlMs: effectiveTtl,
    maxEntries: limit,

    /** 命中返回缓存值；过期 / 没有 / 关掉都返回 `null`。 */
    get(key) {
      if (!enabled) return null;
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      // 命中即"刷新新鲜度"：删了再塞回去 = Map 里排到最后（LRU 近似）。
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },

    set(key, value) {
      if (!enabled) return;
      store.delete(key);
      store.set(key, { value, expiresAt: now() + effectiveTtl });
      evict();
    },

    /** 给排查 / 用例用：当前在缓存里的条目数（含尚未淘汰的过期项）。 */
    size() {
      return store.size;
    },

    clear() {
      store.clear();
    },
  };
};

module.exports = { createScanPageCache };
