'use strict';

/**
 * ⭐⭐ 2026-10-14（业务负责人逐字）：「**付款方式用交易方式管理，可选择**～」
 *   ＋ 她 2026-10-14 晚：「**抖音团购券**没见你说啊」⇒ 她要知道/用到**表里真实那几条**。
 *
 * 实测（服务器上只读核过 ✓）生产「**收款方式管理**」表里有 **6 条**：
 *   支付宝 · 微信 · 现金 · **抖音代金券（89.9）** · **抖音代金券（49.9）** · 工商银行
 *
 * 本文件只做一件事：**把那张表的选项读出来**（配置先行 ✓ 只读 ✓ 不写任何表 ✗）。
 *   · 🔴 **读不到就如实说**（返回 `ok:false` + 人话）——**绝不静默拿旧列表兜底** ✗
 *   · ⭐ 短时缓存（TTL 可配 ✓）—— 每次渲染都去读表会拖慢页面 ✗
 *   · 🔴 **不判断任何业务语义**（"哪个是抖音券"由配置说了算 ✓ 不在这里写中文匹配 ✗）
 */

const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');

/** ⭐ 2026-10-18：候选排序 —— 配置默认方式**只在表里真实存在时**排第一；否则用表里第一项。 */
const orderWithPreferred = (items = [], preferred = '') => {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  return preferred && list.includes(preferred)
    ? [preferred, ...list.filter((item) => item !== preferred)]
    : list;
};
const { textValue, linkedRecordIds } = require('./v1BitableGateway');
const { getConfigRows } = require('./configTableCache');

/**
 * @param {{ listAll: Function }} gateway
 * @param {{ ttlMs?: number, now?: Function, tableKey?: string, fieldName?: string,
 *           voucherFieldName?: string }} [options]
 */
const createPaymentMethodsService = (gateway, options = {}) => {
  if (!gateway) throw new Error('PaymentMethodsService requires gateway');
  const tableKey = options.tableKey || 'paymentMethod';
  const fieldName = options.fieldName
    || V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.name
    || '收款方式';
  // ⭐ 2026-10-16：这张表上还有一列「**团购券管理**」（type 21 关联列）——**列非空 = 这条收款方式是券**
  //    （生产真表只读核实：`properties.table_id = tblz2kM1CIGkcWsM` ✓；语义键在 `v1BitableSchema`）。
  //    ⚠️ 列名**只从配置/语义键取**，逻辑里**不写中文** ✗；取不到 ⇒ 空串 ⇒ `listWithVouchers()` 一律
  //       当作"非券"（但**不静默**：券那一刀会因此打 `scan.write.voucher_method_unmapped` ✓）。
  const voucherFieldName = options.voucherFieldName
    || V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.voucher
    || '';
  // ⭐ 2026-10-18：「出现顺序」（数字，1 最前）——表里没配/非数字 ⇒ 排最后（保持稳定）。
  const orderFieldName = options.orderFieldName
    || V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.order
    || '';
  const orderOf = (row) => {
    if (!orderFieldName) return Number.POSITIVE_INFINITY;
    const raw = textValue(row?.fields?.[orderFieldName]).trim();
    if (!raw) return Number.POSITIVE_INFINITY;
    const n = Number(raw);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  // ⭐ 2026-10-26：配置表变动少 ⇒ 默认 30 分钟；读失败保留 lastGood（configTableCache）。
  const ttlMs = options.ttlMs === undefined ? 30 * 60 * 1000 : Number(options.ttlMs);
  const now = options.now || (() => Date.now());
  let cache = null;

  /**
   * 一趟读表 → `{ at, items, detailed }`（`items` = 名字那份；`detailed` = 带券关联那份）。
   * ⚠️ **只读一次**：`list()` / `listWithVouchers()` 共用这一趟与这一份缓存
   *    （页面那一趟渲染会同时要名字与券关联 ⇒ 不许因此多打一次飞书 ✗）。
   */
  const load = async (stamp, cached) => {
    if (cached) return { ok: true, cached: true };
    try {
      // 统一配置快照：TTL 内复用；过期重读；读失败返回 lastGood（不退回配置假选项）。
      const rows = await getConfigRows({ gateway, tableKey, ttlMs, now });
      const items = [];
      const detailed = [];
      const seen = new Set();
      // ⭐ 先按「出现顺序」排（同序/无序号保持表内原顺序 ⇒ 稳定排序）。
      const ordered = (rows || []).map((row, index) => ({ row, index, order: orderOf(row) }))
        .sort((a, b) => (a.order - b.order) || (a.index - b.index));
      for (const { row } of ordered) {
        const value = textValue(row?.fields?.[fieldName]).trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        items.push(value);
        detailed.push({
          name: value,
          recordId: String(row?.record_id || ''),
          // 关联列**非空** ⇒ 这条收款方式是券；拿不到（列没配 / 没关联）⇒ ''。
          voucherRecordId: voucherFieldName
            ? String(linkedRecordIds(row?.fields?.[voucherFieldName])[0] || '')
            : '',
        });
      }
      cache = { at: stamp, items, detailed };
      return { ok: true, cached: false };
    } catch (error) {
      // 🔴 读不到 ⇒ **如实**（调用方去说人话 ✓ 不静默兜底 ✗）
      return { ok: false, reason: 'payment_methods_unreadable', error: error?.message || 'unknown' };
    }
  };

  /** ⭐ 读出表里那几条（按表里的顺序 ✓ 去重 ✓ 去空 ✓）。返回值与改前**逐字同形**。 */
  const list = async () => {
    const stamp = now();
    const fresh = cache && (Number(ttlMs) <= 0 ? false : stamp - cache.at < Number(ttlMs));
    const loaded = await load(stamp, fresh);
    if (!loaded.ok) return { ok: false, items: [], reason: loaded.reason, error: loaded.error };
    return { ok: true, items: cache.items, cached: loaded.cached === true };
  };

  /**
   * ⭐⭐ 2026-10-16：**带「团购券管理」关联列的那一份**（只读 ✓ 与 `list()` **同一趟读、同一份缓存**）。
   *
   * 券的判定（她 ④ + 生产真表只读核实）：这条收款方式的「团购券管理」关联列**非空** ⇒ 它是券。
   *   · `items[i] = { name, recordId, voucherRecordId }`；`voucherRecordId` 拿不到 = `''` ✓
   *   · ⚠️ 关联列的**形状**用 `linkedRecordIds` 认（type 21 在事件 / GET 两种接口下形状不同 ✓
   *     `[{record_ids:[…]}]` / 直接 `rec…` —— 这个函数是全仓唯一的那个认法 ✓ 不另写一份 ✗）
   *   · `list()` 的返回值**一个字都没变**（页面候选那一列只认名字 ✓ 不破坏既有调用方 ✓）
   *
   * 🔴 与既有那条纪律同一条：**读不到 ⇒ `ok:false` + 原因**，不静默兜底 ✗
   *   （**空券关联 ≠ 读不到** —— 那条就是"不是券"，`ok:true` ✓ 两件事不许混 ✗）。
   */
  const listWithVouchers = async () => {
    const stamp = now();
    const fresh = cache && (Number(ttlMs) <= 0 ? false : stamp - cache.at < Number(ttlMs));
    const loaded = await load(stamp, fresh);
    if (!loaded.ok) return { ok: false, items: [], reason: loaded.reason, error: loaded.error };
    return { ok: true, items: cache.detailed, cached: loaded.cached === true };
  };

  return {
    list, listWithVouchers, tableKey, fieldName, voucherFieldName, ttlMs,
  };
};

module.exports = { createPaymentMethodsService, orderWithPreferred };
