/**
 * ⭐⭐ **「补货 / 退货 / 销售 存草稿 · 接着录」的独立存储层**（本刀 = **S1**）。
 *
 * 设计（**权威口径，别自己发明**）：
 *   · `docs/draft-save-resume-plan-2026-10-16.md`（只读核查 + 设计 + 判据草案）
 *   · `.local/draft-plan/LEAD-ADDENDUM-2.md` / `LEAD-ADDENDUM-3.md`（业务负责人 2026-10-16 的两条最新逻辑）
 * 业务负责人的话（逐字，决定本文件的形状）：
 *   · 「我们的**补货和退货需要支持存草稿**功能…我往往不会在当下把所有要补或要退的货一次性想好，
 *      需要支持**存草稿后续再处理**」；
 *   · 「我们的**销售货品页上面也需要加一个按钮，叫「存报货草稿」**」；
 *   · 「我在采购主表里面，在「**到货状态**」中加了一个选项，叫做「**未报货**」，
 *      也就是我们的**草稿状态**」；
 *   · ⭐ **批次号逻辑**：「草稿创建时，看采购主表里**有没有未报货的批次号**：
 *      (a) **有 ⇒ 沿用** (b) **没有 ⇒ 新建**」；
 *   · ⭐ **供应商拆分逻辑**：「同一个报货批次号里可能混杂不同供应商 ⇒ **生成报货单时按供应商拆分/分组**」。
 *
 * ── 一个模块只干一件事（AGENTS.md《底层工程原则》的「模块化」）──────────────────
 *   ① **草稿存哪**：**本地独立存储** `data/scan_drafts/`（复用 `infrastructure/jsonTaskStore`
 *      的形状 ✓ 不另造一套 ✗）——**与会话（`data/scan_sessions/`）分开**，因为会话过期会
 *      `freshSession()` 把 `orders` 整段丢掉 ✗，而草稿必须活得比会话久（她的场景是"过几天再想"）。
 *   ② **草稿行的落点**：「采购主表」那一行，`到货状态 = 「未报货」`（= 她的"草稿状态"）——
 *      字段名一律从 `config/v1BitableSchema.js` 的**语义键**取，本文件**不写中文列名** ✗；
 *   ③ **批次号**：回查「采购主表」里 `到货状态 = 「未报货」` 的行 ⇒ 有就**沿用**、没有就**新建**
 *      （号源 = **既有** `services/purchaseBatchNoGenerator.js`；格式配置在 `config/purchaseBatchNo.js`）。
 *
 * ── 🔴 本模块不做的事（本刀 S1 的边界，越界就是"改别人的活"）────────────────────
 *   · **不渲染页面**（那是 `views/scanPageRenderer.js`，S2）✗；
 *   · **不解析 HTTP 表单、不加路由**（那是 `routes/scanPage.js`，S3）✗；
 *   · **不生成报货单**（⇒ **供应商拆分**那一下落在 S3；本文件只把 `supplierRecordId` 记下来）✗；
 *   · **不提交**（提交仍走既有的 `submitDraft` / `submitSale` 那条路）✗；
 *   · 🔴 **不碰 `services/scanWriteService.js`**（余量 0 的冻结件：一个字不加/删/改 ✗）
 *     —— 本模块**不 require 它**、也不改它；判据 `AC-D8` 逐字节核它的 sha256 ✓。
 *
 * ── 副作用纪律（**存草稿 = 零副作用**，她 2026-10-16 的三条坑之一）──────────────
 *   存草稿**只**做两件事：① 本地那份草稿；② 「采购主表」**那一行**（`到货状态=未报货`）。
 *   🔴 **绝不**：发群 / 出图 / 写库存 / 建采购明细 / 走"生成报货单"那一步 ✓
 *   （`AC-D1` 用**假 gateway 记账**证明：`create` 只落到 `purchaseOrderBatch` 一次，
 *    `purchaseRequest` 0 次、`inventory*` 0 次、出图/发群的注入件 0 次 ✓）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { SCAN_DRAFT, DRAFT_SCOPE } = require('../config/scanDraft');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { textValue } = require('./v1BitableGateway');
const { logInfo, logWarn, logError } = require('../utils/logger');

/** 兜底会话 id 的形状（与 `services/scanSessionService.js:39` 的 `[A-Za-z0-9_-]` 白名单一致）。 */
const DEFAULT_ID_PREFIX = 'scan_session';

