'use strict';

const express = require('express');

const { PAGE_TOKEN, pageTokenCookie } = require('./scanPage/pageToken');
const { SCAN_DRAFT_BOX } = require('../config/scanDraftBox');
const { createScanDraftBoxService } = require('../services/scanDraftBoxService');
const { logError } = require('../utils/logger');

/**
 * ⭐⭐ **工作台「销售 → 订单列表 → 草稿单」的读侧 / 清空 / 回扫码页**（task-11）。
 *
 * 业务口径：草稿**只是本地中间态**（`data/scan_sessions/`）——
 *   · 这里**只读**它、**只清**它；**不写任何业务表 / 飞书 Base** ✗
 *   · 已提交成功的单不出现（`completeSale` 清空 lines ⇒ 天然过滤 ✓）
 *   · 按**当前登录的飞书用户**隔离（会话键里的 openId；不串单 ✓）
 *
 * 🔴 鉴权：**不新开一套** —— 本 router 由 `routes/workbench/sales.js` 在
 *   `router.use(requireWorkbenchAccess)` **之后**挂进来 ⇒ 503 / 401 / 403 与其它工作台接口同一道闸门 ✓
 * 🔴 不返回 `open_id` / 会话键 / 页面 token / `master_record_id`：`draft_id` = 会话 id（openId 的 sha 前 16 位）✓
 */
const createWorkbenchSalesDraftsRouter = ({ service, sessions } = {}) => {
  const router = express.Router();
  const box = () => service || createScanDraftBoxService({ sessions });
  const openIdOf = (req) => String(req.workbenchUser?.open_id || '');

  /** `GET /sales/drafts`：我这一份草稿箱（含损坏文件计数 —— **只提示、不删**）。 */
  router.get('/sales/drafts', async (req, res) => {
    try {
      const result = await box().list({ openId: openIdOf(req) });
      return res.json({ success: true, ...result, texts: SCAN_DRAFT_BOX.texts });
    } catch (error) {
      // ⚠️ 不新造事件名（事件目录是自动生成的共享件）⇒ 复用既有的工作台读失败事件 + scope 区分。
      logError('workbench.sales.orders.failed', {
        request_id: req.requestId, scope: 'draft_box_list', error: error.message,
      });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  /** `POST /sales/drafts/clear`：只清本地那一份（**零 Base 写**）；写中的草稿拒绝（防重复建单）。 */
  router.post('/sales/drafts/clear', async (req, res) => {
    try {
      const result = await box().clear({
        openId: openIdOf(req),
        draftId: req.body?.draftId || req.body?.draft_id,
        requestId: req.requestId,
      });
      return res.json({ success: true, ...result, message: SCAN_DRAFT_BOX.texts.clearDone });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 404;
      return res.status(status).json({ success: false, code: String(error?.code || ''), error: error.message });
    }
  });

  /**
   * `GET /sales/drafts/:draftId/resume`：**浏览器直接导航**（不是 fetch）——
   *   ① 把该草稿**自己的**页面 token 写成 `scan_page_id` cookie（旧页面没有 token ⇒ 清掉 cookie）；
   *   ② 302 到 `/r/<首行货品的记录 ID>?from=sales`（扫码页会渲染**同一份**「本单 N 双」）。
   * ⚠️ token **不进 URL**（只在 Set-Cookie 里）；目标路径由服务端拿自己的 basePath 拼，前端改不了。
   */
  router.get('/sales/drafts/:draftId/resume', async (req, res) => {
    try {
      const target = await box().resumeTarget({ openId: openIdOf(req), draftId: req.params?.draftId });
      if (target.page_token) {
        res.append('Set-Cookie', pageTokenCookie(target.page_token));
      } else {
        // 旧页面（没有 per-page token）⇒ 不带 cookie 才是它原来那一份（顺手清掉可能存在的旧 cookie）
        res.append('Set-Cookie', `${PAGE_TOKEN.cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
      }
      const path = String(target.target_path || '');
      if (!path.startsWith('/')) return res.status(500).json({ success: false, error: SCAN_DRAFT_BOX.texts.resumeFailed });
      return res.redirect(302, path);
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 404;
      return res.status(status).json({ success: false, code: String(error?.code || ''), error: error.message });
    }
  });

  return router;
};

module.exports = { createWorkbenchSalesDraftsRouter };
