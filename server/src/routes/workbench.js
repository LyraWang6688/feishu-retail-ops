const express = require('express');
// 准入闸门（未启用认证 503 / 未登录 401 / 白名单外 403）：**工作台与扫码页共用这一份**。
// 它留在本文件里（没有搬去 middleware/）—— 既有哨兵用例
// （`test/workbenchTwoTabsAndQueryEntries.test.js` 的 AC9/AC10）钉着这里必须看得见
// `require('./feishuWebAuth')`，而"扫码页也走同一道闸门"只要求**共用同一个函数**，
// 不需要搬家。扫码路由 `routes/scanPage.js` 从这里 require 它。
const { enabled: feishuAuthEnabled, getSessionUser, allowedOpenIds } = require('./feishuWebAuth');
const { setTraceFields } = require('../utils/traceContext');
const { roleOf } = require('../config/trace');
const { SalesFollowupService } = require('../services/salesFollowupService');
// ⭐ 2026-10-15：**进程级共享实例**（配品成单那条新链路也要能作废同一份缓存 ⇒ 见该模块注释）
const { sharedWorkbenchOrdersCache } = require('../services/workbenchOrdersCache');
const { readWorkbenchOrdersConfig } = require('../config/workbenchOrders');
const { createWorkbenchLabelRoutes } = require('./workbench/labels');
const { createWorkbenchInventoryRoutes } = require('./workbench/inventory');
const { createWorkbenchPurchaseRoutes } = require('./workbench/purchase');
const { createWorkbenchSalesRoutes } = require('./workbench/sales');
// ⭐⭐ 2026-10-16（task-56）：异步之后**金额这道校验留在同步路径** —— 规则与文案**都取既有那一份**
//    （`parseActualAmount` 只有一处实现 ✓ `config/purchaseArrivalTexts` 的 `pageMessages` ✓）
//    ⇒ 本文件**不抄第二份规则、也不新写一句中文** ✗。
const { logError, logInfo, logWarn } = require('../utils/logger');
// ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤「**工作台接同一套上报**」）：端点处理与结果事件都来自
//   `utils/uiTapReport.js` —— 与**扫码页共用同一份实现**（事件名 / 字段 / ④ 判据 / ② 结果事件
//   全是同一套 ✓ 不抄第二份 ✗）；本文件只负责"挂在工作台这道闸门之后"。
const { UI_TAP } = require('../config/uiTap');
const { handleUiTap, uiTapResultMiddleware } = require('../utils/uiTapReport');
// ⭐⭐ 2026-10-13 Lead 更正：**工作台「扫一扫」照抄扫码页那套 AppLink**（AppLink **不需要签名** ✗）——
//    AppLink 目标与 UA 判据**都取既有唯一来源**（`config/scanPage.js` 的 `SCAN_NEXT` +
//    `views/scanPageRenderer.js` 导出的 `canScanNextWithFeishu`）⇒ **不抄第二份** ✓
const { SCAN_NEXT } = require('../config/scanPage');
// ⭐⭐ 2026-10-14：工作台「销售 → 配品」子 tab（业务负责人：「整体都迁移过去」✓）
// 2026-10-14: the old acceptance flow moves into the workbench (reuse the existing arrival session service)
// ⭐⭐ 2026-10-16（task-56）：工作台【确认到货】也接异步 ⇒ 「后台那一跑」用**补货 / 退货同一件**
//   共用件（#664 ✓ 形状照销售那件）—— **不另造第二个后台件** ✗。
const { canScanNextWithFeishu } = require('../views/scanPageRenderer');
// ⭐⭐ 2026-10-14：「扫码打印」要的飞书 JSAPI 签名（服务在 `services/larkJsapiService.js`，
//    密钥只从 env 读；本文件只把它挂到**既有**工作台闸门之后 —— 不新开鉴权 ✗）。
const { createLarkJsapiService } = require('../services/larkJsapiService');

