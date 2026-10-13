/**
 * ⭐⭐ 2026-10-13「尺码范围 + 特殊尺码」（业务负责人逐字确认 · docs/size-range-special-sizes-2026-10-13.md）
 *
 * 干什么：**只读**「采购明细」表，回答"这张表里**出现过**哪些尺码"——
 *   展示清单 = `default ∪ 出现过的 special`（没出现过 ⇒ 不展示，也**不算缺码** ✓）。
 *   ⚠️ 判据是「采购明细里出现过」· **不看实时库存** ✗（她的口径）。
 *
 * 🔴 **读不到 ⇒ 抛出**（**不吞、不给空清单**）：
 *   由调用方**明确降级**（只给 `default` 范围）并 `logWarn` ⇒ **不许静默少码** ✗
 *   （⚠️ 这是它与 `scanWriteService.listAccessories` 唯一的区别：后者读不到给 `[]`，因为
 *     "没有配品照样能卖鞋"；而这里"少一个码"会让她**看不到该录的码** ⇒ 必须显式。）
 *
 * 形状（照 `scanWriteService.js` 的 `listAccessories`）：
 *   · `options.listSizes` 可注入（单测直接替换）· 短 TTL 缓存 · 延迟 require（不拖依赖树）
 *   · **只读**：不写、不改表、不建索引 ✓ · 只取「尺码」一列 ✓
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');

const TABLE_KEY = 'purchaseRequest'; // schema key：tableName「采购明细」· tableId tbli1ygPtss5CWCH

/** 默认 TTL（30 秒）：宁可不命中缓存，也不让"她刚加的码"迟迟不出现。 */
const DEFAULT_CACHE_TTL_MS = 30000;

const sizeFieldName = () => {
  const name = V1_BITABLE_SCHEMA.tables[TABLE_KEY]?.fields?.size;
  // ⚠️ 拿不到就**当场抛**（不写死兜底：那是「用户可见文案」，必须留在 config/schema 里 ✓）
  if (!name) throw new Error('V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.size is not configured');
  return name;
};

/**
 * @param {object}   options
 * @param {object}   options.gateway       `V1BitableGateway`（只调 `listAll`）
 * @param {number}   [options.cacheTtlMs]  缓存 TTL（`0` = 不缓存）
 * @param {Function} [options.now]         取时间（单测用假时钟）
 * @param {Function} [options.listSizes]   注入替身（单测；给了就完全不读表）
 * @returns {{listSizes: Function, invalidate: Function}}
 */
const createPurchaseSizeReader = ({
  gateway, cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = Date.now, listSizes: injected,
} = {}) => {
  let cache = { at: 0, value: null };

  /** 出现过的尺码：**去重且保序**（按记录顺序第一次出现的先后）。读不到 ⇒ **抛出**。 */
  const listSizes = async () => {
    if (typeof injected === 'function') return injected();
    if (cacheTtlMs > 0 && cache.value && now() - cache.at < cacheTtlMs) return cache.value;
    const field = sizeFieldName();
    // ⚠️ 这里**不 catch**：读表失败必须让调用方看见（它要明确降级 + warn ✓）
    const records = await gateway.listAll(TABLE_KEY);
    const seen = new Set();
    const sizes = [];
    for (const record of records || []) {
      const raw = record?.fields?.[field];
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        const size = String(value ?? '').trim();
        if (!size || seen.has(size)) continue;
        seen.add(size);
        sizes.push(size);
      }
    }
    cache = { at: now(), value: sizes };
    return sizes;
  };

  /** 手动失效（她刚改完表、要立刻看到时用；接线方按需调用）。 */
  const invalidate = () => { cache = { at: 0, value: null }; };

  return { listSizes, invalidate };
};

module.exports = { createPurchaseSizeReader, DEFAULT_CACHE_TTL_MS, TABLE_KEY, sizeFieldName };
