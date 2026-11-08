'use strict';

/**
 * 扫码页的准入中间件（阶段 5b 从 index.js 搬出）：
 *   no-store → 扫码登录重定向 / ticket → 共享工作台闸门 → per-page token。
 * 顺序逐字保持；本文件只接线，不新造判据。
 */
const installScanPageMiddleware = ({
  router, config, getWriteService, feishuAuthEnabled, getSessionUser,
  buildLoginStartUrl, resolveScanNext, COOKIE_NAME, encodeSession,
  SCAN_AUTH_REDIRECT, TICKET, redeemSessionTicket, pathWithoutTicket,
  logInfo, logWarn, requireWorkbenchAccess, createPageTokenMiddleware, createLegacySessionProbe,
}) => {
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
    // 2026-10-13: try the one-time URL ticket first (WebView keeps no cookie).
    //   ok -> set the session cookie here and 302 to the same path WITHOUT the ticket.
    //   expired/used/forged/other-path -> fall through to a fresh login (never half-logged-in).
    const ticketToken = TICKET.enabled ? req.query?.[TICKET.paramName] : '';
    if (ticketToken) {
      const targetPath = pathWithoutTicket(req.originalUrl || req.url || '');
      const redeemed = redeemSessionTicket(String(ticketToken), { targetPath });
      if (redeemed.ok) {
        const sessionCookie = encodeSession({ open_id: redeemed.openId, name: redeemed.name });
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionCookie}; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=None`);
        return res.redirect(302, targetPath);
      }
      logWarn(SCAN_AUTH_REDIRECT.events.loginRedirect, {
        reason: `ticket_${redeemed.reason}`,
      });
    }
        if (getSessionUser(req)) return next();
    // 「刚才那一页」= 原 path + 原 query（本 router 挂在 `SCAN_PAGE.route.recordBasePath` 上，
    // `req.originalUrl` 已经含挂载点）。再过一次回跳白名单：只放行扫码页自己，
    // 别的（`//host`、协议、绝对 URL、`/s/../api/...`）一律回落工作台首页。
    const target = resolveScanNext(
      String(req.originalUrl || `${config.route.recordBasePath}${req.url || ''}`),
    );
    logInfo(SCAN_AUTH_REDIRECT.events.loginRedirect, {
      request_id: req.requestId,
      next: String(target).slice(0, 200),
    });
    return res.redirect(302, buildLoginStartUrl(target));
  });

  router.use(requireWorkbenchAccess);
  // ⭐⭐ 2026-10-18（task-2）：per-page token —— GET 首次访问 Set-Cookie；POST 自动携带；
  //   POST 没有 cookie（旧页面）⇒ `req.scanPageToken = ''` ⇒ 回落既有 openId 共享路径（不报错）。
  router.use(createPageTokenMiddleware({
    // ⭐ 过渡期保护：她手上那份"本单 N 双"还在 openId 会话里、而这一发 GET 还没 cookie
    //   ⇒ **先不换身份**（实现在 `./pageToken`；本文件只接线）。
    hasLegacySession: createLegacySessionProbe({
      getSessions: () => writeService?.sessions,
      openIdOf: (request) => String(
        request.workbenchUser?.open_id || getSessionUser(request)?.open_id || '',
      ),
    }),
  }));

};

module.exports = { installScanPageMiddleware };
