'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { SCAN_DRAFT_BOX } = require('../config/scanDraftBox');
const { SCAN_PAGE } = require('../config/scanPage');
const { SCAN_WRITE } = require('../config/scanWrite');
const { SESSION_KEY_SEPARATOR, parsePageSessionKey, isPageSessionKeyOf } = require('../utils/pageSessionKey');
const { logInfo } = require('../utils/logger');

/**
 * ⭐⭐ **工作台「草稿单」= 销售扫码页留下的本地中间态**（只读 + 清空，**零业务表**）。
 *
 * 数据从哪来：**一份都不新造** —— 就是 `services/scanSessionService.js` 写在
 * `data/scan_sessions/` 里的那些会话文件（扫码页「本单已加 N 双」的那份草稿）。
 *   · 按人隔离：会话记录里的 `open_id` 字段 = **会话键** = `<openId>`（旧页面）或
 *     `<openId>|page|<页面 token>`（2026-10-18 起）⇒ 只认**本页这个人**的（不串单 ✓）；
 *   · 已提交成功的不出现：`completeSale` 会把 `sale.lines` 清空 ⇒ 这里"没有货行 ⇒ 不是草稿"天然过滤 ✓
 *     （判据钉在 `test/scanDraftBoxService.test.js` 的 AC-DB2 —— 以后谁改 `completeSale` 都会红）；
 *   · 清空只清**本地那份草稿**（复用既有的 `sessions.clearSale`），**不写 Base、不写任何表** ✓。
 *
 * 三种状态（都由**既有字段**推出来，不新造业务状态）：
 *   · `draft`     还没提交（有货行、没有写库进度）⇒ 可继续编辑 / 可清空；
 *   · `in_flight` 上次写库**没写完**（有主表 record_id / 单号 / 待提交资金入参）
 *                 ⇒ **既不给继续编辑、也不给清空**（清掉会丢"主表已建"的进度 ⇒ 重复建单 ✗）；
 *   · `expired`   会话过期（`expires_at` 过了）⇒ **只给清空**（过期后再"接着录"会因 staleDraftMs 静默丢行 ⇒ 误导 ✗）。
 *
 * 🔴 安全：本文件**不返回** open_id / 会话键 / 页面 token / master_record_id ——
 *   `draft_id` 用会话 id（它本身就是 openId 的 sha256 前 16 位）✓ 日志同样只记 draft_id ✓。
 */

const asTime = (value) => {
  const time = Date.parse(String(value || ''));
  return Number.isNaN(time) ? 0 : time;
};