/** `{name}` 占位符替换（与 `config/scanWrite.js` 的 `fillText` 同一种形状；不互相 require ✗）。 */
const fill = (template, values = {}) => String(template || '').replace(/\{(\w+)\}/g, (whole, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
));

/** 正整数（认不出 ⇒ `null`；**不把空串当 0** —— "没填 ≠ 填 0"）。 */
const positiveInteger = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : null;
};

/** 幂等键 / 文件名里允许的字符（与引擎那套**同一套**清洗 ✓）。 */
const sanitizeKey = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');

/** 草稿里数一行 = 一个「尺码 + 数量」（与引擎 `validateDraft` 的行口径一致 ✓）。 */
const lineCountOf = (items) => (Array.isArray(items) ? items : []).reduce(
  (sum, item) => sum + (Array.isArray(item?.entries) ? item.entries.length : 0),
  0,
);

/** 把一件货品归一成**逐字可读回**的形状（字段名 = 引擎 §4.3 那一份 ✓ 顺序不动 ✗）。 */
const normalizeItem = (item = {}) => ({
  product_record_id: String(item.product_record_id || item.productRecordId || '').trim(),
  number: String(item.number || '').trim(),
  item_no: String(item.item_no || item.itemNo || '').trim(),
  color: String(item.color || '').trim(),
  supplier_record_id: String(item.supplier_record_id || item.supplierRecordId || '').trim(),
  entries: (Array.isArray(item.entries) ? item.entries : []).map((entry) => ({
    size: String(entry?.size ?? '').trim(),
    quantity: entry?.quantity ?? '',
  })),
});

/** 供应商分桶键（`per_supplier` 口径；拿不到供应商 ⇒ 明确落一个"没指定"的桶，**不猜** ✗）。 */
const UNSPECIFIED_SUPPLIER = 'unspecified';

/**
 * 造一个「补货 / 退货 / 销售 存草稿」的存储层。
 *
 * @param {object} options
 * @param {object} options.gateway      V1 表格网关（**必填** —— 本模块不自己 new，
 *                                      免得在只读环境里凭空构造一个真实客户端 ✗）
 * @param {object} [options.sessions]   既有 `scanSessionService`（**只用来取会话 id** ——
 *                                      `sessions.idOf`；不读写会话内容 ✗）
 * @param {(openId:string)=>string} [options.idOf] 直接给会话 id 的算法（用例可以注入）
 * @param {object} [options.store]      本地存储（默认 `data/scan_drafts/` 上新建一个 `JsonTaskStore`）
 * @param {string} [options.dir]        本地草稿目录（`store` 没给时才用）
 * @param {object} [options.batchNoGenerator] 既有号源（`services/purchaseBatchNoGenerator.js`）
 *                                      —— 只用于"新建一个批次号"那一支；**没有就不新建**（如实报错）
 * @param {object} [options.orderBatches] 既有 `services/purchaseOrderBatchService.js`
 *                                      —— 用于按批次号回查那一行（**只读**）
 * @param {string} [options.tableKey]   草稿行落在哪张表（默认 `purchaseOrderBatch`）
 * @param {string} [options.statusFieldKey] 状态列的语义键（默认 `arrivalStatus`）
 * @param {string} [options.statusValue] "草稿状态"的取值（默认 = 配置里的 `未报货`）
 * @param {object} [options.config]     配置（默认进程级那一份；用例可以传不同的 env 解析出来的）
 * @param {object} [options.logger]     日志（可注入 ⇒ 用例断言"留痕了哪一条"）
 * @param {()=>Date} [options.now]      时间源（可注入 ⇒ 用例可以造"过期的草稿"）
 * @param {(input:object)=>string} [options.keyOf] 并发串行键（默认按"会话"）
 * @param {object} [options.queue]      串行队列（默认新建一个）
 */
