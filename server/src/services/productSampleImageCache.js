'use strict';

/**
 * 货品样例图 file_token 的**短 TTL + LRU** 缓存（issue #1204）。
 *
 * 为什么：旧链路每张缩略图都要「读一次货品记录 + 下附件」= 2 次飞书调用；
 *   一页 300 张图 = 600 次调用 ⇒ 触发租户限流（1254607），整站读都跟着失败。
 *   这里只缓存**记录上的 attachment 元信息**（file_token / type），不缓存图片字节；
 *   命中时 0 次记录读，只做一次媒体下载。
 */
const createProductSampleImageCache = ({
  ttlMs = 10 * 60 * 1000,
  maxEntries = 500,
  now = () => Date.now(),
} = {}) => {
  const map = new Map();
  const ttl = Number(ttlMs) >= 0 ? Number(ttlMs) : 10 * 60 * 1000;
  const limit = Number(maxEntries) > 0 ? Number(maxEntries) : 500;

  const get = (recordId) => {
    const key = String(recordId || '');
    if (!key) return null;
    const entry = map.get(key);
    if (!entry) return null;
    if (ttl > 0 && now() - entry.at >= ttl) {
      map.delete(key);
      return null;
    }
    // LRU：命中后移到队尾
    map.delete(key);
    map.set(key, entry);
    return entry;
  };

  const set = (recordId, value) => {
    const key = String(recordId || '');
    if (!key) return;
    map.delete(key);
    map.set(key, { ...value, at: now() });
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  };

  const clear = () => map.clear();
  const size = () => map.size;

  return { get, set, clear, size };
};

module.exports = { createProductSampleImageCache };
