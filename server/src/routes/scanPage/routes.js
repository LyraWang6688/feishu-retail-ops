'use strict';

/**
 * 扫码页路由注册（阶段 5c 从 index.js 搬出）。
 * 只做 GET/POST 注册与分发；所有上下文/助手由 `ctx` 注入，行为逐字不变。
 */
const installScanPageRoutes = ({ router, ctx }) => {
  const {
    salesAsync,
    COOKIE_NAME, DEFAULT_REALM, ENTRY_RULE_TEXTS, FUNNEL, LABEL_PRINT_QUEUE, PURCHASE_RETURN_REALM, REALM_SCAN, SCAN_AUTH_REDIRECT, SCAN_PAGE, SCAN_WRITE, SUBMIT_TOAST, SalesFollowupService, TICKET, V1BitableGateway, addBackPath, adoptFirstVisitSubmitKey, arrival, arrivalInstance, asList, backTargetFor, badNumberPage, buildLoginStartUrl, buildPaymentRows, candidatePaymentMethods, clearMultiItemPending, config, configuredPaymentMethods, createFirstVisitKeyAdopter, createLarkJsapiService, createLegacySessionProbe, createMultiItemOrderService, createMultiItemPendingOf, createPageContext, createPageTokenMiddleware, createPaymentMethodsService, createPurchaseSchedulerOf, createPurchaseWriteBackgroundService, createSalesAsyncRuntime, createScanPageRouter, createScanPageService, createScanWriteService, createVoucherPaymentService, encodeSession, express, feishuAuthEnabled, fillWriteText, gateway, getLabelPrintQueue, getSessionUser, handleAddLineOf, handleClearDraftOf, handlePaymentPayOf, handlePendingExchangeSubmit, handlePrintLabelOf, handlePurchaseReturnOf, handleReplenishOf, handleSubmitOrderOf, handleUiTap, invalidateLiveInventorySnapshot, isDataNotReady, isRecordBase, labelPrintQueue, larkJsapi, logError, logFunnelPage, logInfo, logRendered, logWarn, lookupInputOf, markRealmUsed, markRealmUsedOf, markTapCode, mergeFirstItemEntries, mountedPathOf, multiItemChainOf, multiItemOrder, multiItemOrderConfig, multiItemOrderEngine, multiItemPendingKey, multiItemWire, notFoundPage, openIdOf, options, orderWithPreferred, pageSessionKey, pageSessionKeyOfRequest, parseMultiItemGroups, parseNumberSegments, parsePaymentRows, parseReplenishEntries, parseReturnEntries, pathWithoutTicket, paymentMethodsService, postActionFor, purchaseAmountInvalid, purchaseAmountInvalidOf, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingOf, purchaseAmountMissingPage, purchaseAmountRequiredFor, purchaseAmountRequiredForOf, purchaseBackground, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, readMultiItemPending, realmEntryParams, realmOfAction, realmOfActionOf, realmScanActive, realmScanConfig, realmScanPageConfig, realmScanTriggered, redeemSessionTicket, renderContext, renderFlowOf, renderMessage, renderMinimalPage, renderSalePaymentStepPage, renderSalesHome, renderScan, renderScanMessagePage, renderScanPage, renderScanSkeleton, requireWorkbenchAccess, resolveLabelPrintQueue, resolveLarkJsapi, resolveMultiItemOrderConfig, resolvePurchaseReturnImageOptions, resolveRealm, resolveScanNext, respondFailure, respondSettlementBlock, respondWriteFailure, responses, roleOf, salesRuntime, scanTargetOf, schedulePurchaseWrite, sellableSizeTexts, sendHtml, sendHuman, sendPaymentStep, service, sessionIdOf, setDraftOrderAmount, setTraceFields, sizesForCategory, step2WriteOf, uiTapResultMiddleware, unknownActionFailure, voucherPayments, withPageSession, withoutRealmQuery, writeConfig, writeMultiItemPending, writeService,
  } = ctx;

  router.get('/', async (req, res) => {
    const requestId = req.requestId;
    const number = String(req.query?.number || '').trim();
    if (number) {
      logInfo(config.events.salesHomeOpened, { request_id: requestId, by: 'manual' });
      return res.redirect(302, `${req.baseUrl}/${encodeURIComponent(number)}`);
    }
    const noticeKey = SUBMIT_TOAST.noticeKey || 'done';
    const orderNo = String(req.query?.[noticeKey] || '').trim().slice(0, 40);
    return sendHtml(res, 200, renderSalesHome({ config, orderNo, basePath: req.baseUrl }));
  });

  /**
   * ⭐⭐ **`GET /r/:recordId?from=<领域>`** —— 手机扫开的那一页。
   *
   * 2026-10-09 真机（飞书 webview 白屏）之后这一条重做过：
   *   · **服务端按 `from` 只渲染那一块**（不再靠 `<head>` 内联脚本 + CSS 显隐）；
   *   · 页面里**一行前端脚本都没有** ⇒ 飞书 webview 执不执行脚本都一个样；
   *   · 认不出的 `from` 回落缺省（销售），**永不报错、永不空白**。
   *   · 任何异常（取数 / 渲染）都落到 `respondFailure` → **人话页**（还有 `renderMinimalPage` 兜底）。
   */
  // ⭐⭐ 2026-10-12：**两条路共用这两个处理函数**（同一个 router 实例挂在 `/s` 与 `/r` 上）：
  //    · `/r/:recordId`   ⇒ `req.params.number`   = 编号
  //    · `/r/:recordId` ⇒ `req.params.recordId` = 记录 ID（**新二维码走这条**）
  //    ⚠️ 用**路径数组**把同一个 handler 挂到两个模式上 —— **不复制一份处理逻辑**；
  //      "这一页在取哪一样东西"由挂载点判定（`scanTargetOf`），其余一行都不分叉。
  const ROUTE_PATTERNS = [config.route.recordPath].filter(Boolean);
  /**
   * ⭐⭐ 2026-10-13（她问"我点了几次"）：**前端点击埋点** `ui.tap`。
   * ⭐⭐ 2026-10-14 晚（埋点 P0 ②④⑤）：处理体**上移到 `utils/uiTapReport.js`** ——
   *   与**工作台**共用同一份实现（`handleUiTap`：事件名 / 字段 / ④ 判据 / 204-400 契约），
   *   本文件只保留"挂在哪个路径上"（路径的唯一真源仍是 `SCAN_PAGE.tapFeedback.reportPath`，
   *   渲染层写 URL 也读它 ✓）。
   *
   * · 通道：`navigator.sendBeacon('/<prefix>/ui-tap?target=…&tap_id=…&since_ms=…&page=…')`
   *   （**不阻塞跳转** ✓ 失败静默 ✓）
   * · 🔴 **只记 target（我们的标识）**：`realm:replenish` / `submit:submit_order`
   *   —— **不采集任何表单值 / 个人信息** ✗；用 query 传（零 body 解析 ✓）
   * · 挂在扫码路由下（`/s` `/r` 都有 ✓）⇒ **不动 `app.js`** ✓
   * · 同一个 target 在配置窗口内又被点 ⇒ **独立事件** `ui.tap.repeated`（④，服务端判 ✓）
   */
  router.post(config.tapFeedback?.reportPath || '/ui-tap', (req, res) => handleUiTap({
    req, res, scope: 'scan', realm: resolveRealm(req.query?.from),
  }));

  // ── ⭐⭐ 2026-10-16（task-61 · ②「领域内扫一扫」）──────────────────────────────
  /**
   * `GET /<prefix>/lark/jsapi-signature?url=<地址>`
   *
   * 🔴 **不新开第二套** ✗：用的就是**既有** `services/larkJsapiService.js`（与工作台「扫码打印」
   *    同一个签名函数 ✓）；本路由**只转发**，不认识"扫一扫"这个词以外的任何业务 ✗。
   * 🔴 **不新开鉴权** ✗：它挂在本 router 下 ⇒ **与扫码页同一道**飞书身份闸门（未启用 503 / 未登录 302 /
   *    白名单外 403 —— 一字不变）✓。
   * 🔴 **响应里不含任何密钥** ✗：只有 `h5sdk.config` 要的四样（＋公开的 JSSDK 地址 ✓）。
   * ⚠️ 开关关着 ⇒ **当场 404**（连"有这么个端点"都不暴露 ✓ 页面也根本不会去调它 ✓）。
   * ⚠️ **必须排在上面那条 `GET /:number` 之前**（否则 `lark` 会被当成一个编号 ✗）。
   */
  const realmScanSignaturePath = String(realmScanConfig?.signaturePath || '/lark/jsapi-signature');
  router.get(realmScanSignaturePath, async (req, res) => {
    if (realmScanConfig?.enabled !== true) return res.status(404).json({ success: false, error: 'not_enabled' });
    const pageUrl = String(req.query?.url || '').trim();
    try {
      const result = await resolveLarkJsapi().signatureFor(pageUrl);
      if (!result.ok) {
        logWarn('scan.realm_scan.signature_failed', {
          request_id: req.requestId, reason: result.reason,
        });
        return res.status(400).json({ success: false, error: result.message, reason: result.reason });
      }
      logInfo('scan.realm_scan.signature_ok', {
        request_id: req.requestId,
        // ⚠️ 只记域名（排障够用）；签名 / 票 / 密钥一个字都不进日志 ✗
        host: (() => { try { return new URL(result.url).host; } catch { return ''; } })(),
      });
      return res.json({
        success: true,
        appId: result.appId,
        timestamp: result.timestamp,
        nonceStr: result.nonceStr,
        signature: result.signature,
        url: result.url,
        jssdkUrl: resolveLarkJsapi().config?.jssdkUrl || '',
        jsApiList: ['scanCode'],
      });
    } catch (error) {
      const texts = resolveLarkJsapi().config?.texts || {};
      return res.status(502).json({ success: false, error: texts.upstreamFailed });
    }
  });
  /**
   * `POST /<prefix>/lark/scan-report` —— 客户端那一段的**只读**上报（拿不到它就查不下去 ✗）。
   * 🔴 **零业务写入** ✓（只 `logInfo` 一条）；⚠️ 上报失败**绝不影响她**（客户端本来就 fire-and-forget ✓）。
   */
  router.post(realmScanSignaturePath.replace(/[^/]+$/, 'scan-report'), (req, res) => {
    if (realmScanConfig?.enabled !== true) return res.status(404).json({ success: false });
    const body = req.body || {};
    logInfo('scan.realm_scan.report', {
      request_id: req.requestId,
      ok: body.ok === true,
      realm: String(body.realm || '').slice(0, 32),
      reason: String(body.reason || '').slice(0, 64),
      err_msg: String(body.err_msg || '').slice(0, 200),
      // 「扫到了什么」只留**长度 + 前 80 字**（要能对上那一件，但不把一个长串整条塞进日志 ✗）
      scanned_length: String(body.scanned || '').length,
      scanned: String(body.scanned || '').slice(0, 80),
    });
    return res.json({ success: true });
  });


  router.get(ROUTE_PATTERNS, async (req, res) => {
    const requestId = req.requestId;
    // ⚠️ 领域来自查询串（她给的参数名就是 `from`）；认不出来一律回落缺省，**不报错**。
    //    ⭐ 2026-10-11：六个领域（销售 · 补货 · 退货 · 验收 · 库存 · 货品）都是**真领域**，
    //      统一走 `resolveRealm` 就够；已退役的 `purchase` 认不出来 ⇒ 回落销售（既有口径）。
    //    ⚠️ `explicit` 区分"**裸扫**（一个 `from` 都没有，标签二维码就是这样）"与
    //      "她**点**了某个领域 tab（链接一定带 `?from=`）" —— 下面验收接管只对**裸扫**生效，
    //      这样"她点销售/库存…就能离开验收"才真的成立（`?from=sales` 不能被接管）。
    const askedRaw = String(req.query?.from ?? '').trim();
    const explicitRealm = askedRaw !== '';
    let realm = resolveRealm(askedRaw);
    // ⭐ task-58：**这一页的领域是怎么来的**（只为那条 `scan.page.rendered` 日志，不参与任何判定 ✗）：
    //   `explicit`   —— URL 上带了 `?from=`（她点的那个 tab）
    //   `remembered` —— 裸扫 + 她最近一次做过写操作的领域（下面那一支）
    //   `default`    —— 裸扫且从没记过 ⇒ 缺省（销售）
    let realmSource = explicitRealm ? 'explicit' : 'default';
    // ⭐ 分阶段耗时（出参）：失败 / 找不到时同样能看出卡在哪一步。
    // ⭐⭐ 2026-10-13（她：加载到中间一直白屏）：**骨架屏开关**（默认关 ⇒ 这一页与改动前逐字相同）。
    //   打开时：**先回骨架**（不读任何表）⇒ 她立刻有东西看；数据由骨架里那**同一段脚本**
    //   再 `fetch('?data=1')` 拿回来 —— ⚠️ `data=1` 一路落到下面**原有的整页渲染**（同一个
    //   `service.lookup` ✓ 不新增取数路径 ✓），所以两条路径的数据必然一致 ✓。
    //   ⚠️ 只覆盖**编号页/记录 ID 页**这一条；`GET /`（新首页）与所有写入口一个字不动 ✓
    // ⭐ 2026-10-14：骨架**只服务"首次进入"**（不带 `?from=`）——
    //   她「六格没问题、不要改动」+「中间态数据加载中」✗ ⇒ 点六格（带 `?from=`）**直接出整页** ✓
    //   判据在配置里（`config.skeleton.firstEntryOnly` ✓ 显式布尔 ✓ 不写 `||` 兜底 ✗）
    const skeletonFirstEntryOnly = config.skeleton?.firstEntryOnly === true;
    const hasRealmQuery = String(req.query?.from || '') !== '';
    if (config.skeleton?.enabled === true && String(req.query?.data || '') !== '1'
      && !(skeletonFirstEntryOnly && hasRealmQuery)
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      logInfo(SCAN_PAGE.events?.skeletonServed || 'scan.page.skeleton', { request_id: requestId });
      // ⭐ task-58：骨架屏也是一个落点（她那一发 `?data=1` 才是真正的货品页）——
      //   两条都留痕，才分得出"这一发只是骨架"与"这一发已经出货品页" ✓
      logRendered(req, {
        page: 'skeleton',
        trigger: 'skeleton_first_entry',
        number: String(lookupInputOf(req).recordId || ''),
      });
      return sendHtml(res, 200, renderScanSkeleton(lookupInputOf(req), config));
    }
    // ⭐⭐ 2026-10-14（业务负责人：**点「提交这一单」只到资金页**）：她**刷新**这一页时，
    //   如果会话里记着"已经走到资金这一步"（`paymentStep === 'pending'`）⇒ ⭐ **仍给资金页** ✓
    //   （否则刷新会掉回普通录入页 ⇒ 她会以为"白填了"✗）。其它情况**一个字都不改** ✓走老逻辑。
    //   ⚠️ 只认会话标记（**不认任何查询串** ✗）⇒ 别人/别的情况下拿不到这一页 ✓
    if (String(req.query?.data || '') !== '1'
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      const pendingSession = await writeService?.sessions?.get?.(sessionIdOf(req)).catch(() => null);
      // ⚠️ task-60：`const` → **`let`** —— 她选的 ② 要在下面把这条标记**清成"没有"**
      //    （`pendingMark = ''`）⇒ 那条既有接管**不再命中**（它的那一行**逐字未动** ✓）。
      let pendingMark = pendingSession?.sale?.paymentStep || pendingSession?.paymentStep;
      // 🔴 2026-10-14 晚（她真机：扫了码之后点「库存 / 补货 / 退货」**全都变成资金页**）：
      //   ⭐ 根因 = 上面这段"刷新仍给资金页"**没按领域限制** ✗ ⇒ 只要会话里还有 `pending`，
      //     她点**任何**领域都被资金页接管 ✗。
      //   ⇒ 修法（**只收紧、不改别的** ✓）：只在**销售**这一块才允许接管 ——
      //     · `from=sales`（她刷新销售页 ⇒ 仍给资金页 ✓ 不丢她刚填的 ✓）
      //     · 或**没带 `from`**（裸扫通常就是销售入口 ✓ 保持原有体验 ✓）
      //     · **其它领域**（库存/补货/退货/…）⇒ ⭐ **一律不接管**（照旧给那一块 ✓）
      const salesContext = renderFlowOf(req.query).flow.id === 'sales'
        && (String(req.query?.from || '') === '' || String(req.query?.from) === 'sales');
      /**
       * ⭐⭐ 2026-10-16（task-60 · 她真机 05:34「扫货品码却出现资金页」＋ **她当日亲口选的方案 ②**）：
       *   我给的选项（逐字）：「① 接管前先核对"是不是这个货品" 还是 ② 重扫同一个货品就从头开始
       *   （清掉那条未完成）？」⇒ 她答（逐字）：**「② 还是重扫同一个货品就从头开始（清掉那条未完成 ✓）」**。
       *
       * ⇒ **扫到货品、点「销售」那一发**（= 显式 `?from=sales`；realm tab 的链接就是它，
       *   `views/scanPageRenderer.js` 的 `href="?from=<领域>"` ✓）**先把那条"未完成"的标记清掉**
       *   ⇒ 这一发**从货品页开始** ✓（不再被"上一单的资金页"顶掉 ✗ —— 那正是她的截图）。
       *
       * 🔴 **清的范围（她逐字"清掉那条未完成"，别清过头 ✗）**：
       *   · 只清 **`paymentStep`** ＋ 与它同笔的 **`submitPending`**（那是她 2026-10-15 定下的
       *     "点按钮那一刻要写的那一双"pay 载荷 ⇒ `paymentStep` 一清它就没有读点，同笔清是纯卫生 ✓）；
       *   · **`lines` / `order_no` / `master_record_id` / `status` / `completed` / `seq` 一个字都不碰** ✗
       *     ⇒ 会话里那笔"已建单 / 已提交"的事实**原样留着**（她还能在工作台查到那一单 ✓）；
       *   · **只写她这条会话**（`openIdOf(req)` 来自**签名 cookie** ⇒ 别人的会话碰不到 ✗）；
       *   · **零业务表写入**：这一段只调 `sessions.saveDraftLines`（本地会话）—— 飞书一个字节都不写 ✓。
       *
       * ⚠️ **为什么只认显式 `?from=sales`、**裸扫不清** ✗**（这是本刀最容易做错的一处）：
       *   裸扫那条路挂着她 2026-10-14 定的**「资金页刷新不丢」**（"点提交 ⇒ 到资金页 ⇒ 刷新仍在资金页"）
       *   —— 判据是 `test/scanSalePayFront.test.js` 的 AC-PF4 ＋ `test/scanPaymentStepStale.test.js` 的
       *   AC-SM2/SM3/SM7/SM8（那几条**一条都没改** ✓）。在裸扫上清 ⇒ 把她**刚填完、正停在资金页**
       *   的那一单打回录入页 ✗ = **清过头**。
       *   ⭐ **线上（骨架屏开 + `firstEntryOnly`）裸扫先回骨架、`?data=1` 又绕过接管**
       *     ⇒ 能落到资金页的入口**只有她点「销售」这一发** ✓ ⇒ **就在这一发清** = 正好治她那一下 ✓
       *     （上一任的只读诊断 §2.3/§3.1 已证；骨架屏**关**时裸扫也会到资金页，那也照旧不动 ✓）。
       *   ⚠️ 与"**残标记自清理**"（下面那一段，**逐字未动** ✓）**各司其职**：
       *     那条治"有 pending 但**没东西要付**"（2026-10-15 的 #598/#601）；这条治"**她主动重扫**"。
       */
      const explicitSalesScan = String(req.query?.from || '') === 'sales';
      if (pendingMark === 'pending' && explicitSalesScan) {
        const hadSubmitPending = Boolean(pendingSession?.sale?.submitPending);
        let reset = false;
        try {
          // ⚠️ `undefined` = "这个键不在"（`services/scanSessionService.js` 默认 `sale` 的形状 ✓
          //    既有表示、**不新造状态值** ✗）—— 与下面那条残标记清理**同一种清法** ✓。
          await Promise.resolve(writeService.saveDraftLines?.(
            sessionIdOf(req), { paymentStep: undefined, submitPending: undefined },
          ));
          reset = true;
        } catch (error) {
          // 清失败**不许破她的页面**（这是 GET 渲染路径）⇒ 只 warn，照旧出整页 ✓
          logWarn(config.events?.paymentStepResetFailed || 'scan.payment_step.reset_failed', {
            request_id: requestId, error: error.message,
          });
        }
        // **不静默**：真机排查时这一条说明"那条未完成是**按她选的 ②** 清掉的"，并如实带旧状态 ✓
        logInfo(config.events?.paymentStepResetOnScan || 'scan.payment_step.reset_on_scan', {
          request_id: requestId,
          open_id: openIdOf(req),
          raw: String(pendingMark).slice(0, 32),
          lines: Array.isArray(pendingSession?.sale?.lines) ? pendingSession.sale.lines.length : 0,
          has_order: Boolean(String(pendingSession?.sale?.order_no || '').trim())
            || Boolean(String(pendingSession?.sale?.master_record_id || '').trim()),
          sale_status: String(pendingSession?.sale?.status || '').trim(),
          had_submit_pending: hadSubmitPending,
          reset,
        });
        // ⚠️ **这一句才是"别再接管"的开关**：把本地那份标记置空 ⇒ 下面那条
        //    "刷新仍给资金页"的接管（`pendingMark === 'pending' && salesContext`，**逐字未动** ✓）
        //    **不再命中** ⇒ 这一发继续走**正常整页渲染** ⇒ `page:'goods'` ✓（正是她选的 ②）。
        pendingMark = '';
      }
      if (pendingMark === 'pending' && salesContext) {
        const pendingView = await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null);
        if (pendingView?.found) {
          const pendingLines = Array.isArray(pendingSession?.sale?.lines) ? pendingSession.sale.lines : [];
          // ⭐⭐ 2026-10-15 晚（task-21 · 她真机 20:22：「我扫码一双鞋点击销售，出来的是**资金页面**」）：
          //   🔴 上面那半（10-14 晚）只把接管**限到销售上下文**，**没看"有没有东西要付"** ✗ ——
          //      她那次的会话是 `paymentStep:'pending'` + 草稿 **0 行** + 没有已建单号
          //      ＋ **`sale.status:'submitted'`**（**那一单早就交出去了**）⇒ 照样被顶到
          //      「整单付款（可填可不填）」，而且**之后每次扫码都这样** ✗✗。
          //   ⚠️ **光看"0 行"是不够的**（我第一版就是"0 行 + 没单号 ⇒ 残标记"，被全量挡下 ✓）：
          //      **刚点过「提交这一单」、正停在资金页**时，草稿**本来就是 0 行** —— 扫码那一双是走
          //      `submitPending`（提交那一步存下来的尺码/金额/收款）在**点按钮时**才落单的
          //      （见上面提交分支的 `lines: pendingDraftLines` ＋ 下面 pay 分支用 `pendingInfo`）✓
          //      ⇒ 拿"0 行"判残标记会把**正常**的资金页清掉 ⇒ 她点按钮就建不了单 ✗
          //        （`test/scanSalePayFront.test.js` 的 AC-PF1/PF2/PF4 正是这么挡住我的第一版 ✓）。
          //   ⇒ 判据收成她**真机那个状态**才有的特征：0 行 + 没单号 + **这一单已经 `submitted`**
          //      （`completeSale` 把 `status` 落成 submitted，它清的是 `lines`/`order_no`，
          //       **没清** `paymentStep` ⇒ 标记留成了残的 —— 正是她那次的形状 ✓）。
          const hasOrder = Boolean(String(pendingSession?.sale?.order_no || '').trim())
            || Boolean(String(pendingSession?.sale?.master_record_id || '').trim());
          const saleStatus = String(pendingSession?.sale?.status || '').trim();
          // ⚠️ 2026-10-15 晚（task-22 顺带修正）：改前逐字 `writeConfig?.statuses?.submitted || 'submitted'`
          //    —— `writeConfig.statuses` **不存在**（真路径是 `writeConfig.session.statuses`）⇒ 一直靠
          //    **字面量兜底**在跑（值恰好相同 ⇒ 行为没变 ✓，但那是"配置先行"没做到 ✗）。
          //    改后逐字：读**真路径**，兜底只在"配置竟然缺了"时保命（不改变任何现有行为 ✓）。
          const submittedStatus = String(writeConfig?.session?.statuses?.submitted || 'submitted');
          // 「有东西要付」= 草稿有行 ∨ **已经建过单**（order_no / master_record_id）∨
          //                **这一单还没交出去**（status 不是 submitted ⇒ 她刚点过提交、正停在资金页 ✓）
          if (pendingLines.length > 0 || hasOrder || saleStatus !== submittedStatus) {
            return sendPaymentStep(res, req, {
              // ⭐ 2026-10-16 A2a ③：候选收款方式 = 读表那一份（读不到 ⇒ 退回配置 + warn ✓ 见工厂里那份注释）
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: writeService?.sessions?.submitKeyFor?.(sessionIdOf(req), pendingSession, 'sale') || '',
              count: pendingLines.length,
              // ⭐⭐ task-58：**哪一条判据把她顶到了资金页** —— 就是上面那个三选一。
              //   （她真机再出现这个现象时，grep `scan.page.rendered` 一眼看出是哪种形状 ✓）
              renderedTrigger: pendingLines.length > 0
                ? 'pending_mark:lines'
                : (hasOrder ? 'pending_mark:order' : 'pending_mark:status_not_submitted'),
            });
          }
          // 🔴 **残标记**（0 行 + 没单号 + 已 `submitted`）⇒ **不给资金页**，并把标记清成"**没走到资金这一步**"
          //   的**既有表示** = 这个键**不在**（`services/scanSessionService.js` 的默认 `sale` 里就**没有**
          //   `paymentStep` ✓）⇒ 清成 `undefined`：`saveSaleProgress` 是 `{...当前 sale, ...patch}`、
          //   store 是 `JSON.stringify`（`jsonTaskStore`）⇒ 这个键就**没了** ✓。
          //   ⚠️ **不是** `'created'`（那是"**这一单已经建过**"的既有含义，写上去就是撒谎 ✗）；
          //   ⚠️ **不是**空串（那是**另造一个值**，注释里也点名过不许 ✗）；
          //   ⚠️ 清标记**失败不许破她的页面**（这是 GET 渲染路径）⇒ 只 warn，照旧出正常页 ✓。
          //   ⭐⭐ 2026-10-15 晚（task-22）：**`submitPending` 同一笔清掉**（纯卫生 ✓）——
          //      `paymentStep` 一清，它在代码里就**再没有读点**（pay / skip 两处都在
          //      `paymentStep === 'pending'` 的门内 ⇒ 这颗残留 payload 只会误导下次真机排查；
          //      Lead 手工清她会话时也把它一起清了 ✓）。
          //      🔴 **顺序不能反**：必须在"提交那一步把 `status` 落回 `draft`"（见提交分支）**之后**才敢这么清 ✗
          //         —— 否则第 2 单刚提交那一下也会命中这条残标记分支 ⇒ 把她**点按钮要写的那一双**抹掉 ⇒ 建不了单 ✗。
          const hadSubmitPending = Boolean(pendingSession?.sale?.submitPending);
          const clearing = writeService.saveDraftLines?.(
            sessionIdOf(req), { paymentStep: undefined, submitPending: undefined },
          );
          await Promise.resolve(clearing).catch((error) => {
            logWarn('scan.payment_step.stale_clear_failed', {
              request_id: requestId, error: error.message,
            });
          });
          // **不静默**：真机排查时这一条说明"那次残标记是被我们清掉的，不是她自己清掉的"。
          logWarn('scan.payment_step.stale_cleared', {
            request_id: requestId,
            open_id: openIdOf(req),
            raw: String(pendingMark).slice(0, 32),
            lines: pendingLines.length,
            has_order: hasOrder,
            sale_status: saleStatus,
            had_submit_pending: hadSubmitPending,
          });
        }
      }
    }
    const timing = {};
    // ⭐ 2026-10-13：`session_ms` = **从进这个处理函数到真正开始取数**这一段（认证 / 读会话 /
    //    路由开销）。实测它正是"total 减去各分段之后那 1.0~2.6 秒"的主要来源 ✗ ——
    //    现在把它也归到一段里，`stages_gap_ms` 才说明得了问题。
    const handlerStartedAt = Date.now();
    try {
      // ⚠️ Express 已经把路由参数解码过一次（`%7C` → `|`，未编码的中文也照收）；
      //    service 里再解一次是为了容忍双重编码，并且对孤立 `%` 的输入不抛。
      timing.session_ms = Math.max(0, Date.now() - handlerStartedAt);
      const view = await service.lookup({ ...lookupInputOf(req), requestId, timing });
      // ⭐⭐ 2026-10-14 她拍板：「把采购明细给删除了，把特殊码给去掉」⇒ 这里原来那次
      //   `purchaseSizeReader.listSizes()`（**1.7 秒**）**整块删除** ✓；尺码显示只按**实时库存**
      //   （`view.rows` = 内存快照 ✓）：库存里有 ⇒ 显示 ✓ 没有 ⇒ 不显示、不计缺码 ✓
      if (!view.found) {
        if (view.reason === 'empty') {
          logWarn(config.events.badNumber, { request_id: requestId, reason: 'empty_number' });
          service.logTiming?.(timing, { requestId, found: false });
          // ⭐ task-58：**没渲染出货品页**这件事也要留痕（否则"扫了但一条 rendered 都没有"）
          logRendered(req, {
            page: 'bad_number',
            trigger: 'lookup_bad_number',
            number: String(view.number || lookupInputOf(req).recordId || ''),
          });
          return badNumberPage(res, 400, requestId);
        }
        service.logTiming?.(timing, { requestId, found: false });
        // ⭐ `/r/{recordId}` 那条路读不到记录（记录被删 / 跨 Base）⇒ **同一条人话出口**，不是 500。
        logRendered(req, {
          page: 'not_found',
          trigger: 'lookup_not_found',
          number: String(view.number || lookupInputOf(req).recordId || ''),
        });
        return notFoundPage(res, requestId, {
          number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
        });
      }
      // ⭐⭐ 2026-10-18 修正（业务负责人：「全局和领域内的扫一扫逻辑不一样」）：
      //   五处扫一扫登记表（config/scanEntries.js）已经把两种入口分开：
      //     · 领域条【扫一扫】= standalone / AppLink，**不带历史数据**（keepDraft=false）
      //     · 领域内【再加一单】= JSAPI，扫完回跳 URL **显式带 `?from=<领域>&scan=1`**
      //   ⇒ 裸扫（无 `from=`）就是**全局入口**，必须固定落缺省领域（销售），
      //     不能再按 `last_realm` 记忆回补货 —— 那样全局入口会被上一笔补货"带偏"。
      //   ⚠️ 领域内回跳仍由 `?from=` 显式表达（不改）；`realmSource` 保持 default。
      // ⭐ 2026-10-17（假配置接线）：扫完回来的这一发、且这一处登记 keepDraft=false ⇒ 先清旧草稿
      if (realmScanTriggered(req, realm)) await clearDraftForScanIfNeeded(sessionIdOf(req), realm);
      const write = await buildWriteContext(req, view, realm);
      // ⭐ 2026-10-29：扫码「流程」（配置驱动；换款式等差异都进配置，路由只接薄模块）
      const { flow: scanFlow, flowContext } = renderFlowOf(req.query);
      // ⚠️ 验收模式那一块**只用到文案 / 字段名 / 动作名**（它们都在配置里）——
      //    所以即使扫码写入口整个关着（`write` 为 null），验收模式照旧可用：
      //    这里给它一个最小的上下文（不构造销售 / 补货那两条链的任何东西）。
      const writeForRender = write;  // ⭐ 2026-10-14 晚：验收模式的"最小上下文"随验收退场 ✓
      const renderStartedAt = Date.now();
      // ⭐ 2026-10-11「货品」领域：把**打印队列的真实状态**带进渲染层（在线 / 未连接 +
      //    这一款最近一次任务）。⚠️ 只在这个领域取 —— 别的领域一次都不碰打印那条链路。
      //    `printed=1` = 刚提交完（303 回来的），页面上给一句"已提交打印"。
      const printContext = realm === 'product'
        ? await buildPrintContext(view.number, realm, {
          requestId,
          submitted: String(req.query?.printed || '') === '1',
          duplicated: String(req.query?.dup || '') === '1',
          jobId: String(req.query?.job || '').trim(),
          // `/r` 底下表单要 POST 回 `/r/{recordId}`；`/s` 底下与改前逐字相同。
          target: backTargetFor(req, view.number),
        })
        : null;
      // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）：把草稿里**已经加进来的那几个货品**
      //   喂给渲染层（`view.multi_items`）—— 渲染层据此渲「已加货品」列表 **＋** 把它并进
      //   那个 hidden 字段（`[首件, ...已加]`）⇒ 她**点一下"加"、前面加的不丢** ✓。
      //   🔴 **只在采购那两块**（补货 / 退货）读 —— 别的领域一次都不碰这段（她那句"一次扫码 0~1 次飞书"的同一条口径 ✓）。
      //   🔴 **取不到 / 没有 ⇒ 就是今天的空态**（`view.multi_items` 一个字都不加 ⇒ 页面逐字不变 ✓）。
      //   ⚠️ **绝不含当前这一件**：当前这件是表单里那个**首件** ✓（含了 ⇒ 提交时用它那份旧 `entries`
      //     覆盖她刚填的 = **静默丢值** ✗）。
      //   ⚠️ 位置在**渲染之前**（`readMultiItemPending` 是工厂里上面的 `const` ⇒ 这里已初始化 ✓）。
      const multiItemChain = realm === 'replenish' ? 'replenish'
        : (realm === PURCHASE_RETURN_REALM ? 'return' : '');
      if (multiItemChain && writeService?.sessions) {
        const pending = await readMultiItemPending(sessionIdOf(req), multiItemChain).catch(() => ({ items: [] }));
        if (pending.items.length) view.multi_items = pending.items;
      }
      // ⭐ 2026-10-11：把 UA 交给渲染层 —— 它只用来决定本单条上【继续扫下一个】
      //    是"飞书客户端内的扫一扫 AppLink"还是那句如实的人话（`canScanNextWithFeishu`）。
      // ⭐⭐ 2026-10-16（task-61 · ① 日志）：`renderLogs` 是渲染层**只读登记**用的（见下）。
      const renderLogs = [];
      const html = renderScan(view, config, writeForRender, realm, {
        userAgent: req.headers['user-agent'],
        // ⭐⭐ 2026-10-13：提交后回跳带过来的单号 ⇒ 顶部那条"上一单已提交"的指引（没有就不显示 ✓）
        justSubmittedOrderNo: String(req.query?.[SUBMIT_TOAST.noticeKey || 'done'] || '').slice(0, 40),
        // ⭐ 这一页挂在哪个前缀上（`/s` 或 `/r`）—— 自助块里的批次链接/手输表单必须**留在同一前缀**。
        basePath: req.baseUrl,
        print: printContext,
        // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**只有"加货刚成功、303 回来这一发"才给**
        //   （`?scan=1` ✓）—— 其它任何时候都是 `null` ⇒ 页面上一个字都不多（`AC-ML5` ✓）。
        realmScan: realmScanPageConfig(req, realm),
        // ⭐ 2026-10-29：流程配置（换款式：不加一双 / 不显示金额 / 提交文案 / 上下文隐藏字段）
        flow: scanFlow,
        flowContext,
        // ⭐⭐ 2026-10-16（task-61 · ① 日志）：渲染层把"**本单已加的货品**"那一笔**只读**登记在这里
        //   （渲染层是纯函数 ⇒ 它自己不打日志 ✗；**由本路由在渲染之后统一打** ✓ —— 与既有
        //   `logRendered` 同一处，且**失败也绝不会影响她的页面** ✗）。
        logs: renderLogs,
      });
      // ⭐⭐ 2026-10-16（task-61 · ① 第二条日志）：**渲染"本单已加的货品"列表**那一刻 ——
      //   与加货那条（`…add`）一比就能答她那句「**扫了 B 但没看到 A**」：
      //   `add` 说有（`added_count` ≥ 1）而 `render` 说没有（`item_nos` 里没有 A）⇒ 是**读出来那半边** ✗✓
      //   🔴 纯 additive：**没有那一笔就一条都不打**（今天她看不到这个列表时，日志与今天逐字一致 ✓）。
      for (const entry of renderLogs) {
        const log = entry.fields || {};
        logInfo(entry.event || 'scan.multi_item.render', {
          request_id: requestId,
          open_id: openIdOf(req),
          [log.chainKey || 'chain']: String(entry.chain || ''),
          [log.addedCountKey || 'added_count']: Number(entry.count) || 0,
          [log.itemNosKey || 'item_nos']: (Array.isArray(entry.itemNos) ? entry.itemNos : []).slice(0, 50),
          [log.modeKey || 'mode']: String(entry.chain || ''),
        });
      }
      timing.render_ms = Math.max(0, Date.now() - renderStartedAt);
      // ⭐⭐ task-58：**这就是"她最后看到货品页"那条正证据** —— 与资金页那条（`page:'pay'`）
      //   在日志里一眼分得开 ✓（改前两条都只打 `scan.page.viewed`，长得一模一样 ✗）
      logRendered(req, {
        page: 'goods',
        // `realm:<领域>:<explicit|remembered|default>` —— 说得出"这一页是哪个领域、怎么来的"
        trigger: `realm:${realm}:${realmSource}`,
        number: String(view.number || lookupInputOf(req).recordId || ''),
      });
      // `total_ms` = 取数 + 渲染（整条链路的墙钟）—— 她要的是"这一页到底花了多久"。
      timing.total_ms = (Number(timing.total_ms) || 0) + timing.render_ms;
      service.logTiming?.(timing, { requestId, found: true });
      return sendHtml(res, 200, html);
    } catch (error) {
      // ⭐ task-58：**没渲染出页面**也要留痕（不然"扫了、日志里一条 rendered 都没有"）
      logRendered(req, {
        page: 'failed',
        trigger: 'render_failed',
        number: String(lookupInputOf(req).recordId || ''),
      });
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
  router.post(ROUTE_PATTERNS, uiTapResultMiddleware('scan'), async (req, res) => {
    const requestId = req.requestId;
    const body = req.body || {};
    const fields = writeConfig.fields;
    const actions = writeConfig.actions;
    let action = String(body[fields.action] || '');
    // ⭐⭐ 2026-10-16（task-59 · 加/删货那一半）：那两颗按钮**各自带自己的 name**（不是 `action` ✓）——
    //   所以下面那条"没 action 就猜成销售提交"的兜底**必须先把它们排除** ✗，
    //   否则她点「＋ 再加一个货品」会被当成**销售提交**（`submit_order`）✗✗。
    //   ⚠️ 字段名只从**工厂里那一份** `multiItemWire` 取（渲染与识别**同一个源** ⇒ 不会漂 ✓）。
    //   ⚠️ 只在**接线开着**时才认（缺省那两个字段名在页面上根本不存在 ⇒ 一个字都不影响既有逻辑 ✓）。
    const wireAddAction = String(multiItemWire?.addAction || '');
    const wireRemoveField = String(multiItemWire?.removeField || '');
    const isMultiItemAdd = Boolean(wireAddAction) && body[wireAddAction] !== undefined;
    const isMultiItemRemove = Boolean(wireRemoveField) && body[wireRemoveField] !== undefined;
    // ⭐⭐ 2026-10-12（她真机 400 / 1ms，`scan.write.unknown_action` 的 `action_kind=missing`、
    //   但 `body_keys` 里**该带的都带了**：submit_key / size / amount / gift / payment_* ✗）：
    //   ⇒ 那是"**没有提交者的提交**"（webview 里 JS/回车/隐式提交 ⇒ 浏览器**不送**按钮的 name/value ✗）。
    //   窄化兜底：**只有**在"没 action + 带幂等键 + 像销售提交"时，认作 `submitOrder`（并留痕 ✓）。
    //   ⚠️ 不碰标记（零哨兵风险 ✓）；只在这一页（编号页 POST）✓。
    if (!action && !isMultiItemAdd && !isMultiItemRemove
      && String(body[fields.submitKey] || '').trim()
      && (body[fields.size] !== undefined || body[fields.amount] !== undefined)) {
      action = actions.submitOrder;
      logWarn('scan.write.action_inferred', {
        request_id: requestId, reason: 'missing_action_default_submit',
        body_keys: Object.keys(body), path: String(req.originalUrl || '').split('?')[0],
      });
    }
    const openId = openIdOf(req);
    // 「回跳到哪一块」= 这一页的领域（认不出来一律回落缺省；两个入口同一条口径）。
    const realm = resolveRealm(req.query?.from);
    // ⭐ 2026-10-18（task-2）请求级包装（**不改 handler 源码**）：注入 sessionKey / context / 领域记忆。
    const pageToken = req?.scanPageTokenFromCookie === true ? String(req?.scanPageToken || '').trim() : '';
    const sessionId = pageSessionKey(openId, pageToken);
    const scopedWriteService = withPageSession(writeService, pageToken);
    const schedulePurchaseWriteForPage = (args) => (pageToken
      ? schedulePurchaseWrite({ ...args, context: { ...(args.context || {}), sessionKey: sessionId } })
      : schedulePurchaseWrite(args));
    const markRealmUsedForPage = (who, realmId) => markRealmUsed(pageSessionKey(who, pageToken), realmId);

    // ══════════════════════════════════════════════════════════════════════════
    // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）
    //   · **加货** = 同一张表单里的第二颗 submit ⇒ 它**带着她刚填的尺码/数量**（`sizes` / `qty_*`
    //     或 `return_sizes` / `return_qty_*`）一起 POST 过来 ✓ —— 这正是"值不丢"的物理保证
    //     （改前那颗 `<a href="…?add=1">` 是 GET：**天生带不走**表单字段 ✗）。
    //   · 这里把它**存进草稿**（`readMultiItemPending` / `writeMultiItemPending`）再 **303 回本页**
    //     （PRG：刷新不重复加 ✓；回来那一页由 GET 把"已加的货品"渲出来 ✓）。
    //   · **删除** = 列表行里那颗 submit（`name=<删货字段> value=<该件 record_id>`）⇒ 从草稿里摘掉它 ✓。
    //   🔴 **只认草稿里的那一份**，**不查表、不写业务表**（这一半一个字节都不落业务表 ✓）。
    //   🔴 N=1 那条老路径**一个字都不变**：这里只吃「加货 / 删货」那两个动作，别的一个都不碰 ✓。
    //   ⚠️ `isMultiItemAdd` / `isMultiItemRemove` / 两个字段名**在上面那个兜底之前就取好了** ✓
    //     （不然她点"加"会被当成销售提交 ✗）。
    // ══════════════════════════════════════════════════════════════════════════
    if (isMultiItemAdd || isMultiItemRemove) {
      // ⚠️ 回跳口径与页面上的表单 `action` **同一处**（`:` 下面别的分支用的也是它 ✓ 不另拼一份 ✗）
      const backPathOf = (realmId) => postActionFor(
        backTargetFor(req, decodeURIComponent(String(req.params.recordId || ''))), realmId,
      );
      // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**加货成功之后**，这一发回跳带上触发参数
      //   ⇒ 回来的那一页（**同一个领域** ✓）才去调飞书扫一扫 ⇒ 扫到的那件带 `?from=<领域>` 落回来 ✓。
      //   🔴 **只加在"加货"上，不加在"删除"上**（删完不该弹相机 ✗）；
      //   🔴 **只在这一页的领域配了链、且开关开着时加**（关着 ⇒ 回跳与今天逐字一致 ✓ `AC-ML5`）。
      //   ⭐⭐ 2026-10-16 21:1x（本卡）：实现**提到工厂那一层**（`addBackPath(page, realmId)` ✓）
      //     —— 因为**销售**那条 303 也要用**同一份**（不写第二套 ✗）。这里只负责按**既有口径**
      //     算出这一页的页路径（`backPathOf` ✓ 逐字没变 ✗），再交给它。
      const addBackPathFor = (realmId) => addBackPath(backPathOf(realmId), realmId);
      const backPath = () => backPathOf(realm);
      // 认不出是哪条链（不是补货 / 退货那两块）⇒ 与既有的"认不出的动作"同一条口径：给它一句人话 ✓
      const draftChain = realm === 'replenish' ? 'replenish'
        : (realm === PURCHASE_RETURN_REALM ? 'return' : '');
      if (!draftChain) {
        markTapCode(res, 'multi_item_chain_unknown');
        return respondWriteFailure(res, {
          code: 'multi_item_chain_unknown', message: writeConfig.texts.unknownActionBody,
        }, requestId);
      }
      if (!writeService) {
        markTapCode(res, 'write_disabled');
        return respondWriteFailure(res, {
          code: 'write_disabled', message: writeConfig.texts.writeDisabledBody,
        }, requestId);
      }
      const chainKind = draftChain === 'replenish' ? 'replenish' : 'purchase_return';
      // 「哪一件」的身份口径**与引擎的 `addItem` / `removeItem` 同一套**（`product_record_id` 优先，
      //   回落 `number` / `item_no` ✓）—— 两边不一致的话，删除会摘不掉那一件 ✗。
      const keyOfItem = (item) => String(
        (item && (item.product_record_id || item.productRecordId || item.number || item.item_no)) || '',
      ).trim();
      const pending = await readMultiItemPending(sessionId, draftChain);
      if (isMultiItemRemove) {
        const removed = String(body[wireRemoveField] || '').trim();
        const left = pending.items.filter((item) => keyOfItem(item) !== removed);
        await writeMultiItemPending(sessionId, draftChain, { orderKey: pending.orderKey, items: left });
        return res.redirect(303, backPath());
      }
      // ── 加货：本次表单的尺码/数量（**与提交那条路同一个解析器、同一份校验** ✓ 不手抄 if-else ✗）
      const entries = draftChain === 'replenish'
        ? parseReplenishEntries(body, fields, writeConfig)
        : parseReturnEntries(body, fields, writeConfig);
      const groups = mergeFirstItemEntries(parseMultiItemGroups(body, multiItemOrderConfig), entries);
      if (!groups.length) {
        // 表单里没有那个首件（手改表单 / 老页面）⇒ 不猜、不存空件 ⇒ 与人话页（400）✓
        markTapCode(res, 'multi_item_no_item');
        return respondWriteFailure(res, {
          code: 'multi_item_no_item', message: writeConfig.texts.unknownActionBody,
        }, requestId);
      }
      // 🔴 她填错了 ⇒ **当场同步拦**（400 + 写层那一句人话 + **零写入**）—— 与提交那条路同一条口径 ✓
      const violation = purchaseEntryViolation({ chain: chainKind, entries });
      if (violation) return purchaseEntryInvalidPage(req, res, requestId, realm, violation);
      // 把"已经加进来的"与"刚加的这件"接上（同一货品 ⇒ 覆盖那一件 ✓ 与引擎的 `addItem` 同口径）
      const added = groups[0];
      const at = pending.items.findIndex((item) => keyOfItem(item) === keyOfItem(added));
      const items = pending.items.slice();
      if (at >= 0) items[at] = added; else items.push(added);
      await writeMultiItemPending(sessionId, draftChain, { orderKey: pending.orderKey, items });
      // ⭐⭐ 2026-10-16（task-61 · ①「补充日志和埋点」）：**加货那一刻**的那一条
      //   —— 她当时问的是「扫了 B 但页面上没看到 A」：是**没存进去**、还是**存了没读出来** ✗✓
      //   ⇒ 这一条说"存进去了几件、存的是哪一件"；渲染那一条（`scan.multi_item.render`）说"读出来几件"。
      //   🔴 **纯 additive**：一个判定都不动（写完才打 ✓ 打日志失败也绝不影响她 ✗）；
      //   🔴 键名**全从配置取**（`multiItemOrderConfig.logFields` ✓ 逻辑里不写死 ✗）；
      //   🔴 关联键按既有口径带（`request_id` / `open_id` / `order_key` ✓ **拿不到就不传** ✗）。
      {
        const log = multiItemOrderConfig.logFields || {};
        logInfo(log.addEvent || 'scan.multi_item.add', {
          request_id: requestId,
          open_id: openId,
          [log.chainKey || 'chain']: draftChain,
          [log.addedCountKey || 'added_count']: items.length,
          [log.productKey || 'product']: keyOfItem(added) || '',
          [log.entriesKey || 'entries']: (Array.isArray(added?.entries) ? added.entries : [])
            .map((entry) => ({ size: String(entry?.size || ''), quantity: String(entry?.quantity || '') })),
          [log.orderKeyKey || 'order_key']: String(pending.orderKey || ''),
        });
      }
      return res.redirect(303, addBackPathFor(realm));
    }

    // ── ⭐⭐ 2026-10-11：扫码页「货品」领域 →【打印这一款】──────────────────────
    // 🔴 它**排在下面"扫码写入口关着 ⇒ 503"那道闸门之前**：打印这一款**不写任何业务表**
    //    （只把一条任务排进打印队列），所以与"销售/采购写入口开不开"是两件事。
    // ⚠️ 编号**只认 URL 里的那个**（表单里刻意不放编号字段）⇒ 手改表单也打不了别的款。
    // ⚠️ 页面上**零 JS**：这里就是一个原生表单的 POST，成功后 303 回本领域（PRG，
    //    刷新不会重复提交），状态由 GET 重新渲染。
      if (action === actions.printLabel) {
        return handlePrintLabelOf({
          req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService: scopedWriteService, sendHuman, notFoundPage, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, resolveLabelPrintQueue, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

    // ⭐ 2026-10-29：非销售 flow（售后换款式）的货品页提交到此为止（不跳资金页、零写入）
    if (handlePendingExchangeSubmit({ req, res, requestId, action, actions, realm, sendHuman, markTapCode, postActionFor, backTargetFor })) return;

    if (!writeService) {
      // ⭐ 埋点 P0 ②：原因码（写入口关着 —— 与"她填错了"分开，修法完全不同）
      markTapCode(res, 'write_disabled');
      return sendHuman(res, 503, {
        title: writeConfig.texts.writeDisabledTitle,
        body: writeConfig.texts.writeDisabledBody,
        requestId,
      });
    }
    try {
      // ── 加入本单 ────────────────────────────────────────────────────────────
      if (action === actions.addLine) {
        return handleAddLineOf({
          req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService: scopedWriteService, addBackPath, notFoundPage, respondWriteFailure, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

      // ── 清空本单 ────────────────────────────────────────────────────────────
      if (action === actions.clearDraft) {
        return handleClearDraftOf({
          req, res, requestId, body, fields, realm, action, openId, writeService: scopedWriteService, backTargetFor, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM,
        });
      }
      

      // ── 第 2 步【提交整单付款】⇒ **走既有那条诚实钱路**（不做第二套账 ✗）─────────────
      //    `followup.addPayment(...)` = 工作台「补记收款」用的同一条链路（`routes/workbench.js:215` ✓）
      //    🔴 三条红线：① 只有**写成功**才说"已收" ✓ ② 没填 ⇒ 待补充（不是失败）✓
      //                ③ 幂等沿既有 `requestId`（**不自造** ✓）
      if (action === (config.paymentStep?.payAction || 'payment_pay')) {
        return handlePaymentPayOf({
          SalesFollowupService, asList, backTargetFor, body, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, markRealmUsed: markRealmUsedForPage, openId, openIdOf, parsePaymentRows, realm, realmOfAction, req, requestId, res, respondSettlementBlock, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, service, voucherPayments, writeConfig, writeService: scopedWriteService, options, lookupInputOf, salesAsync,
        });
      }

      // ── 提交销售单 ──────────────────────────────────────────────────────────
      if (action === actions.submitOrder) {
        return handleSubmitOrderOf({
          asList, backTargetFor, body, buildWriteContext, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, lookupInputOf, markRealmUsed: markRealmUsedForPage, openId, openIdOf, parsePaymentRows, postActionFor, realm, realmOfAction, renderScan, req, requestId, res, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, service, writeConfig, writeService: scopedWriteService, nextOrderNo: () => salesRuntime.orderNoCache.next(),
        });
      }

      // ── 补货报单 ────────────────────────────────────────────────────────────
      if (action === actions.replenish) {
        return handleReplenishOf({
          action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed: markRealmUsedForPage, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, parseReplenishEntries, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite: schedulePurchaseWriteForPage, service, submitMultiItemOrder, writeConfig, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure,
        });
      }

      // ── ⭐ 采购退货（业务负责人 2026-10-11：「和"报货"逻辑一样，也走扫码」）────────
      //    与补货**同形**：同一个 POST 端点、同一套会话/幂等/失败口径；
      //    写库（批次行 + 退货明细 + 扣库存 + 出退货单图）全在既有构件里。
      if (action === actions.purchaseReturn) {
        return handlePurchaseReturnOf({
          action, backTargetFor, body, fields, invalidateInventorySnapshot, markRealmUsed: markRealmUsedForPage, mergeFirstItemEntries, multiItemOrderConfig, notFoundPage, openId, openIdOf, parseMultiItemGroups, purchaseAmountInvalid, purchaseAmountInvalidPage, purchaseAmountMissing, purchaseAmountMissingPage, purchaseEntryInvalidPage, purchaseEntryViolation, purchaseWriteDisabledError, realm, realmOfAction, req, requestId, res, respondWriteFailure, scanTargetOf, schedulePurchaseWrite: schedulePurchaseWriteForPage, service, submitMultiItemOrder, writeConfig, lookupInputOf, sendHuman, badNumberPage, respondFailure, unknownActionFailure, parseReturnEntries,
        });
      }

      // ⭐⭐ 2026-10-14：**所有动作分支都不匹配 ⇒ 照旧给人话**（`unknownActionFailure`）——
      //   ⚠️ 拆验收那几刀时，这个**通用兜底调用点**被连带摘掉过 ✗ ⇒ 症状：未知动作的 POST
      //      **永远没人应答** ⇒ 客户端 `fetch` 挂住 ≈301 秒 ✗（`test/scanPageWrite.test.js` 的 ⑨ 抓到 ✓）
      //   ⇒ 这里按 HEAD 的原样补回（**产品行为修复** ✓ 不是改测试绕开 ✗）
      return unknownActionFailure(req, res, requestId, action);
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

  // 深拆 P3c：写上下文/多货品提交/打印上下文 helpers → ./flowHelpers.js（显式注入；函数体逐字）
  const {
    submitMultiItemOrder, buildWriteContext, loadPendingBatches, invalidateInventorySnapshot, clearDraftForScanIfNeeded, buildPrintContext,
  } = require('./flowHelpers').createFlowHelpers({
    DEFAULT_REALM, LABEL_PRINT_QUEUE, arrival, backTargetFor, buildPaymentRows, candidatePaymentMethods, clearMultiItemPending, config, fillWriteText, invalidateLiveInventorySnapshot, logError, logInfo, logRendered, logWarn, markRealmUsed, multiItemOrder, multiItemOrderConfig, multiItemWire, openIdOf: sessionIdOf, postActionFor, purchaseBackground, realmEntryParams, realmOfAction, realmScanConfig, renderMinimalPage, resolveLabelPrintQueue, respondWriteFailure, router, scanTargetOf, sendHtml, setDraftOrderAmount, writeConfig, writeService,
  });


};

module.exports = { installScanPageRoutes };
