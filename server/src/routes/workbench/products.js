'use strict';

/**
 * 工作台「货品资料」页的只读接口：
 *   · GET /products/search?q=       货号 / 编号模糊搜索（读 product 配置缓存）
 *   · GET /products/incomplete      缺失信息按实际字段值动态分组（不硬编码分类）
 *   · GET /products/:id/sample-image 代理飞书附件（浏览器拿不到附件鉴权）
 *
 * 鉴权 / no-store 由父 router `routes/workbench.js` 统一加，这里不新开鉴权。
 * 所有响应文案都是机器可读的；用户可见中文在前端 config。
 */
const express = require('express');
const { logError } = require('../../utils/logger');
const { V1BitableGateway, textValue } = require('../../services/v1BitableGateway');
const { createProductSampleImageCache } = require('../../services/productSampleImageCache');
const { getConfigRows } = require('../../services/configTableCache');
const { V1_BITABLE_SCHEMA } = require('../../config/v1BitableSchema');
const { recordUrl } = require('../../utils/feishuLinks');
const { PRODUCT_PROFILE } = require('../../config/productProfile');
const { productGapsOf, gapItemsOf } = require('../../services/productGaps');
const { extraOfAttachment } = require('../../services/driveApi');
const { containsFormula } = require('../../services/bitableFilterFormula');
const { getProductSearchSnapshot, invalidateProductSearchSnapshot } = require('../../services/productSearchSnapshot');
const {
  listProductFeatures,
} = require('../../services/productFeatureTagService');
const { createProductConfigWriteService } = require('../../services/productConfigWriteService');
const { getAsyncJobService } = require('../../services/asyncJobRuntime');
const { createWorkbenchAccessoryConfigRoutes } = require('./accessoryConfig');

const createWorkbenchProductRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  let gateway = options.gateway || null;
  const getGateway = () => {
    if (!gateway) gateway = new V1BitableGateway();
    return gateway;
  };
  const table = V1_BITABLE_SCHEMA.tables.product;
  const field = (key) => table.fields[key];
  // ⭐ #1204：样例图 token 短 TTL 缓存（命中 ⇒ 0 次记录读）+ 连续限流熔断。
  const imageCache = options.sampleImageCache || createProductSampleImageCache({
    ttlMs: PRODUCT_PROFILE.sampleImageCacheTtlMs,
    maxEntries: PRODUCT_PROFILE.sampleImageCacheMax,
  });
  let productConfigWrites = null;
  const resolveProductConfigWrites = () => {
    if (!productConfigWrites) {
      productConfigWrites = createProductConfigWriteService({
        gateway: getGateway(),
        asyncJobs: options.asyncJobs || getAsyncJobService(),
      });
    }
    return productConfigWrites;
  };
  const breaker = { failures: 0, lastFailureAt: 0, openUntil: 0 };
  const breakerConfig = PRODUCT_PROFILE.sampleImageBreaker;
  const noteImageFailure = () => {
    const at = Date.now();
    if (breaker.lastFailureAt && at - breaker.lastFailureAt > breakerConfig.windowMs) breaker.failures = 0;
    breaker.lastFailureAt = at;
    breaker.failures += 1;
    if (breaker.failures >= breakerConfig.failures) {
      breaker.openUntil = at + breakerConfig.cooldownMs;
      breaker.failures = 0;
    }
  };
  const retryAfterSeconds = () => Math.max(1, Math.ceil((breaker.openUntil - Date.now()) / 1000));

  const itemOf = (row) => {
    const fields = row?.fields || {};
    const id = String(row?.record_id || '');
    // ⭐ 2026-11-17：三样（商品信息 / 标签信息 / 样例图）走**唯一判定** `productGapsOf`，
    //   与扫码页「资料不齐」链接同一份，避免两处规则漂移。
    const gaps = productGapsOf({
      fields,
      fieldNames: {
        completeness: field('completeness'),
        tagCompleteness: field('tagCompleteness'),
        sampleImage: field('sampleImage'),
      },
    });
    return {
      recordId: id,
      number: textValue(fields[field('number')]).trim(),
      itemNo: textValue(fields[field('itemNo')]).trim(),
      color: textValue(fields[field('color')]).trim(),
      category: textValue(fields[field('category')]).trim(),
      hasSampleImage: gaps.hasSampleImage,
      missingProduct: gaps.productText,
      missingTag: gaps.tagText,
      // ⭐ 缺失 chips 的**文案由服务端唯一判定给出**（扫码页「资料不齐」用的是同一份）。
      issues: gapItemsOf(gaps),
      // 图片始终走后端代理，不把飞书附件 token / 临时 URL 暴露给浏览器。
      imageUrl: gaps.hasSampleImage && id ? `/api/workbench/products/${encodeURIComponent(id)}/sample-image` : '',
      // 搜索结果卡片直接跳到「货品信息」对应记录。
      recordUrl: recordUrl({ appToken: V1_BITABLE_SCHEMA.appToken, tableId: table.tableId, viewId: table.viewId, recordId: id }),
    };
  };

  /**
   * 货品全量搜索（货号模糊匹配）：
   *   · 货品上新搜索、货品完善搜索框共用；
   *   · 不做「待完善」过滤，搜索范围就是货品信息全量。
   */
  const searchProductItems = async (q, requestId) => {
    const needle = q.toLowerCase();
    let rows;
    try {
      // 快照优先：只读内存，不被 record_changed / 样例图同步打穿；过期时后台刷新。
      // 只模糊匹配「货号」，不匹配「编号」。
      rows = await getProductSearchSnapshot({ gateway: getGateway() });
    } catch (snapshotError) {
      logError('workbench.product_profile.search_snapshot_failed', {
        request_id: requestId, error: snapshotError.message,
      });
      // 冷启动快照失败：再试一次飞书 filter（只读货号）；仍然失败才抛。
      const formula = containsFormula(field('itemNo'), q);
      if (!formula) throw snapshotError;
      try {
        return (await getGateway().listByFilter('product', formula, { maxRecords: PRODUCT_PROFILE.searchLimit })).map(itemOf);
      } catch (filterError) {
        logError('workbench.product_profile.search_filter_failed', {
          request_id: requestId, error: filterError.message,
        });
        throw snapshotError;
      }
    }
    let items = rows
      .map(itemOf)
      .filter((item) => item.itemNo.toLowerCase().includes(needle))
      .slice(0, PRODUCT_PROFILE.searchLimit);
    // ⭐ 2026-11-17：刚新增的货品可能还没进快照 ⇒ 快照 0 命中时按货号直接 filter 兜底一次，
    //   查到就返回，并让下一次快照刷新（新增后立刻可搜，不用等 5 分钟 TTL）。
    if (!items.length) {
      try {
        const formula = containsFormula(field('itemNo'), q);
        if (formula) {
          const freshRows = await getGateway().listByFilter('product', formula, { maxRecords: PRODUCT_PROFILE.searchLimit });
          items = freshRows.map(itemOf);
          if (items.length) invalidateProductSearchSnapshot();
        }
      } catch (filterError) {
        logError('workbench.product_profile.search_filter_failed', {
          request_id: requestId, error: filterError.message,
        });
      }
    }
    return items;
  };

  router.get('/products/search', async (req, res) => {
    const q = String(req.query?.q || '').trim();
    if (!q) return res.json({ success: true, query: '', items: [] });
    try {
      const items = await searchProductItems(q, req.requestId);
      return res.json({ success: true, query: q, items });
    } catch (error) {
      logError('workbench.product_profile.search_failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(502).json({ success: false, error: 'product_search_failed' });
    }
  });

  router.get('/products/incomplete', async (req, res) => {
    try {
      const q = String(req.query?.q || '').trim().toLowerCase();
      const rows = await getConfigRows({ gateway: getGateway(), tableKey: 'product' });
      const groups = new Map();
      for (const row of rows) {
        const missing = textValue(row?.fields?.[PRODUCT_PROFILE.missingField]).trim();
        if (!missing || missing === PRODUCT_PROFILE.completeValue) continue;
        const item = itemOf(row);
        if (!item.recordId || !item.number) continue;
        // 「货品完善」只搜非齐备货品；按货号匹配，不按编号匹配。
        if (q && !item.itemNo.toLowerCase().includes(q)) continue;
        if (!groups.has(missing)) groups.set(missing, []);
        groups.get(missing).push(item);
      }
      const out = [...groups.entries()]
        .map(([value, items]) => ({ value, count: items.length, items: items.sort((a, b) => a.number.localeCompare(b.number, 'zh-CN')) }))
        .sort((a, b) => (b.count - a.count) || a.value.localeCompare(b.value, 'zh-CN'));
      return res.json({ success: true, total: out.reduce((sum, group) => sum + group.count, 0), groups: out });
    } catch (error) {
      logError('workbench.product_profile.incomplete_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'product_incomplete_failed' });
    }
  });

  router.get('/products/features', async (req, res) => {
    try {
      return res.json({ success: true, ...await listProductFeatures(getGateway()) });
    } catch (error) {
      logError('workbench.product_features.list_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'product_features_failed' });
    }
  });

  router.post('/products/features/:key/tags', async (req, res) => {
    try {
      const accepted = await resolveProductConfigWrites().submit({
        resource: 'feature', action: 'create', dimension: req.params?.key, tag: req.body?.tag,
        submitKey: req.body?.submitKey, ownerOpenId: req.workbenchUser?.open_id,
        operatorName: req.workbenchUser?.name,
      });
      return res.status(202).json({ success: true, accepted: true, job_id: accepted.jobId, toast: accepted.toast });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('workbench.product_features.add_failed', {
        request_id: req.requestId, key: req.params?.key, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  router.patch('/products/features/:key/tags/:recordId', async (req, res) => {
    try {
      const accepted = await resolveProductConfigWrites().submit({
        resource: 'feature', action: 'update', dimension: req.params?.key, tag: req.body?.tag,
        recordId: req.params?.recordId, submitKey: req.body?.submitKey,
        ownerOpenId: req.workbenchUser?.open_id, operatorName: req.workbenchUser?.name,
      });
      return res.status(202).json({ success: true, accepted: true, job_id: accepted.jobId, toast: accepted.toast });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('workbench.product_features.update_failed', {
        request_id: req.requestId, key: req.params?.key, record_id: req.params?.recordId, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  router.delete('/products/features/:key/tags/:recordId', async (req, res) => {
    try {
      const accepted = await resolveProductConfigWrites().submit({
        resource: 'feature', action: 'delete', dimension: req.params?.key,
        recordId: req.params?.recordId, submitKey: req.body?.submitKey,
        ownerOpenId: req.workbenchUser?.open_id, operatorName: req.workbenchUser?.name,
      });
      return res.status(202).json({ success: true, accepted: true, job_id: accepted.jobId, toast: accepted.toast });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('workbench.product_features.delete_failed', {
        request_id: req.requestId, key: req.params?.key, record_id: req.params?.recordId, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  });


  router.use(createWorkbenchAccessoryConfigRoutes({ getGateway, asyncJobs: options.asyncJobs }));

  router.get('/products/completion', async (req, res) => {
    try {
      // 搜索框：继续用当前 completion 接口，但 q 的范围是「货品信息全量」，
      // 不限制在待完善分组里（她要搜到已完善的货品去修改）。
      const q = String(req.query?.q || '').trim();
      if (q) {
        const items = await searchProductItems(q, req.requestId);
        return res.json({ success: true, query: q, items });
      }
      const rows = await getConfigRows({ gateway: getGateway(), tableKey: 'product' });
      const all = rows.map(itemOf).filter((item) => item.recordId && item.number);
      const dimensions = [
        {
          ...PRODUCT_PROFILE.completionDimensions[0],
          items: all.filter((item) => !item.hasSampleImage),
        },
        {
          ...PRODUCT_PROFILE.completionDimensions[1],
          items: all.filter((item) => item.missingProduct && item.missingProduct !== PRODUCT_PROFILE.completeValue),
        },
        {
          ...PRODUCT_PROFILE.completionDimensions[2],
          items: all.filter((item) => item.missingTag && item.missingTag !== PRODUCT_PROFILE.completeValue),
        },
      ].map((dimension) => ({
        ...dimension,
        count: dimension.items.length,
        items: dimension.items
          .sort((a, b) => a.number.localeCompare(b.number, 'zh-CN'))
          .slice(0, PRODUCT_PROFILE.completionLimit),
      }));
      const total = new Set(dimensions.flatMap((dimension) => dimension.items.map((item) => item.recordId))).size;
      return res.json({ success: true, total, dimensions });
    } catch (error) {
      logError('workbench.product_profile.completion_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'product_completion_failed' });
    }
  });

  router.get('/products/:recordId', async (req, res) => {
    const recordId = String(req.params?.recordId || '').trim();
    if (!recordId) return res.status(400).json({ success: false, error: 'missing_record_id' });
    try {
      const record = await getGateway().get('product', recordId);
      if (!record) return res.status(404).json({ success: false, error: 'product_not_found' });
      return res.json({ success: true, item: itemOf(record) });
    } catch (error) {
      logError('workbench.product_profile.product_failed', {
        request_id: req.requestId, record_id: recordId, error: error.message,
      });
      return res.status(502).json({ success: false, error: 'product_failed' });
    }
  });

  router.get('/products/:recordId/sample-image', async (req, res) => {
    const recordId = String(req.params?.recordId || '').trim();
    if (!recordId) return res.status(400).json({ success: false, error: 'missing_record_id' });
    // ⭐ #1204：熔断窗口内直接回 503 + Retry-After（页面提示"稍后刷新"），不再打飞书。
    if (breaker.openUntil > Date.now()) {
      res.set('Retry-After', String(retryAfterSeconds()));
      return res.status(503).json({ success: false, error: 'sample_image_throttled' });
    }
    try {
      let entry = imageCache.get(recordId);
      if (!entry) {
        // 页面加载类读：**不重试**（重试只会放大限流），限流由 503/熔断兜住。
        const record = await getGateway().get('product', recordId, { retry: false });
        const images = record?.fields?.[field('sampleImage')];
        const attachment = Array.isArray(images) ? images[0] : null;
        const fileToken = String(attachment?.file_token || attachment?.id || '').trim();
        if (!fileToken) return res.status(404).json({ success: false, error: 'sample_image_missing' });
        entry = {
          fileToken,
          type: String(attachment?.type || 'image/jpeg'),
          // ⭐ 2026-11-17：高级权限 Base 的附件下载必须带 extra（从附件 tmp_url 取）。
          extra: extraOfAttachment(attachment),
        };
        imageCache.set(recordId, entry);
      }
      const etag = `W/"${entry.fileToken}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, max-age=300, must-revalidate');
      if (String(req.headers['if-none-match'] || '') === etag) return res.status(304).end();
      const buffer = await getGateway().drive.downloadMedia(
        entry.fileToken, 'download product sample image', { extra: entry.extra },
      );
      res.set('Content-Type', entry.type);
      breaker.failures = 0;
      return res.send(buffer);
    } catch (error) {
      const message = String(error?.message || '');
      const dataNotReady = /1254607|data not ready|数据未准备好/i.test(message)
        || /1254607/.test(String(error?.code || ''));
      logError('workbench.product_profile.sample_image_failed', {
        request_id: req.requestId, record_id: recordId, error: message, throttled: dataNotReady,
      });
      if (dataNotReady) {
        noteImageFailure();
        res.set('Retry-After', '5');
        return res.status(503).json({ success: false, error: 'sample_image_not_ready' });
      }
      return res.status(502).json({ success: false, error: 'sample_image_failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchProductRoutes };
