/**
 * ⭐⭐ 2026-10-11（方案A，业务负责人选定）：「**扫码验收**」。
 *
 *  工作台 → 采购 → 验收到货 → 选【未到货】的报货号 → 点【验收】⇒ 本服务 `start()` 开一次
 *  **验收会话**（把这一批的采购申请明细缓存进会话）；
 *  之后每扫一个码（标签二维码就是 `/s/{编号}`）⇒ `addScan()` 把这一双记进会话
 *  （**不在本批不记、重复扫只记一次**）；
 *  最后【完成验收】⇒ `finish()` 把**已扫合计**交给**既有**到货核对链路
 *  （`PurchaseArrivalConversationService.confirmBatchArrival` → `buildPlan` → `confirmLocked`
 *   → `PurchaseWebhookService.confirmArrival` → 逐条 `InventoryService.applyPurchase`）——
 *  **本文件一次业务表写入都没有**，也不自己拼入库草稿（有用例钉住）。
 *
 * 🔴 三条纪律：
 *   ① **会话独立**：落在自己的目录（`config.acceptance.sessionDir`，与 `data/scan_sessions`
 *      分开）⇒ 与销售本单 / 补货 / 退货三条链**互不覆盖**；
 *   ② **不写差异说明**（她的口径：「我们已经通过扫码解决了具体到货情况，所以就不用到货说明了」）
 *      —— 本地草稿里那句"到货说明"由**扫码事实**拼出来（不是替她编），她只填「实际金额」；
 *   ③ **没扫到的行 = 实际 0 ⇒ 不入库**（既有实现自动摘掉）——"少发的"自然就是差异。
 *
 * ⚠️ 依赖（`purchaseQuery` / `arrivalConversation`）可以传**工厂函数**：路由在 `GET` 那一步
 *    只需要读会话（**零飞书调用**），拿到重依赖的那一刻才构造（扫码页"一次扫码 0 次飞书调用"
 *    那条硬要求不能被这个功能破坏）。
 */
const crypto = require('node:crypto');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { SCAN_WRITE, fillText } = require('../config/scanWrite');
const { logInfo, logWarn } = require('../utils/logger');

/** 传进来的可以是对象，也可以是工厂（路由用工厂把重依赖推迟到真正要用的那一刻）。 */
const resolve = (value) => (typeof value === 'function' ? value() : value);

const positiveInteger = (value) => {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
};