// ⚠️ 准入闸门只有这一份实现：语义与文案**逐字不变**（2026-10-08 的《工作台准入口径》沿用它）。
// 扫码页（`GET /r/:recordId`）require 的也是它 —— 不新开鉴权、也不抄第二份判断。
const requireWorkbenchAccess = (req, res, next) => {
  if (!feishuAuthEnabled()) return res.status(503).json({ success: false, error: '飞书身份认证尚未启用' });
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ success: false, error: '请先通过飞书身份登录工作台', auth_required: true });
  const allowed = allowedOpenIds();
  if (allowed.size && !allowed.has(user.open_id)) return res.status(403).json({ success: false, error: '当前飞书账号未被授权使用工作台' });
  req.workbenchUser = user;
  // 埋点收尾刀：身份确定后补角色维度（只记 role 枚举，不记 open_id）
  setTraceFields({ role: roleOf(user.open_id) });
  return next();
};

const createWorkbenchRouter = (options = {}) => {
  const router = express.Router();
  // ⭐⭐ 2026-10-12（她「一直说正在读取订单」）：订单列表的 TTL 缓存 ——
  //   ⚠️ **一个实例贯穿"读"（`followup.listOrders`）与"写"（下面四条 + 订单动作两条）**：
  //      写成功之后由本层 `invalidate()`，她下一次读一定是新数据（不许看到旧数据）。
  //   TTL 在 `config/workbenchOrders.js`（`WORKBENCH_ORDERS_CACHE_MS`，默认 30 秒；`0` = 关掉）。
  const ordersConfig = options.ordersConfig || readWorkbenchOrdersConfig();
  const ordersCache = options.ordersCache || sharedWorkbenchOrdersCache({ ttlMs: ordersConfig.ordersCacheMs });
  const followup = options.followup || new SalesFollowupService({ ordersCache, ordersConfig });
  // ⭐ 工作台「扫一扫」这一屏要的两样：**AppLink 目标** + **本设备能不能调起飞书扫一扫**
  //    （服务端看 UA —— 与扫码页同一个判据 ✓ 电脑/手机自带浏览器 ⇒ canScan:false ⇒ 前端给人话+手输 ✗ 死按钮）
  router.get('/scan-entry', requireWorkbenchAccess, (req, res) => res.json({
    success: true,
    appLink: SCAN_NEXT.applink,
    canScan: canScanNextWithFeishu(req.get('user-agent')),
  }));

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });
  router.use(requireWorkbenchAccess);

  /**
   * ⭐⭐ 2026-10-14 晚（埋点 P0 ⑤）：**工作台接同一套上报**。
   *   · 端点：`POST /api/workbench/ui-tap`（挂在**既有** `requireWorkbenchAccess` 之后 ⇒
   *     未启用认证 503 / 未登录 401 / 白名单外 403 —— 与别的接口**同一个函数**，不新开鉴权 ✗）；
   *     ⚠️ 未登录时浏览器那一下 `sendBeacon` 就静默丢弃 ✓（埋点失败**从不**影响她操作 ✓）。
   *   · 处理体 = `handleUiTap`（扫码页用的**同一个**函数）⇒ 事件名 / 字段 / ④ 重复判据 /
   *     204-400 契约**逐字一致** ✓。
   */
  router.post(UI_TAP.paths.workbench, (req, res) => handleUiTap({ req, res, scope: 'workbench' }));

  /**
   * ⭐⭐ ② 结果事件：工作台的写接口很多，**一个 `router.use` 全覆盖** ——
   *   凡带了 `tap_id` 的请求（= 页面上点出来的那些）都在响应 `finish` 时记一条 `ui.tap.result`
   *   （状态 + 原因码 + 耗时）；GET / 别的调用方**不带 tap_id ⇒ 完全不进这条链**（零开销 ✓）。
   */
  router.use(uiTapResultMiddleware('workbench'));

  // ── ⭐⭐ 2026-10-14：飞书 **JSAPI 签名**（给「扫码打印」调起飞书扫一扫用）────────────
  /**
   * `GET /api/workbench/lark/jsapi-signature?url=<页面地址>`
   *
   * 依据（**都在文件里**）：业务负责人 2026-10-14 晚选了 ⓐ「扫完直接打印这一张」
   *   ⇒ `docs/scan-to-print-jsapi-2026-10-14.md` AC-SP1/SP2/SP3。
   *
   * 🔴 **不新开鉴权**：它就挂在本文件既有那道 `requireWorkbenchAccess` 之后
   *    （未启用认证 503 / 未登录 401 / 白名单外 403 —— 与其它工作台接口**同一个函数**）。
   * 🔴 **响应里不含任何密钥** ✗：只有 `h5sdk.config` 要的 `appId/timestamp/nonceStr/signature`
   *    （外加页面引入 JSSDK 用的公开地址 `jssdkUrl`）；**app secret / jsapi_ticket / token
   *    一个字符都不回** ✓（也不进日志 ✗）。
   * ⚠️ 单例复用：`createLarkJsapiService()` 内部缓存 `tenant_access_token` / `jsapi_ticket`
   *    ⇒ **必须复用同一个实例**，否则每次请求都去飞书换一次票（AC-SP3 就白做了）。
   * ⚠️ 用例可以注入 `options.larkJsapi`（假 fetch）来真红真绿。
   */
  let larkJsapi = options.larkJsapi || null;
  const resolveLarkJsapi = () => {
    if (!larkJsapi) larkJsapi = createLarkJsapiService();
    return larkJsapi;
  };
  router.get('/lark/jsapi-signature', async (req, res) => {
    const pageUrl = String(req.query?.url || '').trim();
    try {
      const result = await resolveLarkJsapi().signatureFor(pageUrl);
      if (!result.ok) {
        // 认得出错在哪 ⇒ 400（她/页面填错）；没配凭证 ⇒ 503（服务端缺配置）；其余 ⇒ 502（上游）。
        const status = result.reason === 'host_not_allowed' || result.reason === 'url_invalid'
          ? 400
          : (result.reason === 'not_configured' ? 503 : 502);
        logWarn('workbench.lark.jsapi_signature.failed', {
          request_id: req.requestId, reason: result.reason,
        });
        return res.status(status).json({ success: false, error: result.message, reason: result.reason });
      }
      logInfo('workbench.lark.jsapi_signature.ok', {
        request_id: req.requestId,
        // ⚠️ 只记域名（排障够用）；**签名 / 票 / 密钥一个字都不进日志** ✗。
        host: (() => { try { return new URL(result.url).host; } catch { return ''; } })(),
      });
      return res.json({
        success: true,
        appId: result.appId,
        timestamp: result.timestamp,
        nonceStr: result.nonceStr,
        signature: result.signature,
        url: result.url,
        // 页面要引入的 JSSDK（公开地址，来自 `config/larkJsapi.js` ⇒ 页面不抄第二份 ✓）。
        jssdkUrl: resolveLarkJsapi().config?.jssdkUrl || '',
        jsApiList: ['scanCode'],
      });
    } catch (error) {
      logError('workbench.lark.jsapi_signature.error', {
        request_id: req.requestId, error: error.message,
      });
      // 文案仍走配置（`config/larkJsapi.js` 的 `texts.upstreamFailed`）—— 路由里不写死中文。
      const texts = resolveLarkJsapi().config?.texts || {};
      return res.status(502).json({ success: false, error: texts.upstreamFailed });
    }
  });

  router.use(createWorkbenchPurchaseRoutes({ options, ordersCache }));
  // 库存 / 标签打印：各自子 router（2026-10-28 拆分；鉴权与 no-store 仍由父 router 统一加）。
  router.use(createWorkbenchInventoryRoutes(options));
  router.use(createWorkbenchLabelRoutes(options));
  router.use(createWorkbenchSalesRoutes({ options, followup, ordersCache }));
  return router;
};

// `requireWorkbenchAccess` 也导出：扫码路由（`routes/scanPage.js`）要用**同一个**闸门函数。
module.exports = { createWorkbenchRouter, requireWorkbenchAccess };
