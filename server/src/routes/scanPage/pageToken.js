'use strict';

/**
 * ⭐⭐ 2026-10-18（task-2「扫码会话按页面/设备隔离，防两页混单」）：
 * **per-page token** —— 同一账号在两台设备 / 两个浏览器上打开扫码页时，
 * 各自的草稿（`data/scan_sessions/`）必须**分开**，不能共用一份本单。
 *
 * 为什么之前会混单（改前事实）：
 *   · 会话 id = `<前缀>_<open_id 哈希>`（`services/scanSessionService.js` 的 `idOf`）——
 *     **只按人分**。同一账号在两台手机上扫 A、扫 B ⇒ 读到的是**同一份** `sale.lines`，
 *     加货 / 清空 / 提交互相顶掉；
 *   · 进程内 queue（`KeyedSerialQueue`）只防**并发覆盖**，防不了"两个页面共用一份本单"。
 * 修法（**用现有 `sessionKey` 机制，不另造一套存储**）：
 *   · 页面层生成/复用**一个 token**，放 **cookie**（`HttpOnly; SameSite=Lax; Path=/`）——
 *     浏览器在同源 POST 时**自动携带**，所以**一个表单字段都不用加**；
 *   · 路由把 token 作为 `sessionKey` 透传给写服务（`scanWriteService` 的
 *     `sessionKeyOf(openId, sessionKey)`：非空 ⇒ 会话键 = 它，否则回落 openId）；
 *   · 会话键 = **openId + token**（本文件 `pageSessionKey`），哈希后落在
 *     `scan_session_<hash>` 文件上 —— 仍是 `services/scanSessionService.js` **同一套**存储。
 *
 * 兼容（旧页面 / 无 cookie）：
 *   · **GET** 首次访问：Set-Cookie（HttpOnly / SameSite=Lax / Path=/）；
 *   · **POST 没有 cookie**（部署前就打开的旧页面 / 浏览器拒收 cookie）⇒
 *     `req.scanPageToken === ''` ⇒ 本文件所有包装函数**原样返回**（不注入 sessionKey）
 *     ⇒ 回落既有"按 openId 共享一份会话"的老路，**不报错、一个字节都不变**。
 *
 * ⚠️ 为什么放**独立文件**而不是塞进 `sessionFlow.js`：
 *   `test/scanPageSessionFlow.test.js` 有一条**源码哨兵**逐字钉着
 *   `module.exports = { createMultiItemPending, createPurchaseScheduler }` ——
 *   往那个文件的导出里加东西会让那条既有判据变红（那条判据本身是对"只搬不改"的护栏，**不放宽**）。
 */

const crypto = require('node:crypto');
const { readFlag, readInt, readString } = require('../../config/envValue');

/**
 * token 的生命周期 / cookie 名 —— **配置先行**（换名字 / 换时长不用改逻辑）。
 *  · `ttlMs`：**默认 7 天**。会话自己的 TTL 是 12 小时（`SCAN_SESSION_TTL_MS`），
 *    token 刻意比会话长：token 过期只意味着"这台设备换一份新身份"（下次 GET 会发新的），
 *    本来也不会把旧草稿"续"回来；而 token 太短反而会在她还在扫的时候把页面变成"无 token 旧页面"。
 *  · `enabled`：**显式布尔**（关掉 = 完全回到改前：不发 cookie、不注入 sessionKey）。
 */
const PAGE_TOKEN = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_PAGE_TOKEN_ENABLED', true),
  cookieName: readString(process.env, 'SCAN_PAGE_TOKEN_COOKIE', 'scan_page_id'),
  ttlMs: readInt(process.env, 'SCAN_PAGE_TOKEN_TTL_MS', 7 * 24 * 60 * 60 * 1000, {
    min: 60_000, max: 30 * 24 * 60 * 60 * 1000,
  }),
});

/**
 * 会话键里 openId 与 token 之间的分隔符。
 * ⚠️ 只出现在**本地会话文件 / 本地日志**里（会话 id 会先被 sha256 哈希成
 * `scan_session_<16 hex>`，文件名字符集不受它影响）。
 */
const SESSION_KEY_SEPARATOR = '|page|';

/** 合法 token：URL-safe 的固定长随机串（生成端是 16 字节 hex = 32 字符）。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** 生成一个新的 per-page token（**不落任何存储**：它只活在 cookie 里）。 */
const newPageToken = () => crypto.randomBytes(16).toString('hex');

