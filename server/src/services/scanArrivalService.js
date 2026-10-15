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

/**
 * ⭐ 2026-10-12：**允许 0 的整数**（预填清单"没到的改成 0"）。
 * ⚠️ 与 `positiveInteger`（要求 ≥1，扫码那条路用）**并存**：改数量那条路要收 0。
 */
const nonNegativeInteger = (value) => {
  const text = String(value ?? '').trim();
  return /^(0|[1-9]\d*)$/.test(text) ? Number(text) : null;
};

/**
 * ⭐ 2026-10-12：这一批里**去重后的款**（`product_record_id` + 编号）——
 * 自定义行 / "未报货尺码"候选都要能回答"归到哪一款"，而这个答案必须来自**真实读到的那几行**。
 */
const productsOf = (rows = []) => {
  const out = [];
  for (const row of rows || []) {
    const productRecordId = String(row?.product_record_id || '').trim();
    if (!productRecordId) continue;
    if (out.some((item) => item.product_record_id === productRecordId)) continue;
    out.push({ product_record_id: productRecordId, number: String(row?.product_number || '').trim() });
  }
  return out;
};

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
      // ⭐ 2026-10-13（验收提速）：第 4 个参数是**尾部可选** `options`（验收自造的 timing）——
      //    不传 = 与改动前逐字同形。
      confirmArrival: (taskId, task, operatorOpenId, options) => webhooks.confirmArrival(
        taskId, task, operatorOpenId, options,
      ),
      markBatchArrived: (batchNo, arrivalOptions) => webhooks.orderBatches.markArrived(batchNo, arrivalOptions),
    });
  };

  /**
   * ⭐⭐ P0 2026-10-12：「完成验收」的**幂等键**（服务端算，页面只负责带回来）。
   * `accept:<session_id>:<轮次>` —— 轮次在她每次改动清单时 +1 ⇒
   *   · 同一屏**连点两次** = 同一把钥匙 ⇒ 第二次**直接幂等返回**（零写入）✓
   *   · 改完数量再提交 = 新钥匙 ⇒ 正常执行 ✓
   */
  const submitKeyOf = (session) => `accept:${String(session?.session_id || '')}:${Number(session?.submit_round || 0)}`;

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
    if (!normalized.length && config.allowEmptyRows !== true) {
      return { ok: false, reason: 'no_request_rows', message: texts.acceptRowsUnreadableBody };
    }
    // ⭐ 2026-10-12：`allowEmptyRows`（**默认关**）打开时，一条明细都没有也开得起会话 ——
    //    但"款从哪来"这件事仍然**不知道** ⇒ 加行只能靠**扫标签**（码里带款），不猜 ✗。
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
      // ⭐⭐ 2026-10-12（方案 A）：记住"这一批有哪些款 + 各自编号"——
      //    验收页要靠**编号的第 3 段（类别）**算"没报货的尺码"候选（与缺码同一份配置口径）。
      products: productsOf(rows),
      expected: normalized.reduce((sum, row) => sum + row.quantity, 0),
      scans: [],
      scanned: 0,
      // ⭐⭐ P0 2026-10-12（真机：5 双变 10 双）：**"完成验收"要有幂等键**，而且
      //    **每次清单变更就换一把新钥匙**（她改完数量再提交是**新的一次**，不能被当成重放 ✗）。
      //    钥匙由服务端算（`accept:<session_id>:<轮次>`）——不依赖页面传来什么。
      submit_round: 0,
      posted_keys: [],
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
   * ⭐⭐ 2026-10-12（业务负责人口述版）：「用户点验收的时候，**先默认带出我们采购申请里的尺码和数量**。
   *   用户可以在**给定的区域里直接修改**，同时**也可以自定义**；**自定义的时候同样支持扫码**。」
   *
   * 把"她在给定区域里改完的**整张清单**"落进会话（**不写任何业务表**，与 `addScan` 共用同一份 `scans`）：
   *   · **报货行**：按**下标**对应 `session.rows`（顺序 = 采购明细顺序）；
   *     数量填 **0 / 空** ⇒ 那一行**不算到货**（从清单里去掉）—— 她「没到的改成 0」就是这一步；
   *   · **自定义行**（手输 尺码 + 数量）：本批**只有一个款**时绑到它；**多个款 / 一条明细都没有**
   *     ⇒ **拒**（`custom_ambiguous` / `custom_product_unknown`）⇒ 页面让她**扫标签**（码里带款）。
   *     🔴 **不猜款**：猜错 = 库存加到别人头上，比"让她扫一下"坏得多。
   *   · 同款同码重复 ⇒ **合并**（取最后填的那个数量）。
   *
   * ⚠️ 数量上限沿用既有 `config.maxQuantity`（与 `addScan` 同一个口径）。
   */
  const setActualRows = async ({ openId, quantities = [], customSize = [], customQuantity = [] } = {}) => {
    const session = await get(openId);
    if (!session) return { ok: false, reason: 'no_session', message: texts.acceptNoSessionBody };
    if (session.status !== 'open') {
      return {
        ok: false, reason: 'already_posted',
        message: fillText(texts.acceptAgainBody, { batchNo: session.batch_no }),
      };
    }
    const reported = Array.isArray(session.rows) ? session.rows : [];
    const quantityInvalid = () => ({
      ok: false, reason: 'quantity_invalid',
      message: fillText(texts.acceptQuantityInvalidBody, { max: config.maxQuantity }),
    });
    const next = [];
    for (const [index, row] of reported.entries()) {
      const raw = String(quantities[index] ?? '').trim();
      // ⚠️「改成 0」是**她要的那个动作**（"没到"）⇒ 这里必须收 `0`：
      //   空 / 0 都算"没到"（不写、不加库存），只有非数字 / 超上限才拒。
      const quantity = raw ? nonNegativeInteger(raw) : 0;
      if (quantity === null || quantity > config.maxQuantity) return quantityInvalid();
      if (quantity > 0) {
        next.push({ product_record_id: row.product_record_id, size: row.size, quantity });
      }
    }
    const products = [...new Set(reported.map((row) => row.product_record_id))];
    const customSizes = Array.isArray(customSize) ? customSize : [customSize];
    const customQuantities = Array.isArray(customQuantity) ? customQuantity : [customQuantity];
    let customCount = 0;
    const total = Math.max(customSizes.length, customQuantities.length);
    for (let index = 0; index < total; index += 1) {
      const sizeText = String(customSizes[index] ?? '').trim();
      const qtyText = String(customQuantities[index] ?? '').trim();
      if (!sizeText && !qtyText) continue;                       // 空行 = 没加
      const size = positiveInteger(sizeText);
      const quantity = positiveInteger(qtyText);
      if (size === null || quantity === null || quantity > config.maxQuantity) return quantityInvalid();
      // 🔴 自定义行**必须知道是哪一款**：单个款 ⇒ 绑它；否则**拒**（页面上让她扫码）。
      if (products.length !== 1) {
        logInfo(events.acceptFailed, {
          session_id: session.session_id, batch_no: session.batch_no,
          reason: products.length ? 'custom_ambiguous' : 'custom_product_unknown', size,
        });
        return { ok: false, reason: 'custom_product_unknown', message: texts.acceptCustomProductNeededBody };
      }
      const productRecordId = products[0];
      const same = next.find((line) => line.product_record_id === productRecordId && line.size === size);
      if (same) same.quantity = quantity;                        // 同款同码 ⇒ 合并
      else next.push({ product_record_id: productRecordId, size, quantity });
      customCount += 1;
    }
    if (next.length > config.maxScans) {
      return { ok: false, reason: 'too_many_scans', message: texts.acceptTooManyScansBody };
    }
    const scanned = next.reduce((sum, line) => sum + line.quantity, 0);
    const updated = await store.update(session.session_id, touch({
      scans: next,
      scanned,
      // ⭐ 清单变了 ⇒ **新一轮**（新的幂等键）——她改完再提交是"新的一次" ✓
      submit_round: Number(session.submit_round || 0) + 1,
      last_error: '',
    }));
    logInfo(events.acceptRowsSet, {
      session_id: updated.session_id, batch_no: updated.batch_no,
      line_count: next.length, scanned, expected: Number(updated.expected || 0),
      custom_count: customCount, request_rows: reported.length,
    });
    return { ok: true, session: updated, scanned, expected: Number(updated.expected || 0), rows: next };
  };

  /**
   * 【完成验收】⇒ 入库 + 批次改「已到货」（**实际到货数量 = 已扫合计**）。
   *
   * 🔴 这里**不写库、不拼草稿**：整件事交给既有 `confirmBatchArrival`（新增的 `scanLines`
   *    输入口 → 既有 `buildPlan` 的扫码分支 → 既有 `confirmLocked`）。
   * 🔴 一双都没扫 / 金额不合法 ⇒ 既有实现会**在写任何东西之前**拒掉（本方法原样把话带回去）。
   */
  const finish = async ({ openId, actualAmount, submitKey = '', operatorOpenId = '' } = {}) => {
    // ⭐⭐ 2026-10-13（验收提速）：**一条**分阶段耗时汇总（`scan.accept.timing`）。
    //    为什么：真账量出"每批 5 码 143.9 秒、其中逐码库存 119.5 秒（83%）"——
    //    没有分段就只能靠感觉。分段：`session_ms`（读会话）/ `inbound_total_ms`（入库整段，
    //    含"报货批次"写实 + 加库存）/ `inventory_ms`（其中**加库存**那一段，由库存层填）。
    const finishStartedAt = Date.now();
    const session = await get(openId);
    if (!session) return { ok: false, reason: 'no_session', message: texts.acceptNoSessionBody };
    const summary = summaryOf(session);
    const sessionMs = Date.now() - finishStartedAt;
    // ⭐⭐ P0 2026-10-12：**同一把钥匙提交过 ⇒ 直接幂等返回**（零写入）——
    //    她连点两次 / 网络重试，都不会再加一次库存 ✗。
    const wantedKey = String(submitKey || '').trim();
    if (wantedKey && (session.posted_keys || []).includes(wantedKey)) {
      logInfo(events.acceptReused, {
        session_id: session.session_id, batch_no: session.batch_no, submit_key: wantedKey, reason: 'duplicate_submit_key',
      });
      return {
        ok: true, reused: true, ...summary,
        message: fillText(texts.acceptAgainBody, { batchNo: session.batch_no }),
      };
    }
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
    const inboundStartedAt = Date.now();
    // 服务层**自造** timing，逐层透传到库存那一层（`inventory_ms` 只有那里量得准）。
    const timing = {};
    const result = await conversation.confirmBatchArrival({
      batch: {
        batch_no: session.batch_no,
        batch_record_id: session.batch_record_id,
        request_ids: session.request_ids,
      },
      acceptanceText,
      // ⭐ 2026-10-16：扫码线**显式声明**「必须有那句原话」⇒ 判据与改前**逐字一致** ✓
      requireAcceptanceText: true,
      actualAmount,
      operatorOpenId: operatorOpenId || session.operator_open_id || openId,
      // ⭐ 新增输入口：逐码实际到货（既有 buildPlan 的扫码分支）
      scanLines: (session.scans || []).map((item) => ({
        product_record_id: item.product_record_id, size: item.size, quantity: item.quantity,
      })),
      timing,
    });
    // ⚠️ 成功与失败**都**打这一条（她的现场就是"慢/卡"，失败原因也要能按分段定位）。
    logInfo(events.acceptTiming, {
      session_id: session.session_id,
      batch_no: session.batch_no,
      session_ms: sessionMs,
      inbound_total_ms: Date.now() - inboundStartedAt,
      scanned: summary.scanned,
      ...timing,
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
    // ⭐⭐ 2026-10-13（验收提速 ②）：她**刚验收完** ⇒ 主动失效「待验收批次」列表的短缓存。
    //    为什么必须做：否则那一批还会在列表里挂到 TTL 结束 —— 她会以为"验收没生效"（现场最容易误判的一种）。
    //    ⚠️ 只失效这一份内存缓存，不写任何表；注入的替身没有 `invalidate` 时静默跳过。
    try {
      const pendingService = pendingBatchesService();
      if (pendingService && typeof pendingService.invalidate === 'function') pendingService.invalidate();
    } catch (error) {
      logWarn('scan.accept.pending_cache.invalidate_failed', { error: error.message });
    }
    const posted = await store.update(session.session_id, touch({
      status: 'posted',
      // ⭐ P0：记住**这一把钥匙已经用掉**（下一次同钥匙 = 幂等返回）
      posted_keys: [...new Set([...(session.posted_keys || []), wantedKey].filter(Boolean))],
      posted_result: { message: result.message || '', taskId: result.taskId || '' },
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
  const pendingBatches = async ({ timing = null } = {}) => {
    // ⭐ 2026-10-13（她："`/accept` 要点 4、5 次才跳过去" 4.8~7.4s ✗）：**先量** ——
    //   读「报货批次」未到货那批是这一页的主成本 ⇒ 可选出参 timing（只加打点 ✓ 逻辑零改动）
    const startedAt = Date.now();
    const mark = (name, from) => { if (timing) timing[name] = Math.max(0, Date.now() - from); };
    try {
      const service_ = pendingBatchesService();
      if (!service_) { mark('batches_ms', startedAt); return { ok: false, batches: [] }; }
      const batches = await service_.listPendingBatches();
      mark('batches_ms', startedAt);
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

  return {
    idOf, get, start, addScan, finish, summaryOf, pendingBatches, store,
    // ⭐ P0：页面把"完成验收"的幂等键画进表单，提交时带回来
    submitKeyOf,
    // ⭐ 2026-10-12：把"改完的整张清单"落进会话（预填清单那一版的入口；不写业务表）
    setActualRows,
  };
};

module.exports = { createScanArrivalService };