/** 上海时间文本（+8；报告/页面都按她的时区看 ✓）—— `2026-10-29 21:30`。 */
const shanghaiText = (value) => {
  const time = asTime(value);
  if (!time) return '';
  const date = new Date(time + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

const linesOf = (session) => (Array.isArray(session?.sale?.lines) ? session.sale.lines : []);

/** 钱按"分"累加再除回（避免 0.1+0.2 那种浮点尾巴；金额非法 ⇒ 当 0，**不编**）。 */
const amountOf = (line) => {
  const value = Number(String(line?.amount ?? '').trim());
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
};

/** 会话里有没有"写库进度"（有 ⇒ 绝不自动丢弃、也不许草稿箱清空）。 */
const hasWriteProgress = (session) => {
  const sale = session?.sale || {};
  const submitPending = sale.submitPending && typeof sale.submitPending === 'object'
    ? Object.keys(sale.submitPending).length > 0
    : false;
  return Boolean(String(sale.master_record_id || '').trim())
    || Boolean(String(sale.order_no || '').trim())
    || (Array.isArray(sale.detail_ids) && sale.detail_ids.length > 0)
    || (Array.isArray(sale.payment_ids) && sale.payment_ids.length > 0)
    || submitPending
    || sale.children_started === true;
};

const createError = (code, statusCode, message) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const createScanDraftBoxService = (options = {}) => {
  const config = options.config || SCAN_DRAFT_BOX;
  const sessionConfig = options.sessionConfig || SCAN_WRITE.session;
  const routeConfig = options.scanPageRoute || SCAN_PAGE.route;
  const now = options.now || (() => Date.now());
  const sessions = options.sessions;
  if (!sessions || typeof sessions.get !== 'function' || !sessions.store) {
    throw new Error('scanDraftBoxService requires the scan session service (`sessions`)');
  }

  const texts = config.texts || {};
  const statuses = config.status || {};
  const codes = config.codes || {};
  const idField = sessionConfig.idField || 'session_id';

  /**
   * 读会话目录的**容错版**：一份坏 JSON 不许把整张草稿箱打崩 ✗
   * （`JsonTaskStore.list()` 遇到坏文件会整批抛 ⇒ 这一层自己逐份读、坏的只计数 ✓）。
   */
  const readSessionsTolerant = async () => {
    const dir = String(sessions.store.dir || '');
    if (!dir) return { sessions: [], corrupt: 0 };
    let files = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch (error) {
      if (error.code === 'ENOENT') return { sessions: [], corrupt: 0 };
      throw error;
    }
    const list = [];
    let corrupt = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fs.promises.readFile(path.join(dir, file), 'utf8'));
        if (parsed && typeof parsed === 'object') list.push(parsed);
        else corrupt += 1;
      } catch {
        corrupt += 1;
      }
    }
    return { sessions: list, corrupt };
  };

  /** 这个人的那一份（按会话键：本人 / 本人的某一页 ✓）。 */
  const owns = (session, openId) => isPageSessionKeyOf(session?.open_id, openId);

  const draftIdOf = (session) => String(session?.[idField] || session?.session_id || '');

  /** 状态：三种由既有字段推出（顺序有意义：写中优先于过期 —— 那种单更"烫手"）。 */
  const statusOf = (session) => {
    const sale = session?.sale || {};
    const submitted = String(sale.status || '') === String(sessionConfig.statuses?.submitted || 'submitted');
    if (hasWriteProgress(session) || submitted) return statuses.inFlight;
    const expiresAt = asTime(session.expires_at);
    if (expiresAt > 0 && now() > expiresAt) return statuses.expired;
    return statuses.draft;
  };

  /** 一条货行 → 页面要显示的那几样（配品行没有尺码，明确写"无尺码"而不是编一个）。 */
  const itemOf = (line) => {
    const kind = String(line?.kind || 'shoe');
    return {
      kind,
      kind_label: (config.lineKinds || {})[kind] || '',
      item_no: String(line?.item_no || ''),
      color: String(line?.color || ''),
      // ⚠️ 尺码可能是数字 / 字符串；空就是空（页面出"尺码待补"，不编 0）
      size: line?.size == null ? '' : String(line.size),
      amount: Number((amountOf(line) / 100).toFixed(2)),
    };
  };

  const summaryOf = (session) => {
    const status = statusOf(session) || {};
    const lines = linesOf(session);
    const sale = session.sale || {};
    const items = lines.slice(0, Math.max(1, Number(config.box?.maxItemLines) || 20)).map(itemOf);
    const totalCents = lines.reduce((sum, line) => sum + amountOf(line), 0);
    const resumeLine = lines.find((line) => String(line?.product_record_id || '').trim());
    return {
      draft_id: draftIdOf(session),
      status_code: String(status.code || ''),
      status_label: String(status.label || ''),
      status_tone: String(status.tone || 'info'),
      resumable: status.resumable === true && Boolean(resumeLine),
      clearable: status.clearable === true,
      order_no: String(sale.order_no || ''),
      line_count: lines.length,
      more_count: Math.max(0, lines.length - items.length),
      total_amount: Number((totalCents / 100).toFixed(2)),
      items,
      updated_at: String(session.updated_at || session.created_at || ''),
      updated_at_text: shanghaiText(session.updated_at || session.created_at),
    };
  };

  /** 读"这个人的草稿箱"（按最后更新倒序；超上限只报 total，**数据一条不删**）。 */
  const list = async ({ openId = '' } = {}) => {
    if (!config.box?.enabled) return { enabled: false, drafts: [], total: 0, corrupt_count: 0 };
    const who = String(openId || '');
    if (!who) return { enabled: true, drafts: [], total: 0, corrupt_count: 0 };
    const { sessions: all, corrupt } = await readSessionsTolerant();
    const mine = all
      .filter((session) => owns(session, who) && linesOf(session).length > 0)
      .sort((a, b) => asTime(b.updated_at) - asTime(a.updated_at));
    const limit = Math.max(1, Number(config.box?.maxDrafts) || 20);
    return {
      enabled: true,
      drafts: mine.slice(0, limit).map(summaryOf),
      total: mine.length,
      corrupt_count: corrupt,
    };
  };

  /** 取"我这一份"（**别人的 / 不存在 ⇒ 同一个"没找到"** —— 不泄露别人有没有草稿 ✓）。 */
  const mineOf = async (openId, draftId) => {
    const id = String(draftId || '').trim();
    if (!id) throw createError(codes.notFound || 'draft_not_found', 404, texts.notFound || '没找到这份草稿');
    const session = await sessions.store.get(id).catch(() => null);
    if (!session || !owns(session, openId) || !linesOf(session).length) {
      throw createError(codes.notFound || 'draft_not_found', 404, texts.notFound || '没找到这份草稿');
    }
    return session;
  };

  /**
   * 清空**一份**草稿（只动本地 `data/scan_sessions`，**零业务表**）。
   * 🔴 写中的草稿**拒绝清空**（401/400 由路由给状态码）：清掉会丢"主表已建"的进度 ⇒ 重复建单 ✗。
   */
  const clear = async ({ openId = '', draftId = '', requestId = '' } = {}) => {
    if (!config.box?.enabled) throw createError(codes.disabled || 'draft_box_disabled', 404, texts.failed || '');
    const session = await mineOf(openId, draftId);
    const status = statusOf(session);
    if (status?.clearable !== true) {
      throw createError(status?.code === 'in_flight' ? (codes.inFlight || 'draft_in_flight') : (codes.notFound || 'draft_not_found'),
        status?.code === 'in_flight' ? 400 : 404,
        status?.code === 'in_flight' ? (texts.inFlightHint || '') : (texts.notFound || ''));
    }
    const lineCount = linesOf(session).length;
    // ⭐ 复用既有的"清空本单"（唯一真源）：它只动 sale 块，completed[]（幂等回查）+ 补货/退货那两块**都不碰** ✓
    await sessions.clearSale(String(session.open_id || ''));
    logInfo('scan.sale.draft_cleared', {
      request_id: requestId, draft_id: draftIdOf(session), source: 'workbench_draft_box', line_count: lineCount,
    });
    return { draft_id: draftIdOf(session), cleared: true, line_count: lineCount };
  };

  /**
   * "继续编辑"要回到**同一份**草稿：把这一页的页面 token 交回给路由（它去写 cookie + 302），
   * 目标 = `/r/<首行货品的记录 ID>?from=<销售领域>`（扫码页那一页会渲染出同一份"本单 N 双"）。
   * ⚠️ token **不进 URL**、也不返回给前端展示 —— 只在这一层交给路由去 Set-Cookie ✓。
   */
  const resumeTarget = async ({ openId = '', draftId = '' } = {}) => {
    if (!config.box?.enabled) throw createError(codes.disabled || 'draft_box_disabled', 404, texts.failed || '');
    const session = await mineOf(openId, draftId);
    const status = statusOf(session);
    if (status?.resumable !== true) {
      throw createError(status?.code === 'expired' ? (codes.expiredNotResumable || 'draft_expired') : (codes.inFlight || 'draft_in_flight'),
        status?.code === 'expired' ? 400 : 400,
        status?.code === 'expired' ? (texts.expiredHint || '') : (texts.inFlightHint || ''));
    }
    const lines = linesOf(session);
    const line = lines.find((item) => String(item?.product_record_id || '').trim());
    if (!line) throw createError(codes.noResumeTarget || 'draft_without_product', 400, texts.noResumeTarget || '');
    const basePath = String(routeConfig.recordBasePath || '/r');
    const recordId = String(line.product_record_id).trim();
    const realm = String(config.box?.resumeRealm || 'sales');
    const pageToken = parsePageSessionKey(session.open_id).token;
    return {
      draft_id: draftIdOf(session),
      page_token: pageToken,
      target_path: `${basePath}/${encodeURIComponent(recordId)}?from=${encodeURIComponent(realm)}`,
    };
  };

  return { list, clear, resumeTarget, statusOf, summaryOf };
};

module.exports = {
  createScanDraftBoxService,
  hasWriteProgress,
  shanghaiText,
  SESSION_KEY_SEPARATOR,
};
