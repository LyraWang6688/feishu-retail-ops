'use strict';

/**
 * 抖音团购券 · **券目录只读同步**（比对，不写表）。
 *
 * 数据来源（2026-11-09 实测）：
 *   · 商品线上列表 `GET /goodlife/v1/goods/product/online/query/` → 名称/状态/上架时间
 *   · 商品单品详情 `GET /goodlife/v1/goods/product/online/get/` → **佣金费率**（列表里是 0，不准）
 *   · 批量查 SKU `GET /goodlife/v1/goods/sku/get/` → 售价 `actual_amount`、面值 `origin_amount`（分）
 * 对账键：飞书「团购券管理.券ID」=== 抖音 `product_id` / `sku_id`。
 *
 * 🔴 只读：只返回逐行差异（名称/售价/面值），**一个字都不写飞书**。
 */

const { logInfo, logWarn } = require('../../utils/logger');
const { createVoucherCatalogSyncConfig } = require('../../config/voucherCatalogSync');

const textOf = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === 'object' ? item.text ?? '' : item)).join('');
  if (typeof value === 'object') return value.text ?? '';
  return String(value);
};

/** 金额字符串 → 分（'89.9' → 8990）。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** epoch 毫秒/秒 → 上海自然日 `YYYY-MM-DD`（取不到返回 ''）。 */
const dayOf = (value, unit = 'ms') => {
  const raw = typeof value === 'number' ? value : Number(textOf(value));
  if (!Number.isFinite(raw) || raw <= 0) return '';
  const ms = unit === 's' ? raw * 1000 : raw;
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
};

const toCents = (value) => {
  const cleaned = textOf(value).replace(/[^\d.-]/g, '');
  if (!cleaned.trim()) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
};

