/**
 * 扫码页路由：**`GET /s/:number`**（`number` = 「编号」= `货号|颜色|类别`，URL 编码过的）
 * ＋ **`POST /s/:number`**（页面上那两个**写入口**：销售建单 / 补货报单）。
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
 *     两处共用**同一个函数**）：认证没启用 503 / 未登录 302 去登录 / 白名单外 403，
 *     **没有新开一套鉴权**；
 *   · `GET` 是**只读**的（service 只 `listAll` / `listByFilter`）；
 *   · `POST` 是**写入口**（2026-10-08 加），但本文件里**没有一行写库代码**：
 *     全部交给 `services/scanWriteService.js`，而它只调**既有业务层**
 *     （销售入账 / 采购申请发布）。字段、动作名、文案、默认收款方式、幂等键前缀
 *     全在 `config/scanWrite.js`。
 *
 * 🔴 入口隔离（`docs/entry-isolation-2026-10-08.md`）：扫码入口与群聊入口**只共享业务层**。
 *   会话在 `data/scan_sessions/`（**自己的**），一个字都不碰 `data/lark_mvp_tasks/`；
 *   输入是页面表单（**不经过**任何 AI 解析）；出口是这一页的响应（**不回群、不 patch 卡片**）。
 *
 * 「扫码即用」（2026-10-08 下半场加）：
 *   ⚠️ 她是在**手机浏览器**上扫标签二维码的 —— 手机里没有 `hm.bamamei.online` 的登录
 *   cookie，原来那一版会把工作台那套 **401 JSON** 甩到她脸上。
 *   现在：**未登录 → 302 去 `/api/auth/feishu/start?next=<刚才那一页>`**，登录成功后
 *   自动回到刚才那个扫码页（逻辑与白名单在 `routes/feishuWebAuth.js` +
 *   `config/scanAuthRedirect.js`）。
 *   🔴 **共享闸门 `requireWorkbenchAccess` 的默认语义一个字都没改**
 *   （未启用 503 JSON / 未登录 401 JSON / 白名单外 403 JSON）—— 工作台的 fetch 接口
 *   与既有哨兵用例都钉着它。这里只在**扫码页这一个 router** 上把"未登录"那一种情况
 *   提前接住换成 302，另外两种原样交给下面那道共享闸门。
 *   ⚠️ 作用域是**整个扫码 router**（`/s/` 与 `/s/:number` 都算"扫码页"）：
 *   没登录的人先登录再看页面，页面本身（200/400/404/503）对已登录的人**逐字不变**。
 */
