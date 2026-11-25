'use strict';

/**
 * 配品配置的 HTTP 路由（列表同步，写操作进 PRODUCT_CONFIG_WRITE 异步任务）。
 * 从 routes/workbench/products.js 拆出，避免单文件净增超过 100 行。
 */
const express = require('express');
const { logError, logInfo } = require('../../utils/logger');
const { V1_BITABLE_SCHEMA } = require('../../config/v1BitableSchema');
const { PRODUCT_PROFILE } = require('../../config/productProfile');
const { extraOfAttachment } = require('../../services/driveApi');
const { uploadAcceptanceDocument, safeFileName } = require('../../services/acceptanceDocumentUploadService');
const { listAccessories } = require('../../services/accessoryConfigService');
const { listAccessoryCategories } = require('../../services/accessoryCategoryService');
const { createProductConfigWriteService } = require('../../services/productConfigWriteService');
const { getAsyncJobService } = require('../../services/asyncJobRuntime');

const createWorkbenchAccessoryConfigRoutes = ({ getGateway, asyncJobs } = {}) => {
  const router = express.Router();
  let writes = null;
  const resolveWrites = () => {
    if (!writes) {
      writes = createProductConfigWriteService({
        gateway: getGateway(), asyncJobs: asyncJobs || getAsyncJobService(),
      });
    }
    return writes;
  };

  router.get('/products/accessories', async (req, res) => {
    try {
      const rows = await listAccessories(getGateway());
      return res.json({ success: true, rows });
    } catch (error) {
      logError('workbench.accessories.list_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'accessories_failed' });
    }
  });

  router.get('/products/accessories/categories', async (req, res) => {
    try {
      return res.json({ success: true, categories: await listAccessoryCategories(getGateway()) });
    } catch (error) {
      logError('workbench.accessories.categories_failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: 'accessory_categories_failed' });
    }
  });

  router.post('/products/accessories/categories', async (req, res) => {
    try {
      const accepted = await resolveWrites().submit({
        resource: 'accessoryCategory',
        action: 'create',
        category: req.body?.category,
        submitKey: req.body?.submitKey || req.query?.submitKey,
        ownerOpenId: req.workbenchUser?.open_id,
        operatorName: req.workbenchUser?.name,
      });
      return res.status(202).json({ success: true, accepted: true, job_id: accepted.jobId, toast: accepted.toast });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('workbench.accessories.category_add_failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  router.post('/products/accessories/sample-image', express.raw({ type: 'image/*', limit: '12mb' }), async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || !buffer.length) return res.status(400).json({ success: false, error: 'sample_image_invalid' });
    let rawName = '';
    try { rawName = decodeURIComponent(String(req.get('x-file-name') || '')); } catch { rawName = ''; }
    try {
      const fileToken = await uploadAcceptanceDocument({
        gateway: getGateway(), buffer, fileName: rawName, operation: PRODUCT_PROFILE.accessoryUploadOperation,
      });
      logInfo('workbench.accessories.sample_image_uploaded', {
        request_id: req.requestId, file_name: safeFileName(rawName), token_length: String(fileToken || '').length,
      });
      return res.json({ success: true, file: { file_token: fileToken, file_name: safeFileName(rawName) } });
    } catch (error) {
      logError('workbench.accessories.sample_image_failed', {
        request_id: req.requestId, file_name: rawName, error: error.message,
      });
      return res.status(502).json({ success: false, error: 'sample_image_upload_failed' });
    }
  });

  router.get('/products/accessories/:recordId/sample-image', async (req, res) => {
    try {
      const record = await getGateway().get('accessory', String(req.params?.recordId || '').trim());
      const fields = V1_BITABLE_SCHEMA.tables.accessory.fields;
      const image = (Array.isArray(record?.fields?.[fields.sampleImage]) ? record.fields[fields.sampleImage] : [])
        .find((item) => item?.file_token || item?.fileToken);
      const token = String(image?.file_token || image?.fileToken || '').trim();
      if (!token) return res.status(404).json({ success: false, error: 'sample_image_missing' });
      const buffer = await getGateway().drive.downloadMedia(token, PRODUCT_PROFILE.accessoryDownloadOperation, {
        extra: extraOfAttachment(image),
      });
      res.set('Cache-Control', 'private, max-age=300');
      res.type(String(image?.mime_type || 'image/jpeg'));
      return res.send(buffer);
    } catch (error) {
      logError('workbench.accessories.sample_image_read_failed', {
        request_id: req.requestId, record_id: req.params?.recordId, error: error.message,
      });
      return res.status(502).json({ success: false, error: 'sample_image_read_failed' });
    }
  });

  const submit = async (req, res, action) => {
    try {
      const token = String(req.body?.sampleImageToken || '').trim();
      logInfo('workbench.accessories.write_submitted', {
        request_id: req.requestId, action,
        has_sample_image_token: Boolean(token), token_length: token.length,
      });
      const accepted = await resolveWrites().submit({
        resource: 'accessory',
        action,
        name: req.body?.name,
        category: req.body?.category,
        price: req.body?.price,
        cost: req.body?.cost,
        stockQuantity: req.body?.stockQuantity,
        // 2026-11-25：键名改为 isGift（与「赠品」列对齐）；兼容刚部署时还开着的旧页面。
        isGift: req.body?.isGift ?? req.body?.isAccessory,
        sampleImageToken: token,
        recordId: req.params?.recordId,
        submitKey: req.body?.submitKey || req.query?.submitKey,
        ownerOpenId: req.workbenchUser?.open_id,
        operatorName: req.workbenchUser?.name,
      });
      return res.status(202).json({ success: true, accepted: true, job_id: accepted.jobId, toast: accepted.toast });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError(`workbench.accessories.${action}_failed`, {
        request_id: req.requestId, record_id: req.params?.recordId, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  };

  router.post('/products/accessories', (req, res) => submit(req, res, 'create'));
  router.patch('/products/accessories/:recordId', (req, res) => submit(req, res, 'update'));
  router.delete('/products/accessories/:recordId', (req, res) => submit(req, res, 'delete'));
  return router;
};

module.exports = { createWorkbenchAccessoryConfigRoutes };