const createVoucherCatalogSync = ({
  gateway,
  laike,
  config = createVoucherCatalogSyncConfig(),
  logger = { logInfo, logWarn },
} = {}) => {
  if (!gateway) throw new Error('VoucherCatalogSync requires gateway');
  if (!laike || typeof laike.fetchProductList !== 'function') throw new Error('VoucherCatalogSync requires laike client');

  const run = async () => {
    if (!config.accountId) {
      logger.logWarn('douyin.voucher_catalog.skipped', { reason: 'account_missing' });
      return { ok: false, reason: 'account_missing', message: config.texts.accountMissing };
    }

    const fields = gateway.table('groupBuyVoucher').fields;
    const rows = await gateway.listAll('groupBuyVoucher');

    // ⚠️ `count > 50` 会静默返回空列表（实测 count=100 ⇒ 0 条）⇒ 固定 50。
    const list = await laike.fetchProductList({ accountId: config.accountId, count: 50, cursor: 0 });
    if (!list.ok) return { ok: false, reason: list.reason, message: list.message };

    const catalog = [];
    for (const item of list.data?.products || []) {
      const product = item?.product || {};
      const productId = textOf(product.product_id);
      if (!productId) continue;

      const skuRes = await laike.fetchSkus({ accountId: config.accountId, productId });
      const sku = skuRes.ok ? (skuRes.data?.skus || [])[0] : null;

      const detailRes = await laike.fetchProduct({ accountId: config.accountId, productIds: [productId] });
      const detail = detailRes.ok ? (detailRes.data?.product_onlines || [])[0] : null;

      catalog.push({
        productId,
        name: textOf(product.product_name),
        onlineStatus: Number(item.online_status),
        priceCents: sku ? Number(sku.actual_amount) : null,
        faceCents: sku ? Number(sku.origin_amount) : null,
        commissionRate: Number(detail?.commission_info?.platform_take_rate ?? NaN),
        commissionDetail: detail?.commission_info?.commission_detail_list || [],
        listedDay: dayOf(product.sold_start_time, 's'),
        delistedDay: dayOf(product.sold_end_time, 's'),
        listedMs: Number(product.sold_start_time) > 0 ? Number(product.sold_start_time) * 1000 : null,
        delistedMs: Number(product.sold_end_time) > 0 ? Number(product.sold_end_time) * 1000 : null,
      });
    }

    const byId = new Map(catalog.map((entry) => [entry.productId, entry]));
    const matched = [];
    const unmatchedVouchers = [];
    const failedWrites = [];

    for (const row of rows) {
      const voucherId = textOf(row.fields?.[fields.externalId]).trim();
      const entry = byId.get(voucherId);
      if (!entry) {
        unmatchedVouchers.push({ recordId: row.record_id, voucherId });
        continue;
      }
      byId.delete(voucherId);

      const diffs = {};
      // 销售状态：1=在售、2=下架（业务负责人 2026-11-10 确认）；未知码不猜。
      const statusNow = textOf(row.fields?.[fields.status]).trim();
      const statusTo = (config.statusMap || {})[entry.onlineStatus];
      if (statusTo && statusNow !== statusTo) diffs.status = { from: statusNow, to: statusTo };
      const currentName = textOf(row.fields?.[fields.name]).trim();
      if (currentName !== entry.name) diffs.name = { from: currentName, to: entry.name };
      if (entry.priceCents !== null && toCents(row.fields?.[fields.purchasePrice]) !== entry.priceCents) {
        diffs.priceCents = { from: toCents(row.fields?.[fields.purchasePrice]), to: entry.priceCents };
      }
      if (entry.faceCents !== null && toCents(row.fields?.[fields.faceValue]) !== entry.faceCents) {
        diffs.faceCents = { from: toCents(row.fields?.[fields.faceValue]), to: entry.faceCents };
      }
      // ⚠️ 只报差异：时间列**代码不写**（AGENTS：只有 receivedAt 允许写）。
      const listedNow = dayOf(row.fields?.[fields.listedAt]);
      if (fields.listedAt && entry.listedDay && listedNow !== entry.listedDay) {
        diffs.listedDay = { from: listedNow, to: entry.listedDay, readOnly: true };
      }
      const delistedNow = dayOf(row.fields?.[fields.delistedAt]);
      if (fields.delistedAt && entry.delistedDay && delistedNow !== entry.delistedDay) {
        diffs.delistedDay = { from: delistedNow, to: entry.delistedDay, readOnly: true };
      }

      // ⭐ 2026-11-10（业务负责人）：「需要同步的是这些字段，接口返回什么就写什么」
      //   ⇒ 名称/售价/面值/销售状态/上架日期/下架日期（平台结算款与结算规则接口拿不到、不写；
      //   「种类」与公式列「团购券」不写）。
      // ⚠️ gateway.update 收的是**语义键**（name/purchasePrice/…），不是中文列名 ——
      //    传中文列名会抛「未配置语义字段」（2026-11-10 自测抓到的坑）。
      const patch = {};
      if (diffs.name) patch.name = entry.name;
      if (diffs.priceCents && fields.purchasePrice) patch.purchasePrice = entry.priceCents / 100;
      if (diffs.faceCents && fields.faceValue) patch.faceValue = entry.faceCents / 100;
      if (diffs.status && fields.status) patch.status = diffs.status.to;
      if (diffs.listedDay && fields.listedAt && entry.listedMs && config.writeDates !== false) {
        patch.listedAt = entry.listedMs;
      }
      if (diffs.delistedDay && fields.delistedAt && entry.delistedMs && config.writeDates !== false) {
        patch.delistedAt = entry.delistedMs;
      }

      let written = false;
      if (config.write !== false && Object.keys(patch).length) {
        try {
          await gateway.update('groupBuyVoucher', row.record_id, patch);
          written = true;
          logger.logInfo('douyin.voucher_catalog.written', {
            record_id: row.record_id, voucher_id: voucherId, fields: Object.keys(patch),
          });
        } catch (error) {
          failedWrites.push({ recordId: row.record_id, voucherId, error: String(error?.message || error).slice(0, 200) });
          logger.logWarn('douyin.voucher_catalog.write_failed', {
            record_id: row.record_id, voucher_id: voucherId, error: String(error?.message || error).slice(0, 200),
          });
        }
      }

      matched.push({
        recordId: row.record_id,
        voucherId,
        name: entry.name,
        priceCents: entry.priceCents,
        faceCents: entry.faceCents,
        onlineStatus: entry.onlineStatus,
        salesStatus: (config.statusMap || {})[entry.onlineStatus] || '',
        commissionRate: entry.commissionRate,
        listedDay: entry.listedDay,
        delistedDay: entry.delistedDay,
        changed: Object.keys(diffs).length > 0,
        written,
        diffs,
      });
    }

    const summary = {
      ok: true,
      accountId: config.accountId,
      voucherRows: rows.length,
      catalogProducts: catalog.length,
      matched: matched.filter((item) => item.changed).length,
      written: matched.filter((item) => item.written).length,
      failedWrites,
      unchanged: matched.filter((item) => !item.changed).length,
      unmatchedVouchers,
      unmatchedProducts: [...byId.values()],
      rows: matched,
    };
    logger.logInfo('douyin.voucher_catalog.compared', {
      voucher_rows: summary.voucherRows, catalog_products: summary.catalogProducts, changed: summary.matched,
    });
    return summary;
  };

  return { run };
};

module.exports = { createVoucherCatalogSync, toCents };
