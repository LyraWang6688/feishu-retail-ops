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
const { renderScanPage, renderScanMessagePage, renderMinimalPage } = require('../views/scanPageRenderer');
// ⚠️ 只借这两个**纯函数**：所选尺码在「样品 + 门盒」有没有货（= 页面上那两个分组的判据），
//    以及 `?from=` → 领域 id（认不出来回落缺省，不报错、不白屏）。
const { sellableSizeTexts, resolveRealm, DEFAULT_REALM } = require('../views/scanPageRealm');
// ⭐ 写操作之后**立刻作废**「实时库存」内存快照（她：库存必须准确，不是等 30 秒）。
const { invalidateLiveInventorySnapshot } = require('../services/liveInventorySnapshot');
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
  // ⚠️ 只读那一半的 service：`options.service` 供用例注入一个假的（既有用例就是这么做的，
  //    注入之后**连内存快照都不会建** —— 见 `services/scanPageService.js` 的注释）。
  const service = options.service || createScanPageService(gateway, {
    config,
    snapshot: options.snapshot,
    // ⭐ 生产接线（`app.js` 挂这个 router）默认**开着**后台快照；
    //    用例可以传 `startSnapshot: false`（不然会多出一次整表读 + 一个进程级定时器）。
    startSnapshot: options.startSnapshot !== false,
  });
  // 渲染器也留一个注入点：**只为验证"渲染抛错也必须回人话页"**（见用例 AC-W5）。
  const renderScan = options.render?.scan || renderScanPage;
  const renderMessage = options.render?.message || renderScanMessagePage;
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

  /**
   * 🔴 **绝不空白**：所有"人话页"都从这里发出去 —— 连渲染本身抛错都还有最后一道兜底
   *（`renderMinimalPage` 不依赖任何配置，只有字符串拼接 + 转义，几乎不可能再抛）。
   *
   * 业务负责人 2026-10-09 真机反馈「手机扫码一片空白」之后定的口径：
   * **页面上无论如何都要有看得见的东西** —— 宁可给她一句"暂时打不开"，也不给一张白纸。
   */
  const sendHuman = (res, status, payload) => {
    try {
      return sendHtml(res, status, renderMessage(payload, config));
    } catch (error) {
      logError(config.events.failed, {
        request_id: payload?.requestId, reason: 'message_render_failed', error: error.message,
      });
      return sendHtml(res, status, renderMinimalPage({
        title: payload?.title || config.texts.errorTitle,
        body: payload?.body || config.texts.errorBody,
        requestId: payload?.requestId,
      }));
    }
  };

  const badNumberPage = (res, status, requestId, number = '') => sendHuman(res, status, {
    title: config.texts.badNumberTitle,
    body: config.texts.badNumberBody,
    number,
    requestId,
  });

  const respondFailure = (res, error, requestId, timing = null) => {
    // ⭐ 失败也要看得出卡在哪一步（她：「一查日志就知道卡在哪一步」）——
    //    在发页面之前把已经量到的那几段打出去（`total_ms` 由 service 写、`render_ms` 为 0）。
    service.logTiming?.(timing, { requestId, found: false });
    if (error?.scanLimitExceeded) {
      // service 已经记过 limitExceeded；这里只负责给她一张人话页面（**不显示半张库存表**）。
      return sendHuman(res, 503, {
        title: config.texts.limitTitle, body: config.texts.limitBody, requestId,
      });
    }
    if (isDataNotReady(error)) {
      res.set('Retry-After', '5');
      return sendHuman(res, 503, {
        title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
      });
    }
    logError(config.events.failed, { request_id: requestId, error: error.message });
    return sendHuman(res, 500, {
      title: config.texts.errorTitle,
      body: config.texts.errorBody,
      requestId,
      retryHint: config.texts.retryHint,
    });
  };

  /**
   * 写入口失败 → **在页面上**说清楚（业务负责人：失败要人话，不许静默、不许只写日志）。
   * ⚠️ 内部错误（飞书错误码 / 表名字段名）**不回显**：`scanWriteService` 已经把它们
   *    换成了配置里的通用人话，原文只进日志。
   */
  const respondWriteFailure = (res, result, requestId) => {
    const status = result.code === 'sale_write_failed' || result.code === 'replenish_write_failed' ? 500 : 400;
    return sendHuman(res, status, {
      title: writeConfig.texts.failedTitle,
      body: result.message || writeConfig.texts.internalFailedBody,
      requestId,
      retryHint: writeConfig.texts.failedRetryHint,
    });
  };

  /**
   * ⭐ 写成功之后**立刻作废**「实时库存」内存快照（她的硬要求：**库存准确**，
   * 不能等 30 秒那一拍）。
   *
   * 🔴 为什么调用点在**路由**（而不是写服务）：本任务的写作用域只覆盖到扫码这条链路的
   *    `routes/scanPage.js`；`services/scanWriteService.js` 刻意一行都没动。
   *    其余写入口（销售入账 / 到货 / 手工库存调整 / 交付扣减）**不在本任务作用域内**，
   *    它们各自在写成功后加一行同样的调用即可（跨模块、零注入，谁都不认识扫码页）：
   *    `require('../services/liveInventorySnapshot').invalidateLiveInventorySnapshot('原因')`
   *    —— 详见 `services/liveInventorySnapshot.js` 的注释。
   */
  const invalidateInventorySnapshot = (requestId, reason) => {
    try {
      invalidateLiveInventorySnapshot(reason);
    } catch (error) {
      // 失效失败**不许**把已经写成功的业务打成 500（那才是最坏的）：记一条 warn 就够了。
      logWarn(config.events.failed, {
        request_id: requestId, reason: 'snapshot_invalidate_failed', error: error.message,
      });
    }
  };

  const openIdOf = (req) => String(
    req.workbenchUser?.open_id || getSessionUser(req)?.open_id || '',
  );

  /**
   * 表单的 POST 目标（= 处理完回跳到哪一页）。
   *
   * ⭐ **必须带上领域**：不然她在【销售】那一块点「加入本单」，303 回来会落在
   *   **缺省领域**、刚填的本单看不见了。
   *   ⚠️ 缺省领域（2026-10-11 起 = **销售**）不带 `?from=`（URL 干净，且既有断言一字不变）；
   *      另外三个领域一律带 `?from=<领域>` ⇒ **回跳停在本单所在的领域**。
   *   ⚠️ 这个函数**同时被 `buildWriteContext`（拼表单 action）与 POST 的 303 两处用** ——
   *      表单 action 带上了 `?from=`，POST 里 `resolveRealm(req.query?.from)` 才读得到领域。
   *      （2026-10-11 修的一处：表单 action 原来漏传 realm，导致回跳落到缺省领域。）
   */
  const postActionFor = (number, realm = DEFAULT_REALM) => {
    const path = `${config.route.basePath}/${encodeURIComponent(String(number || ''))}`;
    return realm && realm !== DEFAULT_REALM ? `${path}?from=${encodeURIComponent(realm)}` : path;
  };

  /**
   * 页面上的两个写入口要用的东西（尺寸清单 / 本单已加几双 / 两张表单的幂等键 / 文案）。
   *
   * ⚠️ **只读**：这里最多读一次自己的会话文件（`sessions.get`，**不是** ensure）——
   *    连"新建会话"都不做 ⇒ 她只是看一眼库存、什么都没点，本地不会多出任何记录。
   *    会话的建立发生在**第一次点「加入本单」**那一刻（`addLine` 内部会 ensure）。
   */
  const buildWriteContext = async (req, view, realm = DEFAULT_REALM) => {
    if (!writeService) return null;
    const openId = openIdOf(req);
    if (!openId) return null;
    const texts = writeConfig.texts;
    const fields = writeConfig.fields;
    // ⭐ 本单是**按人（登录会话）**存的（`scanSessionService.idOf(openId)`），
    //    **不是按编号** ⇒ 扫 A 加一双、再扫 B 加一双，读到的**是同一份本单**
    //    （"一单跨款累积"就是这么成立的；见 `services/scanSessionService.js` 的文件头）。
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
      postAction: postActionFor(view.number, realm),
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

  /**
   * ⭐⭐ **`GET /s/:number?from=<领域>`** —— 手机扫开的那一页。
   *
   * 2026-10-09 真机（飞书 webview 白屏）之后这一条重做过：
   *   · **服务端按 `from` 只渲染那一块**（不再靠 `<head>` 内联脚本 + CSS 显隐）；
   *   · 页面里**一行前端脚本都没有** ⇒ 飞书 webview 执不执行脚本都一个样；
   *   · 认不出的 `from` 回落缺省（销售），**永不报错、永不空白**。
   *   · 任何异常（取数 / 渲染）都落到 `respondFailure` → **人话页**（还有 `renderMinimalPage` 兜底）。
   */
  router.get(config.route.path, async (req, res) => {
    const requestId = req.requestId;
    // ⚠️ 领域来自查询串（她给的参数名就是 `from`）；认不出来一律回落缺省，**不报错**。
    const realm = resolveRealm(req.query?.from);
    // ⭐ 分阶段耗时（出参）：失败 / 找不到时同样能看出卡在哪一步。
    const timing = {};
    try {
      // ⚠️ Express 已经把路由参数解码过一次（`%7C` → `|`，未编码的中文也照收）；
      //    service 里再解一次是为了容忍双重编码，并且对孤立 `%` 的输入不抛。
      const view = await service.lookup({ number: req.params.number, requestId, timing });
      if (!view.found) {
        if (view.reason === 'empty') {
          logWarn(config.events.badNumber, { request_id: requestId, reason: 'empty_number' });
          service.logTiming?.(timing, { requestId, found: false });
          return badNumberPage(res, 400, requestId);
        }
        service.logTiming?.(timing, { requestId, found: false });
        return sendHuman(res, 404, {
          title: config.texts.notFoundTitle,
          body: config.texts.notFoundBody,
          number: view.number,
          requestId,
        });
      }
      const write = await buildWriteContext(req, view, realm);
      const renderStartedAt = Date.now();
      // ⭐ 2026-10-11：把 UA 交给渲染层 —— 它只用来决定本单条上【继续扫下一个】
      //    是"飞书客户端内的扫一扫 AppLink"还是那句如实的人话（`canScanNextWithFeishu`）。
      const html = renderScan(view, config, write, realm, { userAgent: req.headers['user-agent'] });
      timing.render_ms = Math.max(0, Date.now() - renderStartedAt);
      // `total_ms` = 取数 + 渲染（整条链路的墙钟）—— 她要的是"这一页到底花了多久"。
      timing.total_ms = (Number(timing.total_ms) || 0) + timing.render_ms;
      service.logTiming?.(timing, { requestId, found: true });
      return sendHtml(res, 200, html);
    } catch (error) {
      return respondFailure(res, error, requestId, timing);
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
      return sendHuman(res, 503, {
        title: writeConfig.texts.writeDisabledTitle,
        body: writeConfig.texts.writeDisabledBody,
        requestId,
      });
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
          return sendHuman(res, 404, {
            title: config.texts.notFoundTitle,
            body: config.texts.notFoundBody,
            number: view.number,
            requestId,
          });
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
        return res.redirect(303, `${postActionFor(view.number, resolveRealm(req.query?.from))}${resolveRealm(req.query?.from) === DEFAULT_REALM ? '?' : '&'}added=1`);
      }

      // ── 清空本单 ────────────────────────────────────────────────────────────
      if (action === actions.clearDraft) {
        await writeService.clearDraft({ openId, requestId });
        return res.redirect(303, postActionFor(
          decodeURIComponent(String(req.params.number || '')), resolveRealm(req.query?.from),
        ));
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
        // ⭐ 销售单写成功 ⇒ **立刻作废**「实时库存」快照（她：库存必须准确，不是等 30 秒）。
        invalidateInventorySnapshot(requestId, 'scan_sale_submitted');
        const texts = writeConfig.texts;
        const details = [
          fillWriteText(texts.submittedOrderLine, { orderNo: result.order_no || '—' }),
          fillWriteText(texts.submittedDetailLine, { count: result.detail_count || 0 }),
        ];
        // ⚠️ 2026-10-10：原来钱没记时会补一句「这一单先记了货、还没记钱…」（`fundsPendingNote`）——
        //    那是**解释既有口径**的说明句，按业务负责人的口径删掉；写完的事实（单号 / 双数）照旧。
        return sendHuman(res, 200, {
          title: result.reused ? texts.submittedAgainTitle : texts.submittedTitle,
          body: result.reused
            ? fillWriteText(texts.submittedAgainBody, { orderNo: result.order_no || '—' })
            : fillWriteText(texts.submittedBody, {
              orderNo: result.order_no || '—', count: result.detail_count || 0,
            }),
          requestId,
          details,
          retryHint: texts.submittedNextHint,
        });
      }

      // ── 补货报单 ────────────────────────────────────────────────────────────
      if (action === actions.replenish) {
        const view = await service.lookup({ number: req.params.number, requestId });
        if (!view.found) {
          return sendHuman(res, 404, {
            title: config.texts.notFoundTitle,
            body: config.texts.notFoundBody,
            number: view.number,
            requestId,
          });
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
        // ⭐ 补货报单写成功 ⇒ 同样失效快照（她点名了「补货」也要；这一步不动库存，
        //    但"写完就失效"永远比"猜它动没动库存"安全）。
        invalidateInventorySnapshot(requestId, 'scan_replenish_submitted');
        const texts = writeConfig.texts;
        return sendHuman(res, 200, {
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
        });
      }

      // 动作名不认识（老页面 / 手改表单）：**明确回一张人话页**，不静默。
      logWarn(config.events.badNumber, { request_id: requestId, reason: 'unknown_write_action', action });
      return respondWriteFailure(res, { code: 'unknown_action', message: writeConfig.texts.unknownActionBody }, requestId);
    } catch (error) {
      // 走到这里说明是**没预料到**的异常（写服务内部已把业务失败都收敛成人话结果）。
      if (isDataNotReady(error)) {
        res.set('Retry-After', '5');
        return sendHuman(res, 503, {
          title: config.texts.busyTitle, body: config.texts.busyBody, requestId,
        });
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
