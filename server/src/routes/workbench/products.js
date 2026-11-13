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
const { getConfigRows } = require('../../services/configTableCache');
const { V1_BITABLE_SCHEMA } = require('../../config/v1BitableSchema');
const { recordUrl } = require('../../utils/feishuLinks');
const { PRODUCT_PROFILE } = require('../../config/productProfile');
const { containsFormula } = require('../../services/bitableFilterFormula');
const { getProductSearchSnapshot } = require('../../services/productSearchSnapshot');
const {
  listProductFeatures, addProductFeatureTag, updateProductFeatureTag, deleteProductFeatureTag,
} = require('../../services/productFeatureTagService');

const createWorkbenchProductRoutes = ({ options = {} } = {}) => {
  const router = express.Router();
  let gateway = options.gateway || null;
  const getGateway = () => {
    if (!gateway) gateway = new V1BitableGateway();
    return gateway;
  };
  const table = V1_BITABLE_SCHEMA.tables.product;
  const field = (key) => table.fields[key];

  const itemOf = (row) => {
    const fields = row?.fields || {};
    const id = String(row?.record_id || '');
    const images = fields[field('sampleImage')];
    const hasSampleImage = Array.isArray(images) && images.length > 0;
    return {
      recordId: id,
      number: textValue(fields[field('number')]).trim(),
      itemNo: textValue(fields[field('itemNo')]).trim(),
      color: textValue(fields[field('color')]).trim(),
      category: textValue(fields[field('category')]).trim(),
      hasSampleImage,
      missingProduct: textValue(fields[field('completeness')]).trim(),
      missingTag: textValue(fields[PRODUCT_PROFILE.tagMissingField]).trim(),
      // 图片始终走后端代理，不把飞书附件 token / 临时 URL 暴露给浏览器。
      imageUrl: hasSampleImage && id ? `/api/workbench/products/${encodeURIComponent(id)}/sample-image` : '',
      // 搜索结果卡片直接跳到「货品信息」对应记录。
      recordUrl: recordUrl({ appToken: V1_BITABLE_SCHEMA.appToken, tableId: table.tableId, recordId: id }),
    };
  };

  router.get('/products/search', async (req, res) => {
    const q = String(req.query?.q || '').trim();
    if (!q) return res.json({ success: true, query: '', items: [] });
    const needle = q.toLowerCase();
    try {
      // 快照优先：只读内存，不被 record_changed / 样例图同步打穿；过期时后台刷新。
      // 只模糊匹配「货号」，不匹配「编号」。
      const rows = await getProductSearchSnapshot({ gateway: getGateway() });
      const items = rows
        .map(itemOf)
        .filter((item) => item.itemNo.toLowerCase().includes(needle))
        .slice(0, PRODUCT_PROFILE.searchLimit);
      return res.json({ success: true, query: q, items });
    } catch (snapshotError) {
      logError('workbench.product_profile.search_snapshot_failed', {
        request_id: req.requestId, error: snapshotError.message,
      });
      // 冷启动快照失败：再试一次飞书 filter（只读货号）；仍然失败才回 502。
      try {
        const formula = containsFormula(field('itemNo'), q);
        if (!formula) throw snapshotError;
        const rows = await getGateway().listByFilter('product', formula, { maxRecords: PRODUCT_PROFILE.searchLimit });
        return res.json({ success: true, query: q, items: rows.map(itemOf) });
      } catch (filterError) {
        logError('workbench.product_profile.search_filter_failed', {
          request_id: req.requestId, error: filterError.message,
        });
        return res.status(502).json({ success: false, error: 'product_search_failed' });
      }
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
      const result = await addProductFeatureTag(getGateway(), req.params?.key, req.body?.tag);
      return res.json({ success: true, ...result });
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
      const result = await updateProductFeatureTag(getGateway(), req.params?.key, req.params?.recordId, req.body?.tag);
      return res.json({ success: true, ...result });
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
      const result = await deleteProductFeatureTag(getGateway(), req.params?.key, req.params?.recordId);
      return res.json({ success: true, ...result });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('workbench.product_features.delete_failed', {
        request_id: req.requestId, key: req.params?.key, record_id: req.params?.recordId, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  router.get('/products/completion', async (req, res) => {
    try {
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
    try {
      const record = await getGateway().get('product', recordId);
      const images = record?.fields?.[field('sampleImage')];
      const attachment = Array.isArray(images) ? images[0] : null;
      const fileToken = String(attachment?.file_token || attachment?.id || '').trim();
      if (!fileToken) return res.status(404).json({ success: false, error: 'sample_image_missing' });
      const buffer = await getGateway().drive.downloadMedia(fileToken, 'download product sample image');
      res.set('Content-Type', String(attachment?.type || 'image/jpeg'));
      res.set('Cache-Control', 'private, max-age=300');
      return res.send(buffer);
    } catch (error) {
      logError('workbench.product_profile.sample_image_failed', {
        request_id: req.requestId, record_id: recordId, error: error.message,
      });
      return res.status(502).json({ success: false, error: 'sample_image_failed' });
    }
  });

  return router;
};

module.exports = { createWorkbenchProductRoutes };