/** 宽松解析 `Cookie` 头（不引依赖：仓库里没有 cookie-parser）。 */
const parseCookieHeader = (header) => {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (!name) continue;
    let value = part.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch (error) {
      // 坏 cookie 不抛、也不当 token（按"没有"处理 ⇒ 旧页面回落路径）。
      continue;
    }
    out[name] = value;
  }
  return out;
};

/** 从请求里读 per-page token：**没有 / 不合法 ⇒ 空串**（= 旧页面）。 */
const readPageToken = (req) => {
  const name = PAGE_TOKEN.cookieName;
  const raw = parseCookieHeader(req?.headers?.cookie)[name];
  const token = String(raw || '').trim();
  return TOKEN_PATTERN.test(token) ? token : '';
};

/**
 * `Set-Cookie` 的取值。
 * 🔴 属性按 task-2 要求逐字：**HttpOnly · SameSite=Lax · Path=/**
 *   · HttpOnly —— 页面脚本拿不到它（这一页本来零 JS，多一道防手改）；
 *   · SameSite=Lax —— 同源表单 POST **照常携带**（同站请求不受 Lax 限制），
 *     而从别的站点的跨站 POST 不带（少一个被塞 token 的面）；
 *   · 不加 `Secure`：本机 / 内网 http 调试与用例也要能种上（线上 https 下 Lax cookie 同样可用）。
 */
const pageTokenCookie = (token, config = PAGE_TOKEN) => {
  const maxAge = Math.max(1, Math.floor(Number(config.ttlMs) / 1000));
  return `${config.cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
};

/**
 * 中间件：给"这一页"定一个 token。
 *  · 已有合法 cookie ⇒ 复用（**同一页面刷新 / 连扫多件仍是同一份草稿**）；
 *  · GET/HEAD 且没有 ⇒ **生成并 Set-Cookie**（首次访问）；
 *  · 非 GET（POST）且没有 ⇒ **不生成**（旧页面：`req.scanPageToken = ''` ⇒ 回落 openId 老路）。
 *
 * ⭐⭐ 2026-10-18 **上线过渡期的一条保护**（`hasLegacySession`）：
 *   部署那一刻，有些手机上的旧页面**还没有这个 cookie**，而她手上可能正攒着"本单 N 双"
 *   （那 N 双在 **openId 共享会话**里）。如果这次 GET 直接发一个新 token 并**按新 token 渲染**，
 *   她眼前那份本单就"消失"了（新 token 的会话是空的）—— 那不是隔离，是丢东西 ✗。
 *   ⇒ 规则：GET 没 cookie、**但 openId 那份会话还在（没过期）** ⇒ **这一发先不换身份**
 *     （不发 token、`req.scanPageToken = ''` ⇒ 照旧读写 openId 那份）；等她那一单结束 / 会话过期，
 *     下一次 GET 自然拿到 token、从新的一页开始（旧会话留在本地，不影响任何判据）。
 *   ⚠️ 代价只有"老用户多共享一阵"：隔离在**新页面/新设备**上立即生效，过渡期不丢她的草稿。
 */
const createPageTokenMiddleware = (options = {}) => {
  const config = options.config || PAGE_TOKEN;
  const hasLegacySession = options.hasLegacySession;
  return async (req, res, next) => {
    req.scanPageToken = '';
    // ⭐ 这个 token 是**浏览器带回来的**（= 这一页的"身份"）还是**这一发刚发的**？
    //   刚发的那个 token 只用于**下一次**请求：这一发渲染仍按旧路径（见 index 的 `sessionIdOf`）——
    //   否则会有一瞬间"页面按新 token 渲染、POST 却按旧路径写"的错位（对**丢 cookie 的 WebView** 尤其致命）。
    req.scanPageTokenFromCookie = false;
    if (config.enabled !== true) return next();
    const existing = readPageToken(req);
    if (existing) {
      req.scanPageToken = existing;
      req.scanPageTokenFromCookie = true;
      return next();
    }
    const method = String(req.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next();
    // 过渡期保护：旧页面（没 cookie）但 openId 那份会话还在 ⇒ 先不换身份（见上面注释）
    if (typeof hasLegacySession === 'function') {
      const keepLegacy = await hasLegacySession(req).catch(() => false);
      if (keepLegacy === true) return next();
    }
    const token = newPageToken();
    req.scanPageToken = token;
    // ⚠️ 用 `append`（不是 `setHeader`）：同一响应上可能还有别的 Set-Cookie（例如登录票换 cookie）。
    res.append('Set-Cookie', pageTokenCookie(token, config));
    return next();
  };
};

/**
 * 会话键 = **openId + token**（`scanWriteService.sessionKeyOf` 认的就是这个"可选 sessionKey"）。
 *  · 没有 token（旧页面）⇒ 原样返回 openId ⇒ **与改前逐字同一个会话键**；
 *  · 已经带过分隔符（同一个 token 的键被再传一次）⇒ 原样返回（**幂等**）——
 *    路由里"读会话"与"写会话"两条路可能一个传 openId、一个传会话键，不能套娃。
 */
const pageSessionKey = (openId, pageToken) => {
  const text = String(openId || '');
  const token = String(pageToken || '').trim();
  if (!token) return text;
  if (!text) return '';
  if (text.includes(SESSION_KEY_SEPARATOR)) return text;
  return `${text}${SESSION_KEY_SEPARATOR}${token}`;
};

/**
 * 会话键化哪几个方法：它们的**第一个入参就是会话键**（openId / session id 在本服务里是同一个位置）。
 * ⚠️ `isExpired(session)` 不吃会话键、`store` / `idOf` 单独处理 ⇒ 不在这个名单里。
 */
const SESSION_KEYED_METHODS = Object.freeze([
  'get',
  'ensure',
  'revive',
  'submitKeyFor',
  'setLastRealm',
  'addLine',
  'clearSale',
  'saveSaleProgress',
  'completeSale',
  'completeReplenish',
  'completePurchaseReturn',
  'markSaleFailed',
  'markReplenishFailed',
  'markPurchaseReturnFailed',
  'clearInterruptedSale',
]);

/**
 * 把 `writeService.sessions` 包一层：**调用方给的是 openId，落地的是 openId + token**。
 * 只改"第一个参数"，其余原样透传；`store` 原样、`idOf` 也跟着映射。
 * `token` 为空 ⇒ 原样返回（旧页面：一个字节都不变 ✓）。
 */
const createSessionScopedSessions = (sessions, pageToken) => {
  if (!sessions || !pageToken) return sessions;
  const keyOf = (openId) => pageSessionKey(openId, pageToken);
  const scoped = { ...sessions };
  if (typeof sessions.idOf === 'function') scoped.idOf = (openId) => sessions.idOf(keyOf(openId));
  for (const name of SESSION_KEYED_METHODS) {
    if (typeof sessions[name] === 'function') {
      scoped[name] = (...args) => sessions[name](keyOf(args[0]), ...args.slice(1));
    }
  }
  return scoped;
};

/**
 * 写服务的请求级包装：把 token 作为 `sessionKey` **注入到写方法入参**。
 *
 * 覆盖 task-2 点名的五个写方法：
 *   `addSaleLine`（加货）· `submitSale`（提交）· `clearDraft`（清空）
 *   · `submitReplenish`（补货）· `submitPurchaseReturn`（退货）
 * 外加一个薄透传 `saveDraftLines`（资金页两步走那半：它第一个参数就是会话键）。
 *
 * 🔴 `token` 为空 ⇒ **原样返回 base**（旧页面 / 无 cookie ⇒ 今天那套 openId 共享路径，
 *    一字不改、也不会因为多传一个 `sessionKey: ''` 改变任何既有入参形状）。
 */
const PAGE_SESSION_INPUT_METHODS = Object.freeze([
  'addSaleLine', 'clearDraft', 'submitSale', 'submitReplenish', 'submitPurchaseReturn',
]);

const withPageSession = (writeService, pageToken) => {
  if (!writeService || !pageToken) return writeService;
  const scoped = { ...writeService };
  if (writeService.sessions) {
    scoped.sessions = createSessionScopedSessions(writeService.sessions, pageToken);
  }
  for (const name of PAGE_SESSION_INPUT_METHODS) {
    if (typeof writeService[name] !== 'function') continue;
    scoped[name] = (input = {}, ...options) => writeService[name]({
      ...(input || {}),
      sessionKey: pageSessionKey(input?.openId, pageToken),
    }, ...options);
  }
  if (typeof writeService.saveDraftLines === 'function') {
    scoped.saveDraftLines = (openId, patch) => writeService.saveDraftLines(
      pageSessionKey(openId, pageToken), patch,
    );
  }
  return scoped;
};

/**
 * ⭐⭐ **这一页的会话键**：只认**浏览器带回来的** token（`req.scanPageTokenFromCookie`）。
 *   · 有 = 这一页有自己的身份 ⇒ 用 `openId + token`；
 *   · 没有（旧页面 / 丢 cookie 的 WebView / 这一发刚发的 token）⇒ **就是 openId**（改前逐字同一个键）。
 *   为什么"刚发的 token 不算"：见 `createPageTokenMiddleware` 的 `req.scanPageTokenFromCookie` 注释。
 */
const pageSessionKeyOfRequest = (req, openId) => pageSessionKey(
  openId,
  req && req.scanPageTokenFromCookie === true ? req.scanPageToken : '',
);

/**
 * 过渡期探测（GET 没 cookie 时用）：**openId 那份旧会话还在吗？**
 *   · 在（哪怕已过期、但还攒着她"本单 N 双"）⇒ **这一发先不换身份**（否则本单会"消失" ✗）；
 *   · 不在 ⇒ 正常发新 token（新页面 / 新设备从这一页开始隔离）。
 * ⚠️ 读会话失败一律按"没有"处理（不能因为一次读失败把她卡在无 token 路上）。
 */
const createLegacySessionProbe = ({ getSessions, openIdOf }) => async (req) => {
  const sessions = typeof getSessions === 'function' ? getSessions() : null;
  if (!sessions || typeof sessions.get !== 'function') return false;
  const who = String((typeof openIdOf === 'function' ? openIdOf(req) : '') || '');
  if (!who) return false;
  const legacy = await sessions.get(who).catch(() => null);
  if (!legacy) return false;
  if (!legacy.expired) return true;
  // 过期但她手上可能还有"本单 N 双"（她挂了 8 小时那种）⇒ 仍按旧路径渲染/提交
  // （提交流程自己有 `revive` 续上草稿）；**不**在这里把她的本单弄丢。
  const sale = legacy.sale || {};
  return Boolean(
    (Array.isArray(sale.lines) && sale.lines.length)
    || sale.paymentStep || sale.master_record_id || sale.order_no || sale.submitPending,
  );
};

/**
 * 过渡期的另一格：**首访页面上的那把旧键**（页面是用 `openId` 的键渲染的）第一次带着
 * token 提交**补货 / 退货**时，token 会话还是**全新**的 ⇒ 它的轮次键（`…:1`）与她那把旧键对不上
 * ⇒ 既有写层会判"这一页已经提交过了"（页面 200 但后台失败 ✗）。
 * 修法**只在这一格、只对首次**：token 会话还不存在、而她带来的键正是**旧路径第 1 轮那把**
 * （`submitKeyFor(openId, null, flow)` 的确定性值）⇒ 把这一把键**采纳**进 token 会话
 * （只动本地会话的 `key` 字段 —— 与写层 `revive` 采纳 `submitKey` 同一个做法 ✓ 不碰业务表 ✓）。
 * ⚠️ 其它情况（会话已存在 / 键不是旧路径第 1 轮 / 没有 token）⇒ **一个字都不动**。
 */
const createFirstVisitKeyAdopter = ({ getSessions }) => async ({ chain, openId, sessionKey, submitKey }) => {
  const sessions = typeof getSessions === 'function' ? getSessions() : null;
  if (!sessionKey || !submitKey || !sessions || typeof sessions.get !== 'function') return;
  const flow = chain === 'replenish' ? 'replenish'
    : (chain === 'purchase_return' ? 'purchase_return' : '');
  if (!flow) return;
  const legacyKey = typeof sessions.submitKeyFor === 'function'
    ? sessions.submitKeyFor(openId, null, flow) : '';
  if (!legacyKey || String(submitKey) !== String(legacyKey)) return;
  if (await sessions.get(sessionKey).catch(() => null)) return;
  const created = await sessions.ensure(sessionKey).catch(() => null);
  if (!created) return;
  const blockName = flow === 'replenish' ? 'replenish' : 'purchaseReturn';
  await sessions.store.update(sessions.idOf(sessionKey), (session) => ({
    [blockName]: { ...((session || {})[blockName] || {}), key: String(submitKey) },
  })).catch(() => null);
};

module.exports = {
  PAGE_TOKEN,
  SESSION_KEY_SEPARATOR,
  TOKEN_PATTERN,
  newPageToken,
  parseCookieHeader,
  readPageToken,
  pageTokenCookie,
  createPageTokenMiddleware,
  pageSessionKey,
  pageSessionKeyOfRequest,
  createLegacySessionProbe,
  createFirstVisitKeyAdopter,
  createSessionScopedSessions,
  withPageSession,
};