const createScanDraftService = (options = {}) => {
  const gateway = options.gateway;
  if (!gateway || typeof gateway.create !== 'function') {
    throw new Error('scanDraftService 需要 gateway（本模块不自己 new 客户端）');
  }
  const config = options.config || SCAN_DRAFT;
  const now = options.now || (() => new Date());
  const logger = options.logger || { logInfo, logWarn, logError };
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  const error_ = typeof logger.logError === 'function' ? logger.logError : () => {};
  const texts = config.texts || {};
  const events = config.events || {};

  const sessions = options.sessions || null;
  const idOf = options.idOf
    || (sessions && typeof sessions.idOf === 'function' ? sessions.idOf : null)
    || ((openId) => `${DEFAULT_ID_PREFIX}_${sanitizeKey(openId).slice(0, 16)}`);

  const store = options.store || new JsonTaskStore({
    dir: options.dir || config.dir,
    idField: 'draft_id',
  });
  const queue = options.queue || new KeyedSerialQueue();
  const batchNoGenerator = options.batchNoGenerator || null;
  const orderBatches = options.orderBatches || null;
  const tableKey = options.tableKey || config.tableKey;
  const statusFieldKey = options.statusFieldKey || config.statusFieldKey;
  const statusValue = options.statusValue || config.statusValue;
  const supplierSplit = config.supplierSplit;

  const tableOf = (key) => V1_BITABLE_SCHEMA.tables[key] || null;
  const fieldOf = (key, semanticKey) => tableOf(key)?.fields?.[semanticKey] || '';

  /** 草稿行的幂等键（**独立前缀** ⇒ 不与 `purchase_batch:*` 撞 ✓）。 */
  const draftRowKey = (sessionId, bucket) => `${config.idempotencyPrefix}:${sessionId}:${bucket}`;
  const draftIdOf = (sessionId, bucket) => sanitizeKey(`${config.idempotencyPrefix}_${sessionId}_${bucket}`);

  const reject = (code, message, details = {}) => ({ ok: false, code, message, details });

  /** 草稿存在哪个桶里（`single` = 一个会话一份；`per_supplier` = 一个供应商一份）。 */
  const bucketOf = ({ openId, supplierRecordId = '' }) => {
    if (config.scope !== DRAFT_SCOPE.perSupplier) return DRAFT_SCOPE.single;
    const supplier = String(supplierRecordId || '').trim();
    return supplier ? sanitizeKey(supplier) : UNSPECIFIED_SUPPLIER;
  };

  const draftsOf = (record) => (record && typeof record.drafts === 'object' && record.drafts) ? record.drafts : {};

  // ── ① 表侧：草稿行的回查 / 建行 ─────────────────────────────────────────────
  /**
   * 回查「有没有未报货的批次号」（她说的 (a)/(b) 那一看）。
   * ⚠️ **只读**：这一趟**不取号、不建行、不发群** ✓。
   * @returns {Promise<{batchNo:string, recordId:string}|null>}
   */
  const findPendingBatch = async () => {
    const field = fieldOf(tableKey, statusFieldKey);
    if (!field) return null;
    const batchField = fieldOf(tableKey, 'batchNo');
    const records = await gateway.listAll(tableKey);
    const hit = (records || []).find(
      (record) => textValue(record?.fields?.[field]).trim() === String(statusValue).trim(),
    );
    if (!hit) return null;
    const batchNo = batchField ? textValue(hit?.fields?.[batchField]).trim() : '';
    return { batchNo, recordId: String(hit?.record_id || '') };
  };

  /**
   * ⭐ 她两条核心逻辑的第 ① 条：**批次号沿用 vs 新建**。
   *   (a) 有未报货的号 ⇒ **沿用** ✓（`events.batchReused` 留痕）
   *   (b) 没有 ⇒ **新建** ✓（既有号源；`events.batchCreated` 留痕）
   * 🔴 这一整段由调用方放进**串行块**里（见 `saveDraft`）—— 两个草稿同时"都没有"时，
   *    第二个必须**看得见第一个刚建的号**，不许各建一个新号 ✗。
   */
  const resolveBatchNo = async ({ sessionId, requestId = '' } = {}) => {
    if (config.reusePendingBatchNo !== true) {
      // 配置只认 reuse_pending（见 config/scanDraft.js）⇒ 这里守住"口径不许被绕过" ✓
      return reject('batch_no_policy_unknown', texts.tableWriteFailed, { policy: config.batchNoPolicy });
    }
    const pending = await findPendingBatch();
    if (pending && pending.batchNo) {
      info(events.batchReused, {
        session_id: sessionId, batch_no: pending.batchNo, batch_record_id: pending.recordId,
        matched_by: 'arrival_status_pending', request_id: requestId || undefined,
      });
      return { ok: true, batchNo: pending.batchNo, recordId: pending.recordId, reused: true };
    }
    if (typeof batchNoGenerator?.next !== 'function') {
      // **拿不到号源就不编号** ✗（与"本机够不着生产表"同一条纪律：宁可吵，不许猜）
      return reject('batch_no_generator_missing', texts.tableWriteFailed);
    }
    const made = await batchNoGenerator.next({ source: 'scan_draft', taskId: sessionId });
    info(events.batchCreated, {
      session_id: sessionId, batch_no: made?.batchNo || '', sequence: made?.sequence,
      source: config.batchNoSource, reused_pending_found: Boolean(pending), request_id: requestId || undefined,
    });
    return { ok: true, batchNo: String(made?.batchNo || ''), recordId: '', reused: false };
  };

  /**
   * 把草稿那一行写进「采购主表」（`到货状态 = 未报货`）。
   *
   * 🔴 本函数是**唯一**一处碰 gateway 写接口的地方（源码哨兵 `AC-D8` 钉着）：
   *    写**只有** `gateway.create(tableKey, …)` 这一个入口 —— 草稿行是**新的一行**，
   *    不走 update（update 要 record_id，而草稿第二次存会覆盖本地那一份、
   *    表侧那一行的身份由**幂等键**保证 ⇒ 同一批多份草稿落在**同一行**上 ✓）。
   */
  const writeDraftRowToTable = async ({ batchNo, sessionId, bucket, supplierRecordId, correlation = {} }) => {
    const key = draftRowKey(sessionId, bucket);
    // 「报货批次号」是**草稿行的身份**（她两条逻辑都围着它转）⇒ 这一列没配上就**不写半行** ✗
    if (!fieldOf(tableKey, 'batchNo')) {
      return reject('batch_no_field_missing', texts.tableKeyMissing, { table_key: tableKey });
    }
    const values = {
      batchNo,
      idempotencyKey: key,
      [statusFieldKey]: statusValue,
    };
    // ⚠️ 供应商列在 schema 里是**只读**的（`2026-10-09` 只读核实过、判据钉着"全仓没有写入点"）
    //   ⇒ 本刀**不写它**；`supplierRecordId` 只进本地草稿与日志（S3 生成报货单时才用它分组）。
    try {
      const created = await gateway.create(tableKey, values, { correlation });
      return { ok: true, recordId: String(created?.record_id || created?.recordId || '') };
    } catch (error) {
      error_(events.tableWriteFailed, {
        session_id: sessionId, batch_no: batchNo, idempotency_key: key,
        error: String(error?.message || error), request_id: correlation.request_id || undefined,
      });
      return reject('table_write_failed', texts.tableWriteFailed, { batch_no: batchNo });
    }
  };

  // ── ② 存草稿（本地那份 + 表侧那一行）────────────────────────────────────────
  /**
   * 存一份草稿。
   *
   * ⚠️ **双写，且以本地为准**（设计 §3.1）：本地那份是**提交要用的结构化草稿**，
   *   表侧那一行是**给她看的快照**。表写失败 ⇒ **不算存成功**（如实报 + 人话 ✓，
   *   本地那一份**留着**，她还能接着录 ⇒ 不静默当成功 ✗）。
   *
   * @param {object} input
   * @param {string} input.openId
   * @param {string} [input.supplierRecordId] `per_supplier` 口径下的分桶键（`single` 下只记录）
   * @param {Array}  input.items    草稿里的货品（形状 = 引擎 §4.3）
   * @param {string} [input.orderAmount] 退货那条链的整单金额（可空）
   * @param {string} [input.orderKey]    既有引擎那一轮的键（**只记不解**；拿不到就不带）
   * @param {string} [input.requestId]
   */
  const saveDraft = async ({
    openId, supplierRecordId = '', items = [], orderAmount = '', orderKey = '', chain = '', requestId = '',
  } = {}) => {
    const sessionId = String(idOf(openId) || '');
    const bucket = bucketOf({ openId, supplierRecordId });
    const normalized = (Array.isArray(items) ? items : []).map(normalizeItem);
    const lineCount = lineCountOf(normalized);
    if (!normalized.length) return reject('empty_draft', texts.emptyDraft);
    if (lineCount > config.maxLines) {
      return reject('too_many_lines', fill(texts.tooManyLines, { max: config.maxLines, count: lineCount }), {
        max: config.maxLines, count: lineCount, max_lines_env_key: config.maxLinesEnvKey,
      });
    }
    const keyOf = typeof options.keyOf === 'function'
      ? options.keyOf
      : () => config.concurrentKeyFallback;
    // 🔴 **得号 + 建行整段串行**（她两条逻辑的第 ① 条那个并发坑：两个草稿同时"都没有"）
    const run = () => queue.run(keyOf({ sessionId, bucket, openId }), async () => {
      const resolved = await resolveBatchNo({ sessionId, requestId });
      if (!resolved.ok) {
        warn(events.writeRejected, {
          session_id: sessionId, code: resolved.code, batch_no_policy: config.batchNoPolicy,
          request_id: requestId || undefined,
        });
        return resolved;
      }
      const table = await writeDraftRowToTable({
        batchNo: resolved.batchNo,
        sessionId,
        bucket,
        supplierRecordId,
        correlation: { request_id: requestId || undefined },
      });
      if (!table.ok) return table;

      const draftId = draftIdOf(sessionId, bucket);
      const existing = await store.get(draftId).catch(() => null);
      const previous = draftsOf(existing)[bucket] || null;
      // ⭐ `single` 下第二次存**覆盖**第一份 ⇒ **留痕**（`scan.draft.overwritten` ✓ 不许静默 ✗）
      if (previous) {
        info(events.overwritten, {
          session_id: sessionId, scope: config.scope, bucket, draft_id: draftId,
          previous_line_count: lineCountOf(previous.items),
          line_count: lineCount,
          previous_batch_no: previous.batch_no || '', batch_no: resolved.batchNo,
          request_id: requestId || undefined,
        });
      }
      const record = {
        draft_id: draftId,
        session_id: sessionId,
        open_id: String(openId || ''),
        chain: String(chain || previous?.chain || ''),
        status: 'draft',
        scope: config.scope,
        bucket,
        supplier_record_id: String(supplierRecordId || ''),
        order_key: String(orderKey || previous?.order_key || ''),
        order_amount: String(orderAmount ?? previous?.order_amount ?? ''),
        items: normalized,
        line_count: lineCount,
        batch_no: resolved.batchNo,
        // 这一份草稿**自己那一行**（表侧刚写的那一行）
        batch_record_id: table.recordId || '',
        // ⭐ "沿用自哪一行" —— 幂等的证据（(a) 那一支才有值；(b) 新建时为空 ✓）
        reused_batch_record_id: resolved.reused === true ? String(resolved.recordId || '') : '',
        batch_reused: resolved.reused === true,
        idempotency_key: draftRowKey(sessionId, bucket),
        created_at: previous?.created_at || now().toISOString(),
        updated_at: now().toISOString(),
        expires_at: new Date(now().getTime() + config.ttlMs).toISOString(),
      };
      const drafts = { ...draftsOf(existing), [bucket]: record };
      if (existing) await store.update(draftId, { drafts });
      else await store.create({ draft_id: draftId, drafts });
      info(events.saved, {
        session_id: sessionId, draft_id: draftId, scope: config.scope, bucket,
        line_count: lineCount, product_count: normalized.length,
        batch_no: record.batch_no, batch_reused: record.batch_reused,
        overwritten: Boolean(previous), ttl_ms: config.ttlMs,
        request_id: requestId || undefined,
      });
      return {
        ok: true,
        draftId,
        bucket,
        scope: config.scope,
        draft: record,
        summary: {
          line_count: lineCount,
          product_count: normalized.length,
          batch_no: record.batch_no,
          batch_reused: record.batch_reused,
          overwritten: Boolean(previous),
          message: previous ? fill(texts.overwritten, { scope: config.scope }) : '',
        },
      };
    });
    return run();
  };

  // ── ③ 找回（接着录）────────────────────────────────────────────────────────
  /** 把过期的那一份**归档而不是删除**（删掉就再也说不清"她那份去哪了" ✗）。 */
  const archiveExpired = async (draftId, record) => {
    const fileName = `${sanitizeKey(draftId)}.json`;
    const from = path.join(store.dir, fileName);
    const archiveDir = path.join(store.dir, config.archiveDirName);
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const to = path.join(archiveDir, `${sanitizeKey(draftId)}.${stamp}.json`);
    try {
      await fs.promises.mkdir(archiveDir, { recursive: true });
      await fs.promises.rename(from, to);
      return { archived: true, to, draft_id: draftId };
    } catch (error) {
      // 归档失败**不改判据**：文件还在原地（"文件仍在" ✓ 不抛 ✗），只如实记一条
      warn(events.expired, {
        draft_id: draftId, archive_failed: true, error: String(error?.message || error),
        expires_at: record?.drafts ? Object.values(record.drafts)[0]?.expires_at : undefined,
      });
      return { archived: false, error: String(error?.message || error) };
    }
  };

  /**
   * 读一份草稿（**找回**那一半）。
   *
   * 四种结果，**每一种都有人话**（"不清不响"是禁止的 ✗，设计 §6）：
   *   · `status: 'none'`    —— 没有草稿 ⇒ 与今天**逐字一致**（零回归；不建文件、不碰表 ✓）
   *   · `status: 'draft'`   —— 找到了 ⇒ `items` 尺码/数量/货品/供应商**逐字还在**、顺序不变 ✓
   *   · `status: 'expired'` —— 过期 ⇒ 归档 + 人话 + **不抛异常** ✓
   *   · `status: 'corrupt'` —— 坏 JSON ⇒ 人话 + **文件原地不动**（不删 ✗ 不抛 ✗）
   */
  const readDraft = async ({ openId, supplierRecordId = '', requestId = '' } = {}) => {
    const sessionId = String(idOf(openId) || '');
    const bucket = bucketOf({ openId, supplierRecordId });
    const draftId = draftIdOf(sessionId, bucket);
    let record = null;
    try {
      record = await store.get(draftId);
    } catch (error) {
      warn(events.corrupt, {
        session_id: sessionId, draft_id: draftId, error: String(error?.message || error),
        request_id: requestId || undefined,
      });
      return { ok: false, status: 'corrupt', draftId, message: texts.corrupt, error: String(error?.message || error) };
    }
    const drafts = draftsOf(record);
    const wanted = drafts[bucket] || null;
    if (!wanted) {
      info(events.missing, { session_id: sessionId, draft_id: draftId, scope: config.scope, request_id: requestId || undefined });
      return { ok: false, status: 'none', draftId, message: texts.missing };
    }
    const expiresAt = Date.parse(String(wanted.expires_at || ''));
    if (Number.isFinite(expiresAt) && expiresAt <= now().getTime()) {
      const archived = await archiveExpired(draftId, record);
      info(events.expired, {
        session_id: sessionId, draft_id: draftId, expires_at: wanted.expires_at,
        days: Math.round(config.ttlMs / (24 * 60 * 60 * 1000)), archived: archived.archived,
        request_id: requestId || undefined,
      });
      return {
        ok: false,
        status: 'expired',
        draftId,
        expired: wanted,
        archived,
        message: fill(texts.expired, { days: Math.round(config.ttlMs / (24 * 60 * 60 * 1000)) }),
      };
    }
    info(events.resumed, {
      session_id: sessionId, draft_id: draftId, scope: config.scope, bucket,
      line_count: wanted.line_count ?? lineCountOf(wanted.items),
      batch_no: wanted.batch_no || '', request_id: requestId || undefined,
    });
    return { ok: true, status: 'draft', draftId, bucket, draft: wanted };
  };

  /** 把草稿喂给渲染层（**S2 接**）。本刀只提供"算好的那一个视图补丁"，不改视图形状。 */
  const planView = async ({ openId, view = {}, supplierRecordId = '', requestId = '' } = {}) => {
    if (config.enabled !== true) return { ok: false, status: 'disabled', view, draft: null };
    const loaded = await readDraft({ openId, supplierRecordId, requestId });
    if (!loaded.ok || loaded.status !== 'draft') {
      // ⭐ 没有草稿（或过期 / 坏格式）⇒ **视图一个字都不改**（零回归的物理保证 ✓）
      return { ok: false, status: loaded.status, view, draft: loaded.draft || null, message: loaded.message };
    }
    const items = Array.isArray(loaded.draft.items) ? loaded.draft.items : [];
    return { ok: true, status: 'draft', draft: loaded.draft, message: '', view: { ...view, multi_items: items } };
  };

  /**
   * 丢掉一份草稿（她点【不管它，重新开一单】才会走到；⚠️ "删/留"**她还没拍**，
   * 所以本方法**只归档不删除** —— 与过期同一条纪律 ✓）。
   */
  const discardDraft = async ({ openId, supplierRecordId = '', requestId = '' } = {}) => {
    const sessionId = String(idOf(openId) || '');
    const bucket = bucketOf({ openId, supplierRecordId });
    const draftId = draftIdOf(sessionId, bucket);
    const record = await store.get(draftId).catch(() => null);
    const wanted = draftsOf(record)[bucket] || null;
    if (!wanted) return { ok: false, status: 'none', draftId, message: texts.missing };
    const archived = await archiveExpired(draftId, record);
    info(events.discarded, {
      session_id: sessionId, draft_id: draftId, discarded: true, archived: archived.archived,
      request_id: requestId || undefined,
    });
    return { ok: true, status: 'discarded', draftId, archived, draft: wanted };
  };

  return {
    // 存 / 读 / 丢
    saveDraft,
    readDraft,
    planView,
    discardDraft,
    // 只读暴露（S2/S3 与用例要用；也便于排查）
    findPendingBatch,
    resolveBatchNo,
    bucketOf,
    draftIdOf,
    draftRowKey,
    store,
    config,
    events,
    texts,
    tableKey,
    statusFieldKey,
    statusValue,
    /** 供应商拆分**未决**（她还没拍"拆成几单/几个批次号"）—— 如实暴露，别当它已定 ✗ */
    supplierSplit,
  };
};

module.exports = {
  createScanDraftService,
  fill,
  lineCountOf,
  normalizeItem,
  sanitizeKey,
  positiveInteger,
  UNSPECIFIED_SUPPLIER,
};
