/**
 * 扫码页路由：**`GET /s/:number`**（`number` = 「编号」= `货号|颜色|类别`，URL 编码过的）。
 *
 * 这一页就是标签二维码指向的那个地址 —— 二维码内容的唯一真源是
 * `config/tagQrCode.js` 的 `scanUrl.urlTemplate`（`https://hm.bamamei.online/s/{编号}`），
 * 本文件**不抄那份模板**，只用 `config/scanPage.js` 里的挂载点与路径段。
 *
 * 挂载与准入（**先读代码再动**的结果）：
 *   · `app.js` 把本 router 挂在 **`SCAN_PAGE.route.basePath`（`/s`）** 上，
 *     **不在 `/api/*` 之下** —— 那一段被 `API_KEY`（`x-api-key`）保护，
 *     而扫码的人是**手机浏览器直接打开**的页面，没有那个头，挂过去必被挡；
 *   · 准入用的是**工作台那一道**闸门（`routes/workbench.js` 里的 `requireWorkbenchAccess`，
 *     两处共用**同一个函数**）：认证没启用 503 / 未登录 401 / 白名单外 403，
 *     **没有新开一套鉴权**；
 *   · 第一版**只读**：service 只 `listAll`，本文件连一个写调用都没有。
 *
 * ⚠️ 手机浏览器上的 401/403/503 目前是**工作台那套 JSON**（与工作台一字不差——
 *    brief 要求"既有语义不变"）。给她更好的做法是"跳到飞书登录再回来"，
 *    那是**下一版**的事，本轮不动鉴权语义（见交付报告"发现但没动"一节）。
 */
const express = require('express');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createScanPageService } = require('../services/scanPageService');
const { renderScanPage, renderScanMessagePage } = require('../views/scanPageRenderer');
const { requireWorkbenchAccess } = require('./workbench');
const { SCAN_PAGE } = require('../config/scanPage');
const { logError, logWarn } = require('../utils/logger');

// 飞书偶发「数据未准备好」(1254607)：回 503 + Retry-After，让她"过几秒刷新"，
// 这与工作台查询接口的口径一致（`controllers/workbenchController.js`）。
const isDataNotReady = (error) => /1254607|data not ready|数据未准备好/i.test(String(error?.message || error || ''));

// 业务数据（库存）不进任何缓存；顺带补 nosniff（HTML 由我们拼，但习惯性加上）。
const sendHtml = (res, status, html) => res.status(status)
  .type('html')
  .set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  .set('X-Content-Type-Options', 'nosniff')
  .send(html);

const createScanPageRouter = (options = {}) => {
  const config = options.config || SCAN_PAGE;
  const service = options.service || createScanPageService(options.gateway || new V1BitableGateway(), { config });
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  });
  router.use(requireWorkbenchAccess);

  const message = ({ title, body, number = '', requestId = '', retryHint = '' }) => renderScanMessagePage(
    { title, body, number, requestId, retryHint }, config,
  );

  const badNumberPage = (res, status, requestId, number = '') => sendHtml(res, status, message({
    title: config.texts.badNumberTitle,
    body: config.texts.badNumberBody,
    number,
    requestId,
  }));

  const respondFailure = (res, error, requestId) => {
    if (error?.scanLimitExceeded) {
      // service 已经记过 limitExceeded；这里只负责给她一张人话页面（**不显示半张库存表**）。
      return sendHtml(res, 503, message({
        title: config.texts.limitTitle, body: config.texts.limitBody, requestId,
      }));
    }
    if (isDataNotReady(error)) {
      res.set('Retry-After', '5');
      return sendHtml(res, 503, message({
        title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
      }));
    }
    logError(config.events.failed, { request_id: requestId, error: error.message });
    return sendHtml(res, 500, message({
      title: config.texts.errorTitle,
      body: config.texts.errorBody,
      requestId,
      retryHint: config.texts.retryHint,
    }));
  };

  // 只有 `/s` 或 `/s/`（没有编号）：不是 500、也不是白屏，回一张"这个链接不对"。
  router.get('/', (req, res) => {
    logWarn(config.events.badNumber, { request_id: req.requestId, reason: 'missing_number' });
    return badNumberPage(res, 400, req.requestId);
  });

  router.get(config.route.path, async (req, res) => {
    const requestId = req.requestId;
    try {
      // ⚠️ Express 已经把路由参数解码过一次（`%7C` → `|`，未编码的中文也照收）；
      //    service 里再解一次是为了容忍双重编码，并且对孤立 `%` 的输入不抛。
      const view = await service.lookup({ number: req.params.number, requestId });
      if (!view.found) {
        if (view.reason === 'empty') {
          logWarn(config.events.badNumber, { request_id: requestId, reason: 'empty_number' });
          return badNumberPage(res, 400, requestId);
        }
        return sendHtml(res, 404, message({
          title: config.texts.notFoundTitle,
          body: config.texts.notFoundBody,
          number: view.number,
          requestId,
        }));
      }
      return sendHtml(res, 200, renderScanPage(view, config));
    } catch (error) {
      return respondFailure(res, error, requestId);
    }
  });

  /**
   * 路由参数解码失败（例：`/s/50%OFF`、`/s/%zz`）会在**进入上面那个 handler 之前**
   * 由 Express 抛出来（`Failed to decode param`，status 400）。router 级错误中间件能接住它
   * —— 接住是为了**给她一张人话页面**，而不是 Express 默认那行 "Bad Request"。
   * ⚠️ 只挂在 `/s` 这一个 router 上，别的路由的错误不受影响。
   */
  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    logWarn(config.events.badNumber, {
      request_id: req.requestId,
      reason: 'decode_failed',
      path: String(req.originalUrl || '').slice(0, 200),
    });
    return badNumberPage(res, error?.status === 400 ? 400 : 500, req.requestId);
  });

  return router;
};

module.exports = { createScanPageRouter, isDataNotReady };
