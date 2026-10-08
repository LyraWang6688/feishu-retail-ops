/**
 * 扫码入口**自己的**会话（草稿）记录 —— 独立目录、独立状态、独立幂等键。
 *
 * 🔴 为什么必须有它（业务负责人 2026-10-08 的口径）：
 *   「在扫码页上**连续扫码累积多双** → 一张销售单（一单多明细，每行一双）；
 *    **结束方式 = 页面上的【提交】按钮**」——她是**一部手机连着扫**的：
 *   扫 A 打开一页、扫 B 又打开一页，每一页都是**独立的一次 HTTP 请求**。
 *   ⇒ "本单已经加了哪几双"必须有一个**跨页面**的落点，否则"累积"根本不存在。
 *
 * 🔴 入口隔离（`docs/entry-isolation-2026-10-08.md`）：
 *   · 会话/草稿状态**绝不共享**：本文件写的是 `data/scan_sessions/`，
 *     **一个字都不碰** `data/lark_mvp_tasks/`（群聊那条链路的任务记录）——
 *     两边的状态机、幂等键、失败与重试各自独立，一个入口出问题不影响另一个；
 *   · 本文件**只写本地 JSON**（复用仓库既有的 `infrastructure/jsonTaskStore`），
 *     **不写任何业务表**（销售 / 采购 / 库存都不在这里）。
 *
 * 幂等键的形状（配置先行，前缀都在 `config/scanWrite.js`）：
 *   `<前缀>:<会话 id>:<轮次>` —— 例如 `scan_sale:scan_session_ab12:1`。
 *   同一轮里连点两次 = **同一把键** ⇒ 只写一次；提交成功后轮次 +1，
 *   下一次提交是**新的一单**（不是"重复"）。这就是"连点两次只写一次"的判据来源。
 */
const crypto = require('node:crypto');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { SCAN_WRITE } = require('../config/scanWrite');
const { logInfo } = require('../utils/logger');

const asTime = (value) => {
  const time = Date.parse(String(value || ''));
  return Number.isNaN(time) ? 0 : time;
};

