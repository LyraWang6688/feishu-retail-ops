/**
 * ⭐⭐ **「一单多货品」引擎**（本单草稿 + 批量提交）—— 设计见
 *   `docs/multi-item-order-design-2026-10-15.md`（§3 模块边界 · §4 草稿 · §5 状态机 · §7 幂等 · §8 校验）。
 *
 * **一个模块只干三件事**（§3）：
 *   ① **草稿读写**（`openDraft` / `addItem` / `setEntries` / `removeItem` / `readDraft`）
 *      —— 草稿**沿用既有会话存储**（`services/scanSessionService.js` 的同一个 `store` / `data/scan_sessions/`）
 *      ⇒ **不新建存储** ✓；⭐ **一单一份 `orderKey`**（替掉 `scanWriteService` 里那套 `replenishFingerprint`
 *      指纹 —— 提交成功后 `orderKey` 轮换 ⇒ **第 2 单不可能被第 1 单的"假成功"吸收** ✓）。
 *   ② **校验**（`validateDraft`，**纯函数**）—— 规则全部来自配置（§8 / §10）。
 *   ③ **批量落库 + 幂等 + 单号**（`planSubmission` / `submitDraft`）—— **只调既有写入件** ✓
 *      （注入的 `writers`：补货 = `purchaseWebhookService.publishPurchaseRequest`；
 *       退货 = `purchaseReturnService.submit`）。
 *
 * 🔴 **本模块不做的事**（保持"一个 service 只干一件事"）：
 *   · **不直连 `gateway.create/update`** ✗（源码哨兵钉着）—— 本模块**连 gateway 都不认识**；
 *   · **不解析 HTTP 表单**（那是 `routes/scanPage.js`）；**不渲染页面**（`views/scanPageRenderer.js`）；
 *   · **不认识飞书字段名**（映射只有 `config/v1BitableSchema.js` 一处）；
 *   · **不按链写 `if (补货) … else …`** ✗ —— 两条链的差异**全在 `config/multiItemOrder.js` 的 `chains` 里** ✓。
 *
 * ⭐ **本步（第 1 步）= 影子跑**：`config.enabled === false` ⇒ **一个字节都不写业务表** ✗，
 *   只把"这一单会提交什么"（批次 1 个 + 每行明细 + 每行的幂等键）**算出来记进日志** ✓。
 *   第二步（并存）才翻开关 ⇒ 同一份 plan 交给既有写入件。
 */

const { fillText } = require('../config/scanWrite');
const { MULTI_ITEM_ORDER } = require('../config/multiItemOrder');
const { logInfo, logWarn, logError } = require('../utils/logger');

/** 正整数（认不出 ⇒ `null`；**不把空串当 0** —— "没填 ≠ 填 0"，见 §8 #6）。 */
const positiveInteger = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : null;
};

/** 幂等键 / task id 里允许的字符（与既有那两条链**同一套**清洗 ✓）。 */
const sanitizeKey = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');

/** 货品身份（幂等键里必须含它 —— 否则两个货品同尺码会撞车 ✗ 见 §14 风险 6）。 */
const productKeyOf = (item) => String(
  (item && (item.product_record_id || item.productRecordId || item.number || item.item_no)) || '',
).trim();