const express = require('express');
const { V1BitableGateway } = require('../services/v1BitableGateway');
const { createScanPageService } = require('../services/scanPageService');
const { createScanWriteService } = require('../services/scanWriteService');
const { renderScanPage, renderScanMessagePage } = require('../views/scanPageRenderer');
// ⚠️ 只借这一个**纯函数**：所选尺码在「样品 + 门盒」有没有货（= 页面上那两个分组的判据）。
const { sellableSizeTexts } = require('../views/scanPageRealm');
const { requireWorkbenchAccess } = require('./workbench');
// ⚠️ 会话读取/解码与回跳校验**复用 feishuWebAuth 里那一份**（`getSessionUser` =
//    `requireWorkbenchAccess` 判 401 用的同一个函数），**不重写第二份**。
const {
  enabled: feishuAuthEnabled,
  getSessionUser,
  buildLoginStartUrl,
  resolveScanNext,
} = require('./feishuWebAuth');
const { SCAN_PAGE } = require('../config/scanPage');
const { SCAN_WRITE, fillText: fillWriteText } = require('../config/scanWrite');
const { SCAN_AUTH_REDIRECT } = require('../config/scanAuthRedirect');
const { logError, logInfo, logWarn } = require('../utils/logger');

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
  const writeConfig = options.writeConfig === undefined ? SCAN_WRITE : options.writeConfig;
  const gateway = options.gateway || new V1BitableGateway();
  const service = options.service || createScanPageService(gateway, { config });
  // ⚠️ 写服务**只为 POST 与"本单还有几双"服务**；`GET` 的库存表一个字都不依赖它。
  //    用例可以注入一个假的（`options.writeService`），`false` = 这一版不挂写入口。
  const writeService = writeConfig && options.writeService !== false
    ? (options.writeService || createScanWriteService({ gateway, config: writeConfig }))
    : null;
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
  });

  /**
   * 「扫码即用」：未登录 → **302** 去飞书登录（登录成功后自动回到刚才那一页）。
   *
   * 判定"未登录"用的是**共享闸门同一套能力**（`feishuWebAuth.enabled` + `getSessionUser`），
   * 不是新写一份：`getSessionUser` 就是 `requireWorkbenchAccess` 判 401 时读会话的那个函数
   * （读 `workbench_session` cookie → HMAC 验签 → 查过期）。
   *
   * 三种准入情况的分工（**共享闸门语义不变**）：
   *   · 认证**没启用** → 这里 `next()`，由共享闸门回 **503 JSON**（一字不变）；
   *   · **没登录**      → 这里回 **302**（本轮唯一的行为变化，只发生在扫码页）；
   *   · **已登录但白名单外** → 这里 `next()`，由共享闸门回 **403 JSON**（一字不变）。
   * ⚠️ 已登录且白名单内的人，下面的页面行为（200/400/404/503）**逐字不变**；
   *    `POST`（写入口）走的是**同一道**闸门，语义也一字不变。
   */
  router.use((req, res, next) => {
    if (!feishuAuthEnabled()) return next();
    if (getSessionUser(req)) return next();
    // 「刚才那一页」= 原 path + 原 query（本 router 挂在 `SCAN_PAGE.route.basePath` 上，
    // `req.originalUrl` 已经含挂载点）。再过一次回跳白名单：只放行扫码页自己，
    // 别的（`//host`、协议、绝对 URL、`/s/../api/...`）一律回落工作台首页。
    const target = resolveScanNext(
      String(req.originalUrl || `${config.route.basePath}${req.url || ''}`),
    );
    logInfo(SCAN_AUTH_REDIRECT.events.loginRedirect, {
      request_id: req.requestId,
      next: String(target).slice(0, 200),
    });
    return res.redirect(302, buildLoginStartUrl(target));
  });

  router.use(requireWorkbenchAccess);

  const message = ({ title, body, number = '', requestId = '', retryHint = '', details = [] }) => renderScanMessagePage(
    { title, body, number, requestId, retryHint, details }, config,
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

  /**
   * 写入口失败 → **在页面上**说清楚（业务负责人：失败要人话，不许静默、不许只写日志）。
   * ⚠️ 内部错误（飞书错误码 / 表名字段名）**不回显**：`scanWriteService` 已经把它们
   *    换成了配置里的通用人话，原文只进日志。
   */
  const respondWriteFailure = (res, result, requestId) => {
    const status = result.code === 'sale_write_failed' || result.code === 'replenish_write_failed' ? 500 : 400;
    return sendHtml(res, status, message({
      title: writeConfig.texts.failedTitle,
      body: result.message || writeConfig.texts.internalFailedBody,
      requestId,
      retryHint: writeConfig.texts.failedRetryHint,
    }));
  };

  const openIdOf = (req) => String(
    req.workbenchUser?.open_id || getSessionUser(req)?.open_id || '',
  );

  const postActionFor = (number) => `${config.route.basePath}/${encodeURIComponent(String(number || ''))}`;

  /**
   * 页面上的两个写入口要用的东西（尺寸清单 / 本单已加几双 / 两张表单的幂等键 / 文案）。
   *
   * ⚠️ **只读**：这里最多读一次自己的会话文件（`sessions.get`，**不是** ensure）——
   *    连"新建会话"都不做 ⇒ 她只是看一眼库存、什么都没点，本地不会多出任何记录。
   *    会话的建立发生在**第一次点「加入本单」**那一刻（`addLine` 内部会 ensure）。
   */
  const buildWriteContext = async (req, view) => {
    if (!writeService) return null;
    const openId = openIdOf(req);
    if (!openId) return null;
    const texts = writeConfig.texts;
    const fields = writeConfig.fields;
    const session = await writeService.sessions.get(openId).catch((error) => {
      // 读自己的会话失败**不影响看库存**：把表单退化成"还没加任何一双"，
      // 她照样能加单（加的时候会重建）。只记一条 warn，不给她报错。
      logWarn(writeConfig.events.failed, {
        request_id: req.requestId, reason: 'session_read_failed', error: error.message,
      });
      return null;
    });
    const sizes = (view.rows || [])
      .filter((row) => !row.unknown_size)
      .map((row) => ({ size_text: row.size_text, missing: Boolean(row.missing) }));
    const defaultPaymentMethod = writeConfig.sale.defaultPaymentMethod;
    const paymentMethods = [...new Set([defaultPaymentMethod, ...(writeConfig.sale.paymentMethods || [])].filter(Boolean))];
    const lines = session?.sale?.lines || [];
    return {
      enabled: true,
      saleEnabled: writeConfig.sale.enabled !== false,
      replenishEnabled: writeConfig.replenish.enabled !== false,
      texts,
      fields,
      actions: writeConfig.actions,
      postAction: postActionFor(view.number),
      sizes,
      draft: { lines },
      saleKey: writeService.sessions.submitKeyFor(openId, session, 'sale'),
      replenishKey: writeService.sessions.submitKeyFor(openId, session, 'replenish'),
      paymentMethods,
      defaultPaymentMethod,
      // 「刚加入本单」那一句（**文案来自配置**，只有数字来自会话 ⇒ 没有回显注入面）。
      notice: String(req.query?.added || '') === '1' && lines.length
        ? fillWriteText(texts.lineAddedBanner, { count: lines.length })
        : '',
    };
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
      const write = await buildWriteContext(req, view);
      return sendHtml(res, 200, renderScanPage(view, config, write));
    } catch (error) {
      return respondFailure(res, error, requestId);
    }
  });

  /**
   * **写入口**：页面上那两个表单都 POST 到同一个地址，靠 `action` 字段分派。
   *
   * 四个动作：
   *   · `add_line`     —— 把这一双加进"本单"（**只写本地会话**，业务表一字不写）；
   *   · `submit_order` —— 提交整单（**唯一的销售写库时机**）；
   *   · `clear_draft`  —— 清空本单；
   *   · `replenish`    —— 按勾选的尺码 + 数量生成采购申请。
   *
   * ⚠️ **成功的"加一双 / 清空"走 303 回原页**（Post-Redirect-Get）：
   *    刷新不会重复提交，页面上也会带上"本单现在几双"。**提交订单**直接渲染结果页。
   * ⚠️ 失败一律**渲染一张人话页**（不静默、不只写日志）。
   */
  router.post(config.route.path, async (req, res) => {
    const requestId = req.requestId;
    if (!writeService) {
      return sendHtml(res, 503, message({
        title: writeConfig.texts.writeDisabledTitle,
        body: writeConfig.texts.writeDisabledBody,
        requestId,
      }));
    }
    const body = req.body || {};
    const fields = writeConfig.fields;
    const actions = writeConfig.actions;
    const action = String(body[fields.action] || '');
    const openId = openIdOf(req);
    try {
      // ── 加入本单 ────────────────────────────────────────────────────────────
      if (action === actions.addLine) {
        const view = await service.lookup({ number: req.params.number, requestId });
        if (!view.found) {
          return sendHtml(res, 404, message({
            title: config.texts.notFoundTitle,
            body: config.texts.notFoundBody,
            number: view.number,
            requestId,
          }));
        }
        const result = await writeService.addSaleLine({
          openId,
          requestId,
          productRecordId: view.product_record_id,
          number: view.number,
          itemNo: view.item_no,
          color: view.color,
          size: body[fields.size],
          amount: body[fields.amount],
          gift: body[fields.gift],
          // ⭐ 2026-10-09（**本文件唯一的一处新增**）：「选中的这一双是现货还是预订」——
          //    判据与页面上那两个分组**同一份**（所选尺码在「样品 + 门盒」有没有货，
          //    纯函数在 `views/scanPageRealm.js`）。交易类型**编码**不在这里写死：
          //    写服务按既有判据 `salesTradeTypeForStock` 推出来（现货 / 预订）。
          inStock: sellableSizeTexts(view).has(String(body[fields.size] ?? '').trim()),
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
        logInfo(writeConfig.events.lineAdded, {
          request_id: requestId, number: view.number, count: result.count,
        });
        return res.redirect(303, `${postActionFor(view.number)}?added=1`);
      }

      // ── 清空本单 ────────────────────────────────────────────────────────────
      if (action === actions.clearDraft) {
        await writeService.clearDraft({ openId, requestId });
        return res.redirect(303, postActionFor(decodeURIComponent(String(req.params.number || ''))));
      }

      // ── 提交销售单 ──────────────────────────────────────────────────────────
      if (action === actions.submitOrder) {
        const result = await writeService.submitSale({
          openId,
          requestId,
          submitKey: body[fields.submitKey],
          paymentMethod: body[fields.paymentMethod],
          paymentAmount: body[fields.paymentAmount],
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
        const texts = writeConfig.texts;
        const details = [
          fillWriteText(texts.submittedOrderLine, { orderNo: result.order_no || '—' }),
          fillWriteText(texts.submittedDetailLine, { count: result.detail_count || 0 }),
        ];
        if (!result.payment_count) details.push(texts.fundsPendingNote);
        return sendHtml(res, 200, message({
          title: result.reused ? texts.submittedAgainTitle : texts.submittedTitle,
          body: result.reused
            ? fillWriteText(texts.submittedAgainBody, { orderNo: result.order_no || '—' })
            : fillWriteText(texts.submittedBody, {
              orderNo: result.order_no || '—', count: result.detail_count || 0,
            }),
          requestId,
          details,
          retryHint: texts.submittedNextHint,
        }));
      }

      // ── 补货报单 ────────────────────────────────────────────────────────────
      if (action === actions.replenish) {
        const view = await service.lookup({ number: req.params.number, requestId });
        if (!view.found) {
          return sendHtml(res, 404, message({
            title: config.texts.notFoundTitle,
            body: config.texts.notFoundBody,
            number: view.number,
            requestId,
          }));
        }
        const entries = parseReplenishEntries(body, fields, writeConfig);
        const result = await writeService.submitReplenish({
          openId,
          requestId,
          submitKey: body[fields.submitKey],
          productRecordId: view.product_record_id,
          number: view.number,
          entries,
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
        const texts = writeConfig.texts;
        return sendHtml(res, 200, message({
          title: result.reused ? texts.replenishAgainTitle : texts.replenishDoneTitle,
          body: result.reused
            ? fillWriteText(texts.replenishAgainBody, { batchNo: result.batch_no || '—' })
            : fillWriteText(texts.replenishDoneBody, {
              batchNo: result.batch_no || '—', count: result.request_count || 0,
            }),
          requestId,
          details: [
            fillWriteText(texts.replenishBatchLine, { batchNo: result.batch_no || '—' }),
            fillWriteText(texts.replenishDetailLine, { count: result.request_count || 0 }),
          ],
          retryHint: texts.submittedNextHint,
        }));
      }

      // 动作名不认识（老页面 / 手改表单）：**明确回一张人话页**，不静默。
      logWarn(config.events.badNumber, { request_id: requestId, reason: 'unknown_write_action', action });
      return respondWriteFailure(res, { code: 'unknown_action', message: writeConfig.texts.unknownActionBody }, requestId);
    } catch (error) {
      // 走到这里说明是**没预料到**的异常（写服务内部已把业务失败都收敛成人话结果）。
      if (isDataNotReady(error)) {
        res.set('Retry-After', '5');
        return sendHtml(res, 503, message({
          title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
        }));
      }
      return respondFailure(res, error, requestId);
    }
  });

  // `POST /s`（没有编号）：没有编号就不知道是哪一款，回"这个链接不对"。
  router.post('/', (req, res) => {
    logWarn(config.events.badNumber, { request_id: req.requestId, reason: 'missing_number' });
    return badNumberPage(res, 400, req.requestId);
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

/**
 * 补货表单 → `[{ size, quantity }]`。
 * 表单里：勾了哪个尺码（`sizes` 多选）就在 `qty_<尺码>` 里填数量；
 * 勾了不填 ⇒ 交给写服务按配置的默认值（1 双）算 —— 这里**不替她决定**。
 */
const parseReplenishEntries = (body, fields, writeConfig) => {
  const rawSizes = body[fields.replenishSizes];
  const sizes = Array.isArray(rawSizes) ? rawSizes : (rawSizes === undefined || rawSizes === '' ? [] : [rawSizes]);
  return sizes.map((size) => ({
    size,
    quantity: body[`${fields.replenishQuantityPrefix}${size}`] ?? writeConfig.replenish.defaultQuantity,
  }));
};

module.exports = { createScanPageRouter, isDataNotReady, parseReplenishEntries };
