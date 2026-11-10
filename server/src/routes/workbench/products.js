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
const { containsFormula, orFormula } = require('../../services/bitableFilterFormula');

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
      // 图片始终走后端代理，不把飞书附件 token / 临时 URL 暴露给浏览器。
      imageUrl: hasSampleImage && id ? `/api/workbench/products/${encodeURIComponent(id)}/sample-image` : '',
    };
  };

  router.get('/products/search', async (req, res) => {
    const q = String(req.query?.q || '').trim();
    if (!q) return res.json({ success: true, query: '', items: [] });
    try {
      // 优先：飞书 filter 只读匹配行（最多 50 条），不再读整张货品信息。
      // 公式拼装复用唯一实现；值含引号/反斜杠等不安全字符时返回 null ⇒ 回退整表缓存。
      const formula = orFormula([
        containsFormula(field('itemNo'), q),
        containsFormula(field('number'), q),
      ]);
      if (formula) {
        try {
          const rows = await getGateway().listByFilter('product', formula, { maxRecords: PRODUCT_PROFILE.searchLimit });
          return res.json({ success: true, query: q, items: rows.map(itemOf) });
        } catch (error) {
          // filter 失败 / 飞书不支持该公式 ⇒ 回退旧路径，保证不丢结果。
          logError('workbench.product_profile.search_filter_failed', { request_id: req.requestId, error: error.message });
        }
      }
      const rows = await getConfigRows({ gateway: getGateway(), tableKey: 'product' });
      const needle = q.toLowerCase();
      const items = rows
        .map(itemOf)
        .filter((item) => item.itemNo.toLowerCase().includes(needle) || item.number.toLowerCase().includes(needle))
        .slice(0, PRODUCT_PROFILE.searchLimit);
      return res.json({ success: true, query: q, items });
    } catch (error) {
      logError('workbench.product_profile.search_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'product_search_failed' });
    }
  });

  router.get('/products/incomplete', async (req, res) => {
    try {
      const rows = await getConfigRows({ gateway: getGateway(), tableKey: 'product' });
      const groups = new Map();
      for (const row of rows) {
        const missing = textValue(row?.fields?.[PRODUCT_PROFILE.missingField]).trim();
        if (!missing || missing === PRODUCT_PROFILE.completeValue) continue;
        const item = itemOf(row);
        if (!item.recordId || !item.number) continue;
        item.recordUrl = recordUrl({
          appToken: V1_BITABLE_SCHEMA.appToken,
          tableId: table.tableId,
          recordId: item.recordId,
        });
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