const createScanArrivalService = (options = {}) => {
  const config = options.config || SCAN_WRITE.acceptance;
  const texts = options.texts || SCAN_WRITE.texts;
  const events = options.events || SCAN_WRITE.events;
  const now = options.now || (() => Date.now());
  const store = options.store || new JsonTaskStore({ dir: config.sessionDir, idField: 'session_id' });

  // 会话 id：前缀 + 录单人 open_id 的哈希（只落本地；同一个人的会话跨请求稳定）。
  const idOf = (openId) => `${config.sessionIdPrefix}_${crypto
    .createHash('sha256').update(String(openId || '')).digest('hex').slice(0, 16)}`;
  const expiresAt = () => new Date(now() + config.ttlMs).toISOString();
  const touch = (patch) => ({ ...patch, expires_at: expiresAt() });
  const isExpired = (session) => {
    const at = Date.parse(String(session?.expires_at || ''));
    return Number.isFinite(at) && at > 0 && now() > at;
  };

  /** 读当前这一份验收会话（**只读**：没有 / 过期都返回 null，绝不建文件）。 */
  const get = async (openId) => {
    const session = await store.get(idOf(openId));
    if (!session || isExpired(session)) return null;
    return session;
  };

  /**
   * 两个重依赖的**延迟取用器**（路由只给 gateway；构造推迟到 `start` / `finish` 那一刻）：
   *   · `GET /s/{编号}` 那一步只调 `get()` ⇒ **不构造它们**、**零飞书调用**
   *     （扫码页"一次扫码 0 次飞书调用"那条硬要求不能被这个功能破坏）；
   *   · 真要开批次 / 入库时才构造——与工作台那条路**同一套接线**（同一个任务存储）。
   */
  const purchaseQueryOf = () => {
    const provided = resolve(options.purchaseQuery);
    if (provided) return provided;
    if (!options.gateway) return null;
    // eslint-disable-next-line global-require
    const { createPurchaseQueryService } = require('./purchaseQueryService');
    return createPurchaseQueryService(options.gateway);
  };
  const arrivalConversationOf = () => {
    const provided = resolve(options.arrivalConversation);
    if (provided) return provided;
    if (!options.gateway) return null;
    // eslint-disable-next-line global-require
    const { PurchaseArrivalConversationService } = require('./purchaseArrivalConversationService');
    // eslint-disable-next-line global-require
    const { PurchaseWebhookService } = require('./purchaseWebhookService');
    const webhooks = new PurchaseWebhookService({ gateway: options.gateway });
    return new PurchaseArrivalConversationService({
      gateway: options.gateway,
      // ⚠️ 与工作台那条路**共用同一个任务存储**（`confirmArrival` 要读的草稿就在那里）。
      store: webhooks.store,
      sizeReferences: webhooks.getSizeReferences,
      confirmArrival: (taskId, task, operatorOpenId) => webhooks.confirmArrival(taskId, task, operatorOpenId),
      markBatchArrived: (batchNo, arrivalOptions) => webhooks.orderBatches.markArrived(batchNo, arrivalOptions),
    });
  };

  const summaryOf = (session) => ({
    batch_no: session?.batch_no || '',
    scanned: Number(session?.scanned || 0),
    expected: Number(session?.expected || 0),
    status: session?.status || '',
  });

  /**
   * 开一次验收会话（工作台点【验收】时调）。
   *
   * ⚠️ 同一批、还开着的会话 ⇒ **原样复用**（她扫到一半刷新页面，已扫的那些不能丢）。
   * ⚠️ 换一批 ⇒ 直接换成新会话（验收模式一次只服务一批；上一批没完成就重开，按她的口径
   *    "一次验收就是这一批"）。
   */
  const start = async ({ openId, batchNo, batchRecordId = '', operatorOpenId = '' }) => {
    const wanted = String(batchNo || '').trim();
    if (!wanted) return { ok: false, reason: 'no_batch_no', message: texts.acceptBatchMissingBody };
    const existing = await get(openId);
    if (existing && existing.batch_no === wanted && existing.status === 'open') {
      return { ok: true, reused: true, session: existing };
    }
    const query = purchaseQueryOf();
    if (!query) return { ok: false, reason: 'not_wired', message: texts.acceptRowsUnreadableBody };
    const rows = await query.listPurchaseRequests({ batchNo: wanted, reportBehavior: 'purchase_request' });
    const normalized = [];
    for (const row of rows || []) {
      const size = positiveInteger(row?.size);
      const quantity = Number(row?.quantity);
      if (!row?.record_id || !row?.product_record_id || size === null || !Number.isSafeInteger(quantity) || quantity <= 0) {
        return { ok: false, reason: 'request_rows_unreadable', message: texts.acceptRowsUnreadableBody };
      }
      normalized.push({
        request_record_id: row.record_id,
        product_record_id: row.product_record_id,
        size,
        quantity,
      });
    }
    if (!normalized.length) {
      return { ok: false, reason: 'no_request_rows', message: texts.acceptRowsUnreadableBody };
    }
    // 同一批里同一 (货品, 尺码) 有两行申请 ⇒ **拦住**（与 buildPlan 的 matches.length !== 1 同一条口径）
    const seen = new Set();
    for (const row of normalized) {
      const key = `${row.product_record_id}|${row.size}`;
      if (seen.has(key)) {
        return { ok: false, reason: 'duplicate_request_rows', message: texts.acceptDuplicateRowsBody };
      }
      seen.add(key);
    }
    const record = touch({
      session_id: idOf(openId),
      open_id: String(openId || ''),
      batch_no: wanted,
      batch_record_id: String(batchRecordId || '').trim(),
      request_ids: normalized.map((row) => row.request_record_id),
      rows: normalized,
      expected: normalized.reduce((sum, row) => sum + row.quantity, 0),
      scans: [],
      scanned: 0,
      status: 'open',
      operator_open_id: String(operatorOpenId || openId || ''),
      last_error: '',
      posted_result: null,
    });
    await store.create(record);
    logInfo(events.acceptStarted, {
      session_id: record.session_id, batch_no: wanted, expected: record.expected, row_count: normalized.length,
    });
    return { ok: true, reused: false, session: record };
  };

  /**
   * 记一双扫到的货。**不写任何业务表**。
   * · 不在本批 ⇒ `{ok:false, reason:'not_in_batch'}`（页面照实提示、不记）；
   * · 重复扫（同一 货品+尺码 已经记过）⇒ `{ok:true, duplicate:true}`，**数字一个都不变**。
   */
  const addScan = async ({ openId, productRecordId, size, quantity }) => {
    const session = await get(openId);
    if (!session) return { ok: false, reason: 'no_session', message: texts.acceptNoSessionBody };
    if (session.status !== 'open') {
      return {
        ok: false,
        reason: 'already_posted',
        message: fillText(texts.acceptAgainBody, { batchNo: session.batch_no }),
      };
    }
    const wantedSize = positiveInteger(size);
    const rawQuantity = String(quantity ?? '').trim();
    const wantedQuantity = rawQuantity ? positiveInteger(rawQuantity) : config.defaultQuantity;
    if (wantedSize === null) {
      return { ok: false, reason: 'size_unknown', message: texts.acceptNotInBatchBody };
    }
    if (wantedQuantity === null || wantedQuantity > config.maxQuantity) {
      return {
        ok: false,
        reason: 'quantity_invalid',
        message: fillText(texts.acceptQuantityInvalidBody, { max: config.maxQuantity }),
      };
    }
    const row = (session.rows || []).find((item) => (
      item.product_record_id === productRecordId && Number(item.size) === wantedSize
    ));
    if (!row) {
      logInfo(events.acceptNotInBatch, {
        session_id: session.session_id, batch_no: session.batch_no,
        product_record_id: String(productRecordId || ''), size: wantedSize,
      });
      return { ok: false, reason: 'not_in_batch', message: texts.acceptNotInBatchBody };
    }
    const already = (session.scans || []).some((item) => (
      item.product_record_id === productRecordId && Number(item.size) === wantedSize
    ));
    if (already) {
      logInfo(events.acceptDuplicate, {
        session_id: session.session_id, batch_no: session.batch_no, size: wantedSize,
      });
      return { ok: true, duplicate: true, session, message: texts.acceptDuplicateBanner };
    }
    if ((session.scans || []).length >= config.maxScans) {
      return { ok: false, reason: 'too_many_scans', message: texts.acceptTooManyScansBody };
    }
    const scans = [...(session.scans || []), {
      product_record_id: productRecordId, size: wantedSize, quantity: wantedQuantity,
    }];
    const next = await store.update(session.session_id, touch({
      scans,
      scanned: scans.reduce((sum, item) => sum + item.quantity, 0),
      last_error: '',
    }));
    logInfo(events.acceptLineAdded, {
      session_id: session.session_id, batch_no: session.batch_no,
      size: wantedSize, quantity: wantedQuantity, scanned: next.scanned, expected: next.expected,
    });
    return { ok: true, duplicate: false, session: next, message: '' };
  };

  /**
   * 【完成验收】⇒ 入库 + 批次改「已到货」（**实际到货数量 = 已扫合计**）。
   *
   * 🔴 这里**不写库、不拼草稿**：整件事交给既有 `confirmBatchArrival`（新增的 `scanLines`
   *    输入口 → 既有 `buildPlan` 的扫码分支 → 既有 `confirmLocked`）。
   * 🔴 一双都没扫 / 金额不合法 ⇒ 既有实现会**在写任何东西之前**拒掉（本方法原样把话带回去）。
   */
  const finish = async ({ openId, actualAmount, submitKey = '', operatorOpenId = '' } = {}) => {
    const session = await get(openId);
    if (!session) return { ok: false, reason: 'no_session', message: texts.acceptNoSessionBody };
    const summary = summaryOf(session);
    if (session.status === 'posted') {
      logInfo(events.acceptReused, {
        session_id: session.session_id, batch_no: session.batch_no, submit_key: String(submitKey || ''),
      });
      return {
        ok: true,
        reused: true,
        ...summary,
        message: fillText(texts.acceptAgainBody, { batchNo: session.batch_no }),
      };
    }
    if (!(session.scans || []).length) {
      return { ok: false, reason: 'no_scan_lines', ...summary, message: texts.acceptNoScansBody };
    }
    const conversation = arrivalConversationOf();
    if (!conversation) return { ok: false, reason: 'not_wired', ...summary, message: texts.acceptRowsUnreadableBody };

    const detail = (session.scans || []).map((item) => `${item.size} 码 ${item.quantity} 双`).join('、');
    // 本地草稿里那句"到货说明" = **扫码事实的复述**（她不用写；表里也没有这一列）。
    const acceptanceText = fillText(texts.acceptanceTextTemplate, {
      detail, scanned: summary.scanned, expected: summary.expected,
    });
    logInfo(events.acceptFinishing, {
      session_id: session.session_id, batch_no: session.batch_no,
      scanned: summary.scanned, expected: summary.expected, submit_key: String(submitKey || ''),
    });
    const result = await conversation.confirmBatchArrival({
      batch: {
        batch_no: session.batch_no,
        batch_record_id: session.batch_record_id,
        request_ids: session.request_ids,
      },
      acceptanceText,
      actualAmount,
      operatorOpenId: operatorOpenId || session.operator_open_id || openId,
      // ⭐ 新增输入口：逐码实际到货（既有 buildPlan 的扫码分支）
      scanLines: (session.scans || []).map((item) => ({
        product_record_id: item.product_record_id, size: item.size, quantity: item.quantity,
      })),
    });
    if (!result || result.ok !== true) {
      const message = result?.message || texts.acceptRowsUnreadableBody;
      await store.update(session.session_id, { last_error: String(message) }).catch(() => undefined);
      logInfo(events.acceptFailed, {
        session_id: session.session_id, batch_no: session.batch_no,
        reason: result?.reason || 'failed', message,
      });
      return { ok: false, reason: result?.reason || 'failed', ...summary, message };
    }
    const posted = await store.update(session.session_id, touch({
      status: 'posted',
      posted_result: { message: result.message || '', task_id: result.taskId || '' },
      last_error: '',
    }));
    logInfo(events.acceptFinished, {
      session_id: posted.session_id, batch_no: posted.batch_no,
      scanned: summary.scanned, expected: summary.expected, task_id: result.taskId || '',
    });
    return {
      ok: true,
      reused: false,
      ...summary,
      taskId: result.taskId || '',
      message: result.message || fillText(texts.acceptDoneBody, {
        batchNo: session.batch_no, scanned: summary.scanned,
      }),
    };
  };

  /**
   * ⭐⭐ 2026-10-12（业务负责人）：「**验收还是只在扫码页**，我不需要在工作台」
   *   ⇒ 验收领域**没带批次号**时要能**自己开工**：把**未到货的批次**列出来给她点。
   *
   * 取数**复用既有那一份**（`PurchasePendingBatchService` = 9 点推送【采购】区用的同一个
   * 「到货状态 = 未到货」候选；取值来自 `config/purchaseArrivalStatus`，**不写死中文**）。
   *
   * ⚠️ **读表失败不抛**：如实返回 `{ ok: false, batches: [] }` —— 页面照旧能开（走手输兜底），
   *    由路由记一条 warn。**绝不**因为一次读表失败把她挡在门外。
   *
   * @returns {Promise<{ok: boolean, batches: Array<{batchNo: string, suppliers: string[], quantity: string}>}>}
   */
  const pendingBatches = async () => {
    try {
      const service_ = pendingBatchesService();
      if (!service_) return { ok: false, batches: [] };
      const batches = await service_.listPendingBatches();
      return {
        ok: true,
        batches: (batches || [])
          .filter((batch) => batch?.batchNo)
          .map((batch) => ({
            batchNo: String(batch.batchNo),
            suppliers: Array.isArray(batch.suppliers) ? batch.suppliers : [],
            quantity: String(batch.quantity || ''),
          })),
      };
    } catch (error) {
      logWarn('scan.accept.pending_batches_failed', { error: error.message });
      return { ok: false, batches: [] };
    }
  };

  // ⚠️ 惰性构造：只有**验收领域没带批次号**那一次才会用到它（一次读表）；用例可注入替身。
  let pendingBatchesInstance = null;
  const pendingBatchesService = () => {
    const provided = resolve(options.pendingBatches);
    if (provided) return provided;
    if (!options.gateway) return null;
    if (!pendingBatchesInstance) {
      // eslint-disable-next-line global-require
      const { PurchasePendingBatchService } = require('./purchasePendingBatchService');
      pendingBatchesInstance = new PurchasePendingBatchService({ gateway: options.gateway });
    }
    return pendingBatchesInstance;
  };

  return { idOf, get, start, addScan, finish, summaryOf, pendingBatches, store };
};

module.exports = { createScanArrivalService };
