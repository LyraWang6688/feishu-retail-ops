'use strict';

const express = require('express');
const { createRateLimit } = require('../middleware/security');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createProductGroupStockService } = require('../services/productGroupStockService');
const { createScanPageService } = require('../services/scanPageService');
const { GROUP_SCAN_PAGE } = require('../config/groupScanPage');
const { SCAN_PAGE } = require('../config/scanPage');
const { renderGroupStockPage, renderGroupPickerPage } = require('../views/groupScanPage');
const { requireWorkbenchAccess } = require('./workbench');
const { enabled: feishuAuthEnabled, getSessionUser, buildLoginStartUrl } = require('./feishuWebAuth');
const { SECURITY } = require('../config/security');
const { logInfo } = require('../utils/logger');



const { SUBJECT_POLICY } = require('../config/subjectPolicy');
const PICKER_REALMS = new Set(SUBJECT_POLICY.scan.pickerRealms);

const createGroupScanPageRouter = (options = {}) => {
  const router = express.Router();
  const gateway = options.gateway || new V1BitableGateway();
  const service = options.service || createProductGroupStockService({ gateway });
  const scanPageService = options.scanPageService || createScanPageService(gateway);

  // 2026-11-27：与 /r 扫码页共用项目自己的限流器。
  //   直接用的 express-rate-limit 在 Nginx 传 X-Forwarded-For、Express trust proxy=false 时
  //   会抛 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR（第一次打开货品组可能 500）。
  router.use(createRateLimit({ max: SECURITY.rateLimit.scanMax, name: 'group_scan_page' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  });
  router.use((req, res, next) => {
    if (feishuAuthEnabled && !getSessionUser(req)) return res.redirect(302, buildLoginStartUrl(req.originalUrl));
    return requireWorkbenchAccess(req, res, next);
  });

  router.get('/:groupId', async (req, res) => {
    const groupId = String(req.params.groupId || '').trim();
    if (!groupId) return res.status(400).type('text').send(GROUP_SCAN_PAGE.texts.missingGroupId);
    try {
      const group = await service.get(groupId);
      if (!group) return res.status(404).type('text').send(GROUP_SCAN_PAGE.texts.notFound);
      const from = String(req.query.from || '').trim();
      if (!PICKER_REALMS.has(from) && group.members.length) {
        group.members = await Promise.all(group.members.map(async (member) => {
          try {
            return { ...member, view: await scanPageService.lookup({ recordId: member.recordId }) };
          } catch (_) {
            return { ...member, view: null };
          }
        }));
      }
      const currentUrl = SCAN_PAGE.route.groupBasePath + '/' + encodeURIComponent(groupId) + (from ? '?from=' + encodeURIComponent(from) : '');
      logInfo('group.scan.viewed', {
        group_id: groupId,
        from: from || '',
        member_count: group.members.length,
        mode: PICKER_REALMS.has(from) ? 'picker' : 'stock',
      });
      const html = PICKER_REALMS.has(from)
        ? renderGroupPickerPage(group, { from, currentUrl })
        : renderGroupStockPage(group, { currentUrl });
      return res.status(200).type('html').send(html);
    } catch (error) {
      return res.status(502).type('text/plain').send(GROUP_SCAN_PAGE.texts.readFailed);
    }
  });

  return router;
};

module.exports = { createGroupScanPageRouter };
