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
const { textValue } = require('./v1BitableGateway');

/**
 * @param {{ listAll: Function }} gateway
 * @param {{ ttlMs?: number, now?: Function, tableKey?: string, fieldName?: string }} [options]
 */
const createPaymentMethodsService = (gateway, options = {}) => {
  if (!gateway) throw new Error('PaymentMethodsService requires gateway');
  const tableKey = options.tableKey || 'paymentMethod';
  const fieldName = options.fieldName
    || V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.name
    || '收款方式';
  const ttlMs = options.ttlMs === undefined ? 5 * 60 * 1000 : Number(options.ttlMs);
  const now = options.now || (() => Date.now());
  let cache = null;

  /** ⭐ 读出表里那几条（按表里的顺序 ✓ 去重 ✓ 去空 ✓）。 */
  const list = async () => {
    const stamp = now();
    if (cache && (Number(ttlMs) <= 0 ? false : stamp - cache.at < Number(ttlMs))) {
      return { ok: true, items: cache.items, cached: true };
    }
    try {
      const rows = await gateway.listAll(tableKey);
      const items = [];
      const seen = new Set();
      for (const row of rows || []) {
        const value = textValue(row?.fields?.[fieldName]).trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        items.push(value);
      }
      cache = { at: stamp, items };
      return { ok: true, items, cached: false };
    } catch (error) {
      // 🔴 读不到 ⇒ **如实**（调用方去说人话 ✓ 不静默兜底 ✗）
      return { ok: false, items: [], reason: 'payment_methods_unreadable', error: error?.message || 'unknown' };
    }
  };

  return { list, tableKey, fieldName, ttlMs };
};

module.exports = { createPaymentMethodsService };
