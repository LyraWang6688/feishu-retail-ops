'use strict';

/** 扫码页公共入口（P4-2a 从 routes.js 搬出）。 */
const installScanPagePublicRoutes = ({ router, ctx }) => {
  const {
    SUBMIT_TOAST, config, handleUiTap, logInfo, logWarn, realmScanConfig, renderSalesHome, resolveLarkJsapi,
    resolveRealm, sendHtml,
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



};

module.exports = { installScanPagePublicRoutes };