const createScanSessionService = (options = {}) => {
  const config = options.config || SCAN_WRITE;
  const now = options.now || (() => Date.now());
  const sessionConfig = config.session;
  // 会话 id：前缀 + 录单人 open_id 的哈希。
  // ⚠️ 哈希有两个作用：① 只落本地、不把 open_id 直接写进文件名；
  //    ② 同一个人的会话**跨请求稳定**（同一把 key 的幂等才有意义）。
  // ⚠️ 前缀必须是 `[A-Za-z0-9_-]`（jsonTaskStore 的文件名白名单），否则当场抛。
  const idOf = (openId) => `${sessionConfig.idPrefix}_${crypto
    .createHash('sha256').update(String(openId || '')).digest('hex').slice(0, 16)}`;
  const store = options.store || new JsonTaskStore({
    dir: options.dir || sessionConfig.dir,
    idField: sessionConfig.idField,
  });

  const keyFor = (prefix, sessionId, sequence) => `${prefix}:${sessionId}:${sequence}`;

  const isExpired = (session) => {
    if (!session) return true;
    const expiresAt = asTime(session.expires_at);
    // 老记录没有 expires_at（理论上不会有）：按"没过期"处理，不静默丢她的本单。
    return expiresAt > 0 && now() > expiresAt;
  };

  /** 新建一份会话（全新的一轮：销售一把键、补货一把键，都从第 1 轮开始）。 */
  const freshSession = (openId) => {
    const sessionId = idOf(openId);
    return {
      [sessionConfig.idField]: sessionId,
      session_id: sessionId,
      open_id: String(openId || ''),
      status: sessionConfig.statuses.draft,
      expires_at: new Date(now() + sessionConfig.ttlMs).toISOString(),
      sale: {
        key: keyFor(sessionConfig.saleKeyPrefix, sessionId, 1),
        seq: 1,
        status: sessionConfig.statuses.draft,
        lines: [],
        master_record_id: '',
        order_no: '',
        detail_ids: [],
        payment_ids: [],
        last_error: '',
        // 已经提交过的那些单（按幂等键回查）：连点两次时**从这一份里把结果还给她**，
        // 而不是再写一次（也不会因为"轮次已经 +1"就把她当成过期页面）。
        completed: [],
      },
      replenish: {
        key: keyFor(sessionConfig.replenishKeyPrefix, sessionId, 1),
        seq: 1,
        status: sessionConfig.statuses.draft,
        last_error: '',
        completed: [],
      },
    };
  };

  /** 读原始记录（不做 ensure、不轮换任何键）——写入口的幂等判据必须基于**这一份**。 */
  const get = async (openId) => {
    const session = await store.get(idOf(openId));
    if (!session) return null;
    return { ...session, expired: isExpired(session) };
  };

  /**
   * 拿到"当前可以用的那一份"（没有 / 过期了就新建一份）。
   * ⚠️ 新建的键是**确定性**的（`<前缀>:<会话 id>:1`）⇒ 并发的两次 ensure 结果一致，
   *    不会因为"谁先谁后"把她的页面变成一张过期的表。
   */
  const ensure = async (openId) => {
    const current = await store.get(idOf(openId));
    if (current && !isExpired(current)) return { ...current, expired: false };
    if (current) {
      logInfo(config.events.sessionExpired, {
        session_id: current[sessionConfig.idField],
        open_id: String(openId || ''),
        last_updated_at: current.updated_at || '',
      });
    }
    const created = await store.create(freshSession(openId));
    logInfo(config.events.sessionStarted, {
      session_id: created[sessionConfig.idField],
      open_id: String(openId || ''),
    });
    return { ...created, expired: false };
  };

  const touch = (patch) => ({ ...patch, expires_at: new Date(now() + sessionConfig.ttlMs).toISOString() });

  /** 把当前这一双加进"本单"（**只动本地会话**，业务表一个字都不写）。 */
  const addLine = async (openId, line) => {
    const session = await ensure(openId);
    const sale = session.sale || {};
    // 上一单已经提交过 ⇒ 这一双属于**新的一单**：把销售那一半复位（键已经在提交时轮换过）。
    const lines = sale.status === sessionConfig.statuses.submitted ? [] : [...(sale.lines || [])];
    if (lines.length >= sessionConfig.maxLines) {
      return { ok: false, code: 'too_many_lines', limit: sessionConfig.maxLines, session };
    }
    lines.push(line);
    const next = await store.update(session[sessionConfig.idField], touch({
      sale: {
        ...sale,
        status: sessionConfig.statuses.draft,
        lines,
        master_record_id: '',
        order_no: '',
        detail_ids: [],
        payment_ids: [],
        last_error: '',
      },
      status: sessionConfig.statuses.draft,
    }));
    return { ok: true, session: next, line, count: lines.length };
  };

  /** 清空本单（她加错了一双时的退路；**只动本地会话**）。 */
  const clearSale = async (openId) => {
    const session = await ensure(openId);
    const sale = session.sale || {};
    const next = await store.update(session[sessionConfig.idField], touch({
      sale: {
        ...sale,
        status: sessionConfig.statuses.draft,
        lines: [],
        master_record_id: '',
        order_no: '',
        detail_ids: [],
        payment_ids: [],
        last_error: '',
      },
    }));
    logInfo(config.events.draftCleared, { session_id: session[sessionConfig.idField] });
    return next;
  };

  /**
   * 记一次部分进度：**主表 record_id 一建出来就落盘**。
   * 为什么重要：明细 / 收款写了一半就失败时，重试必须接着**同一张**主表写，
   * 而不是再建一张（那就是两个业务事实）。与群聊链路 `AfterSalesService.ensureMaster`
   * 是同一个形状（先落盘再重试），只是落点是我们自己的会话文件。
   */
  const saveSaleProgress = async (openId, patch) => {
    const session = await ensure(openId);
    const next = await store.update(session[sessionConfig.idField], touch({
      sale: { ...(session.sale || {}), ...patch },
    }));
    return next;
  };

  /**
   * 单提交成功：轮换**销售那一条链的**幂等键 + 把结果留档（连点两次/重放时还给她）。
   * ⚠️ 只轮换销售自己的键 —— 补货那条链的键**一个字都不动**：
   *    她可能一边在攒一张销售单、一边报一次补货，两条链的键互不影响。
   */
  const completeSale = async (openId, { key, result }) => {
    const session = await ensure(openId);
    const sale = session.sale || {};
    const completed = [...(sale.completed || []), { key, ...result }].slice(-5);
    const next = await store.update(session[sessionConfig.idField], touch({
      sale: {
        ...sale,
        key: keyFor(
          sessionConfig.saleKeyPrefix, session[sessionConfig.idField], (sale.seq || 1) + 1,
        ),
        seq: (sale.seq || 1) + 1,
        status: sessionConfig.statuses.submitted,
        lines: [],
        master_record_id: '',
        order_no: '',
        detail_ids: [],
        payment_ids: [],
        last_error: '',
        completed,
      },
    }));
    return next;
  };

  /** 补货提交成功：同样**只轮换补货那一把键** + 留档结果。 */
  const completeReplenish = async (openId, { key, result }) => {
    const session = await ensure(openId);
    const replenish = session.replenish || {};
    const completed = [...(replenish.completed || []), { key, ...result }].slice(-5);
    const next = await store.update(session[sessionConfig.idField], touch({
      replenish: {
        ...replenish,
        key: keyFor(
          sessionConfig.replenishKeyPrefix, session[sessionConfig.idField], (replenish.seq || 1) + 1,
        ),
        seq: (replenish.seq || 1) + 1,
        status: sessionConfig.statuses.submitted,
        last_error: '',
        completed,
      },
    }));
    return next;
  };

  const markSaleFailed = async (openId, message) => {
    const session = await ensure(openId);
    return store.update(session[sessionConfig.idField], touch({
      sale: { ...(session.sale || {}), last_error: String(message || '') },
    }));
  };

  const markReplenishFailed = async (openId, message) => {
    const session = await ensure(openId);
    return store.update(session[sessionConfig.idField], touch({
      replenish: { ...(session.replenish || {}), last_error: String(message || '') },
    }));
  };

  /**
   * 页面表单里那一把幂等键（**纯函数，不读不写**）。
   * · 已经有会话 → 用会话里当前这一轮的键；
   * · 还没有会话（她只是扫开看了一眼、什么都还没点）→ 用**第 1 轮**的键
   *   （与 `ensure()` 建出来的那一把**逐字一致** ⇒ "先看后点"不会对不上）。
   * ⚠️ 渲染页面时**绝不**因为这一下就建会话文件：会话在第一次「加入本单」时才落盘。
   */
  const submitKeyFor = (openId, session, flow) => {
    const useReplenish = flow === 'replenish';
    const existing = useReplenish ? session?.replenish?.key : session?.sale?.key;
    if (existing) return existing;
    return keyFor(
      useReplenish ? sessionConfig.replenishKeyPrefix : sessionConfig.saleKeyPrefix,
      idOf(openId),
      1,
    );
  };

  return {
    idOf,
    get,
    ensure,
    isExpired,
    submitKeyFor,
    addLine,
    clearSale,
    saveSaleProgress,
    completeSale,
    completeReplenish,
    markSaleFailed,
    markReplenishFailed,
    store,
  };
};

module.exports = { createScanSessionService };