const createMultiItemOrderService = (options = {}) => {
  const sessions = options.sessions;
  if (!sessions || typeof sessions.ensure !== 'function' || !sessions.store) {
    throw new Error('multiItemOrderService 需要 scanSessionService（要用它的会话与同一个 store）');
  }
  const config = options.config || MULTI_ITEM_ORDER;
  // **只调既有写入件** ✓：`{ purchase, purchaseReturn }`（本步影子跑时一次都不调）。
  const writers = options.writers || {};
  const now = options.now || (() => Date.now());
  // ⚠️ 日志**可注入**（用例要断言"影子跑留了哪一条"）；没注入就用真 logger ✓
  const logger = options.logger || { logInfo, logWarn, logError };
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  const error_ = typeof logger.logError === 'function' ? logger.logError : () => {};
  const store = sessions.store;
  const idOf = sessions.idOf;
  const texts = config.texts || {};

  const reject = (code, message, details = {}) => ({ ok: false, code, message, details });

  /** 认不出的链 ⇒ 报人话（**绝不猜成某一条链** ✗）。 */
  const chainOf = (chain) => config.chains[String(chain || '').trim()] || null;

  const sessionIdOf = (openId) => idOf(openId);

  /** 读会话（只读，不建）。 */
  const readSession = (openId) => store.get(sessionIdOf(openId));

  /** 写草稿（**同一个 store**；`store.update` 支持函数式 mutator ✓）。 */
  const writeDraft = (openId, orderKey, mutate) => store.update(sessionIdOf(openId), (session) => {
    const ordersField = config.session.ordersField;
    const orders = { ...(session[ordersField] || {}) };
    const next = mutate(orders[orderKey] || null, session);
    if (next === null) delete orders[orderKey]; else orders[orderKey] = next;
    return { [ordersField]: orders, updated_at: new Date(now()).toISOString() };
  });

  const emptyDraft = (chain, chainConfig, openId, orderKey) => ({
    chain,
    open_id: String(openId || ''),
    created_at: new Date(now()).toISOString(),
    updated_at: new Date(now()).toISOString(),
    // ⭐ 幂等键 = **本单的 `orderKey`**（本单唯一；提交成功后轮换 ✓ §7）
    submit_key: orderKey,
    order_key: orderKey,
    items: [],
    order_amount: '',
    batch_record_id: '',
    batch_no: '',
    detail_ids: [],
    status: config.session.draftStatus,
    // 只用于排查：这条链的差异全在配置里 ✓
    chain_prefix: chainConfig.orderKeyPrefix,
  });

  // ── ① 草稿读写 ───────────────────────────────────────────────────────────
  const openDraft = async ({ openId, chain, requestId = '' } = {}) => {
    const chainConfig = chainOf(chain);
    if (!chainConfig) return reject('chain_unknown', texts.chainUnknown);
    const session = await sessions.ensure(openId);
    const sessionId = sessionIdOf(openId);
    const seqField = 'orders_seq';
    const seqs = { ...(session[seqField] || {}) };
    const seq = positiveInteger(seqs[chainConfig.id]) || 1;
    const orderKey = `${chainConfig.orderKeyPrefix}:${sessionId}:${seq}`;
    const ordersField = config.session.ordersField;
    let draft = (session[ordersField] || {})[orderKey] || null;
    if (!draft) {
      draft = emptyDraft(chainConfig.id, chainConfig, openId, orderKey);
      await writeDraft(openId, orderKey, () => draft);
      info(config.events.draftOpened, {
        session_id: sessionId, open_id: String(openId || ''), chain: chainConfig.id,
        order_key: orderKey, request_id: requestId,
      });
    }
    return { ok: true, orderKey, draft };
  };

  const readDraft = async ({ openId, chain, orderKey } = {}) => {
    const chainConfig = chainOf(chain);
    if (!chainConfig) return reject('chain_unknown', texts.chainUnknown);
    const session = await readSession(openId);
    const draft = session ? (session[config.session.ordersField] || {})[String(orderKey || '')] : null;
    if (!draft) return reject('draft_missing', texts.emptyDraft);
    return { ok: true, orderKey: String(orderKey || ''), draft };
  };

  /** 同一个货品**只留一条**（重复添加 = 覆盖它的尺码行 ✓ 与"同货号同尺码不许重复"是两件事）。 */
  const addItem = async ({ openId, chain, orderKey, item = {}, requestId = '' } = {}) => {
    const loaded = await readDraft({ openId, chain, orderKey });
    if (!loaded.ok) return loaded;
    const productKey = productKeyOf(item);
    const next = {
      ...loaded.draft,
      updated_at: new Date(now()).toISOString(),
      items: [...(loaded.draft.items || [])],
    };
    const at = next.items.findIndex((entry) => productKeyOf(entry) === productKey);
    const normalized = {
      product_record_id: String(item.product_record_id || item.productRecordId || '').trim(),
      number: String(item.number || '').trim(),
      item_no: String(item.item_no || '').trim(),
      color: String(item.color || '').trim(),
      supplier_record_id: String(item.supplier_record_id || '').trim(),
      entries: (Array.isArray(item.entries) ? item.entries : []).map((entry) => ({
        size: String(entry?.size ?? '').trim(), quantity: entry?.quantity ?? '',
      })),
    };
    if (at >= 0) next.items[at] = { ...next.items[at], ...normalized }; else next.items.push(normalized);
    await writeDraft(openId, orderKey, () => next);
    info(config.events.draftOpened, {
      session_id: sessionIdOf(openId), open_id: String(openId || ''), chain: String(chain || ''),
      order_key: String(orderKey || ''), item_count: next.items.length, request_id: requestId,
    });
    return { ok: true, orderKey: String(orderKey || ''), draft: next };
  };

  const setEntries = async ({ openId, chain, orderKey, productRecordId, entries = [] } = {}) => {
    const loaded = await readDraft({ openId, chain, orderKey });
    if (!loaded.ok) return loaded;
    const next = {
      ...loaded.draft,
      updated_at: new Date(now()).toISOString(),
      items: (loaded.draft.items || []).map((entry) => (
        productKeyOf(entry) === String(productRecordId || '').trim()
          ? { ...entry, entries: entries.map((one) => ({ size: String(one?.size ?? '').trim(), quantity: one?.quantity ?? '' })) }
          : entry
      )),
    };
    await writeDraft(openId, orderKey, () => next);
    return { ok: true, orderKey: String(orderKey || ''), draft: next };
  };

  const removeItem = async ({ openId, chain, orderKey, productRecordId } = {}) => {
    const loaded = await readDraft({ openId, chain, orderKey });
    if (!loaded.ok) return loaded;
    const next = {
      ...loaded.draft,
      updated_at: new Date(now()).toISOString(),
      items: (loaded.draft.items || []).filter((entry) => productKeyOf(entry) !== String(productRecordId || '').trim()),
    };
    await writeDraft(openId, orderKey, () => next);
    return { ok: true, orderKey: String(orderKey || ''), draft: next };
  };

  // ── ② 校验（纯函数；规则全来自配置 ✓ §8）──────────────────────────────────
  /**
   * @param {object} input
   * @param {object} input.draft            草稿（§4.3）
   * @param {object} input.chainConfig      `config.chains[chain]`
   * @param {object} [input.limits]         `{ maxProducts, maxLines }`（不传 ⇒ 用本模块那份配置）
   * @param {(productKey:string, size:string) => (number|null)} [input.stockView]
   *        **退货**那条链的实时库存读数（`null` = **取不到** ⇒ 不按 0 拦 ✓，与 #611/#614 同一条口径）
   */
  const validateDraft = ({ draft, chainConfig, limits = {}, stockView = null } = {}) => {
    const maxProducts = positiveInteger(limits.maxProducts) || config.maxProducts;
    const maxLines = positiveInteger(limits.maxLines) || config.maxLines;
    const items = (draft && Array.isArray(draft.items)) ? draft.items : [];
    if (!chainConfig) return reject('chain_unknown', texts.chainUnknown);
    if (!items.length) return reject('empty_draft', texts.emptyDraft);

    // 单头金额（只有"必填"的那条链看它 ✓ —— 差异来自配置，不是 `if (补货)` ✗）
    const amount = String((draft && draft.order_amount) || '').trim();
    if (chainConfig.amountRequired === true && !amount) return reject('amount_required', texts.amountRequired);

    const seen = new Set();
    const normalizedItems = [];
    const shortfalls = [];
    let lineCount = 0;
    for (const item of items) {
      const productKey = productKeyOf(item);
      if (!productKey) return reject('product_missing', texts.productMissing);
      const entries = Array.isArray(item.entries) ? item.entries : [];
      const normalizedEntries = [];
      for (const entry of entries) {
        const size = positiveInteger(entry?.size);
        if (size === null) {
          return reject('size_unknown',
            fillText(texts.sizeUnknown, { product: item.item_no || productKey }), { product: productKey });
        }
        // 🔴 **同货号 + 同尺码不许重复行**（§8 #1 —— 新判据；两个货品同尺码是**允许**的 ✓）
        const lineKey = `${productKey}|${size}`;
        if (seen.has(lineKey)) {
          return reject('duplicate_line',
            fillText(texts.duplicateLine, { product: item.item_no || productKey, size: String(size) }),
            { product: productKey, size: String(size) });
        }
        seen.add(lineKey);
        const raw = String(entry?.quantity ?? '').trim();
        // 勾了不填 ⇒ 按配置的默认值算（**没填 ≠ 填 0** ✓）；填了就必须是 1..maxQuantity 的整数
        const quantity = raw ? positiveInteger(raw) : positiveInteger(chainConfig.defaultQuantity);
        if (quantity === null || quantity > chainConfig.maxQuantity) {
          return reject('quantity_invalid',
            fillText(texts.quantityInvalid, { size: String(size), max: String(chainConfig.maxQuantity) }),
            { product: productKey, size: String(size) });
        }
        let effective = quantity;
        if (stockView && chainConfig.exceedPolicy === 'cap+report') {
          const stock = typeof stockView === 'function' ? stockView(productKey, String(size)) : null;
          if (typeof stock === 'number' && Number.isFinite(stock) && quantity > stock) {
            // ⭐ **退能退的 + 差额如实回报**（她认的既有口径 `AC-R5` ✓ 绝不静默少退、更不退成负数 ✗）
            effective = Math.max(0, stock);
            shortfalls.push({
              product: productKey, size: String(size), declared: quantity, taken: effective, shortage: quantity - effective,
            });
          }
        }
        normalizedEntries.push({ size, quantity: effective, declared: quantity });
        lineCount += 1;
      }
      normalizedItems.push({ ...item, product_key: productKey, entries: normalizedEntries });
    }

    if (normalizedItems.length > maxProducts) {
      return reject('too_many_products',
        fillText(texts.tooManyProducts, { max: String(maxProducts), count: String(normalizedItems.length) }),
        { max: maxProducts, count: normalizedItems.length });
    }
    if (lineCount > maxLines) {
      return reject('too_many_lines',
        fillText(texts.tooManyLines, { max: String(maxLines), count: String(lineCount) }),
        { max: maxLines, count: lineCount });
    }
    // 超库存被压到 0 的行 = 这一行退不成（如实报；整单都由"0"组成时由调用方按 `AC-R5b` 拦）
    const takenLineCount = normalizedItems
      .reduce((sum, item) => sum + item.entries.filter((entry) => entry.quantity > 0).length, 0);
    return {
      ok: true,
      normalized: {
        items: normalizedItems, lineCount, productCount: normalizedItems.length, shortfalls, takenLineCount,
      },
    };
  };

  // ── ③ 批量落库 + 幂等 + 单号（**本步只算不写**）─────────────────────────────
  /**
   * 把草稿算成"这一次会提交什么"：**1 张单（批次）+ N×M 行明细** ✓（§6）。
   *
   * ⚠️ **N=1 与旧路径逐字等价**：单货品时，批次级那几列（货品 / 货号 / 供应商）就取那**唯一一件**的
   *   —— 与 `services/scanWriteService.js:1449`（补货）/`:1601`（退货）构造的 `draft` **同一个形状** ✓
   *   （N>1 时批次级那三列**留空**：一单多货品没有"一个货品"可言，逐行才带 ✓）。
   *
   * @param {object} input.behavior 调用方解析好的「采购行为」（`{ recordId, kind }`）——
   *   引擎**不认识飞书表** ✓（映射只有 `config/v1BitableSchema.js` 一处）
   */
  const planSubmission = ({ draft, chainConfig, submitKey, behavior = {} } = {}) => {
    const items = (draft && Array.isArray(draft.items)) ? draft.items : [];
    const taskId = `${chainConfig.taskIdPrefix}_${sanitizeKey(submitKey || draft?.submit_key || '')}`;
    const detailKeyTemplate = config.detailKeyTemplate;
    const details = [];
    const flatItems = [];
    for (const item of items) {
      const productKey = productKeyOf(item);
      for (const entry of (item.entries || [])) {
        const idempotencyKey = fillText(detailKeyTemplate, {
          taskId, productKey, size: String(entry.size),
        });
        // 「采购行为」两列**给不给由配置说** ✓（补货要给、退货不写 —— 差异在 chains[].payload.withBehavior，
        //   引擎里**不判断链** ✗ 与 §10 的"补货/退货只差配置"同一条口径）
        const withBehavior = chainConfig.payload?.withBehavior === true;
        const values = {
          product_record_id: item.product_record_id || productKey,
          product_number: item.number || '',
          item_no: item.item_no || '',
          color: item.color || '',
          supplier_record_id: item.supplier_record_id || '',
          size: entry.size,
          quantity: entry.quantity,
          ...(withBehavior && behavior.recordId ? { behavior_record_id: behavior.recordId } : {}),
          ...(withBehavior && behavior.kind ? { behavior_kind: behavior.kind } : {}),
        };
        details.push({ idempotency_key: idempotencyKey, values });
        flatItems.push(values);
      }
    }
    const first = items[0] || {};
    const single = items.length === 1;
    const payload = {
      // 补货那条链的老形状里有它（"这一次是一批明细"）✓；退货那条链没有 —— **由配置说** ✓
      ...(chainConfig.payload?.isBatch === true ? { is_batch: true } : {}),
      product_record_id: single ? (first.product_record_id || productKeyOf(first)) : '',
      product_number: single ? (first.number || '') : '',
      item_no: single ? (first.item_no || '') : '',
      color: single ? (first.color || '') : '',
      supplier_record_id: single ? (first.supplier_record_id || '') : '',
      behavior_record_id: behavior.recordId || '',
      operator_open_id: String((draft && draft.open_id) || ''),
      items: flatItems,
      ...(chainConfig.amountRequired === true ? { order_amount: String(draft?.order_amount || '').trim() } : {}),
    };
    return {
      ok: true,
      batchCount: 1,
      taskId,
      payload,
      details,
      summary: {
        chain: chainConfig.id,
        order_key: String(draft?.order_key || ''),
        batch_count: 1,
        product_count: items.length,
        detail_count: details.length,
        detail_keys: details.map((detail) => detail.idempotency_key),
      },
    };
  };

  /** 本进程内"同一单正在提交"的去重（并发只落一次 ✓ §7 / AC-MI6）。 */
  const inFlight = new Map();

  /**
   * 提交这一单（**本步 = 影子跑**：`config.enabled !== true` ⇒ **零写入** ✓）。
   * @returns {Promise<{ok:boolean, shadow?:boolean, reused?:boolean, code?:string, message?:string,
   *                    summary?:object, plan?:object}>}
   */
  const submitDraft = async ({
    openId, chain, orderKey, submitKey = '', stockView = null, behavior = {}, requestId = '',
  } = {}) => {
    const chainConfig = chainOf(chain);
    if (!chainConfig) return reject('chain_unknown', texts.chainUnknown);
    const key = String(orderKey || '').trim();
    if (inFlight.has(key)) return inFlight.get(key); // 同一单并发 ⇒ 复用第一次那一跑 ✓
    const run = (async () => {
      const loaded = await readDraft({ openId, chain, orderKey: key });
      if (!loaded.ok) return loaded;
      const draft = loaded.draft;
      // 已经提交过（同一把 `orderKey`）⇒ 直接把结果还给她，不再写一次 ✓（幂等，§7）
      if (draft.status === config.session.submittedStatus) {
        info(config.events.reused, {
          session_id: sessionIdOf(openId), chain: chainConfig.id, order_key: key, request_id: requestId,
        });
        return {
          ok: true, reused: true, shadow: draft.shadow === true,
          summary: {
            chain: chainConfig.id, order_key: key, batch_count: 1,
            detail_count: (draft.detail_ids || []).length,
          },
        };
      }
      const checked = validateDraft({ draft, chainConfig, stockView });
      if (!checked.ok) {
        info(config.events.rejected, {
          session_id: sessionIdOf(openId), chain: chainConfig.id, order_key: key,
          code: checked.code, request_id: requestId,
        });
        return checked;
      }
      const effectiveKey = String(submitKey || '').trim() || key;
      const plan = planSubmission({ draft, chainConfig, submitKey: effectiveKey, behavior });
      const shadow = config.enabled !== true;
      if (shadow) {
        // ⭐⭐ **影子跑**：只把"这一单会提交什么"记进日志 —— **一个字节都不写业务表** ✗（§12 第 ① 步）
        info(config.events.shadowSubmit, {
          session_id: sessionIdOf(openId), chain: chainConfig.id, order_key: key,
          task_id: plan.taskId, ...plan.summary, request_id: requestId,
          note: texts.shadowLogged,
        });
      } else {
        // 第二步（并存）才走到这儿：**只调既有写入件** ✓（本模块连 gateway 都不认识 ✗）
        const writer = writers[chainConfig.writer];
        if (typeof writer !== 'function') {
          return reject('writer_missing', texts.chainUnknown);
        }
        try {
          await writer(plan.taskId, plan.payload);
        } catch (error) {
          error_('multi_item_order.write_failed', {
            session_id: sessionIdOf(openId), chain: chainConfig.id, order_key: key,
            task_id: plan.taskId, error: String(error?.message || error), request_id: requestId,
          });
          await writeDraft(openId, key, (current) => ({
            ...(current || draft), status: config.session.failedStatus, last_error: String(error?.message || error),
          })).catch(() => undefined);
          return reject('write_failed', String(error?.message || error));
        }
      }
      // 提交成功（本步 = "影子提交成功"）：落状态 + ⭐ **`orderKey` 轮换** ⇒ 第 2 单不会被这一单吸收 ✓
      const rotated = await writeDraft(openId, key, (current) => ({
        ...(current || draft),
        status: config.session.submittedStatus,
        shadow,
        detail_ids: plan.details.map((detail) => detail.idempotency_key),
        updated_at: new Date(now()).toISOString(),
      }));
      if (!shadow) {
        info(config.events.submitted, {
          session_id: sessionIdOf(openId), chain: chainConfig.id, order_key: key,
          task_id: plan.taskId, ...plan.summary, request_id: requestId,
        });
      }
      // 轮换：下一单从 `seq + 1` 开始（与"提交后换一把新键"同义 ✓ §4.2）
      await store.update(sessionIdOf(openId), (session) => {
        const seqs = { ...(session.orders_seq || {}) };
        const seqField = 'orders_seq';
        const current = positiveInteger(seqs[chainConfig.id]) || 1;
        seqs[chainConfig.id] = current + 1;
        return { [seqField]: seqs, updated_at: new Date(now()).toISOString() };
      }).catch((error) => {
        warn('multi_item_order.rotate_failed', { error: String(error?.message || error), order_key: key });
        return null;
      });
      void rotated;
      return { ok: true, shadow, reused: false, plan, summary: plan.summary };
    })();
    inFlight.set(key, run);
    try {
      return await run;
    } finally {
      inFlight.delete(key);
    }
  };

  return {
    openDraft,
    addItem,
    setEntries,
    removeItem,
    readDraft,
    validateDraft,
    planSubmission,
    submitDraft,
    // 只读暴露（排查 / 用例）
    productKeyOf,
    sanitizeKey,
  };
};

module.exports = { createMultiItemOrderService };
