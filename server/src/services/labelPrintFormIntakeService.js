/**
 * 「批量打印」飞书表单 → 自动打印（2026-11-09 业务负责人定的链路）。
 *
 * 链路：
 *   她填「批量打印」表单 → 写「标签打印」表 → 飞书 bitable 记录变更事件
 *     → `routes/larkEvents.js` 按 **table_id** 分派到本 service
 *     → 读这条记录的「打印货号」（单向关联「货品信息」，可多选）
 *     → **每个货号各打各的**：按记录 ID 让既有队列出**恰好那一张**（`labelForRecord`）
 *     → 店里那台电脑从队列领任务、出纸。
 *
 * 业务口径（业务负责人 2026-11-09，逐字/确认；数字与文案都在 `config/labelPrintForm.js`）：
 *   · 一条表单记录勾多个货号 ⇒ 每个货号各打各的（**一个失败不拖累其他**）；
 *   · 坏货号（没编号 / 没库存 / 记录没了）⇒ **跳过**，其他照打；
 *   · 失败 / 跳过 ⇒ **同一条表单记录汇总成一条**通知（运营群）；
 *   · 临时错误**重试 3 次**（首次失败后再试 3 次）；永久错误不重试；
 *   · 店里电脑离线 ⇒ 任务在队列里排队、电脑上线自动补打（**不判失败**）；
 *   · 「打印日」是飞书自动字段，**代码一行都不写**（本 service 没有任何写表路径）。
 *
 * ✅ 只读+入队：本 service 只 `gateway.get` 读一条表单记录，然后调既有打印队列；
 *    不写「标签打印」表、也不写任何业务表。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { LABEL_FORM_INTAKE } = require('../config/labelPrintForm');
const { classifyThrownError, retryDelayMs } = require('../config/asyncJobs');
const { logError, logInfo, logWarn } = require('../utils/logger');
// ⭐ 2026-11-11：读表单记录遇到飞书 1254607 等瞬时错误 ⇒ 复用项目已有的小退避重试。
const { withTransientRetry, resolveTransientRetryConfig } = require('../config/pushRetry');

/** 把配置模板里的 `{name}` 占位符换成值（认不出的占位符原样保留）。 */
const fill = (template, values = {}) => String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

/**
 * 关联字段（「打印货号」）→ 货品记录 ID 列表。
 *
 * 飞书「单向关联」读回来是数组，每项形如 `{ record_ids: ['rec…'], text: '…' }`；
 * 兼容数组/字符串两种历史形状（认不出的形状**不猜**：跳过并留日志）。
 */
const linkRecordIdsOf = (value) => {
  const ids = [];
  const push = (id) => {
    const text = String(id ?? '').trim();
    if (text) ids.push(text);
  };
  const walk = (item) => {
    if (item === null || item === undefined) return;
    if (typeof item === 'string') return push(item);
    if (Array.isArray(item)) return item.forEach(walk);
    if (Array.isArray(item.record_ids)) item.record_ids.forEach(push);
    else if (item.recordId) push(item.recordId);
    else if (item.id) push(item.id);
  };
  walk(value);
  return [...new Set(ids)];
};

/** 上海时间（她看的时间；服务器是 UTC，不换算会让她对不上）。 */
const shanghaiTimeText = (ms) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toISOString();
  }
};

const createLabelPrintFormIntakeService = (deps = {}) => {
  const config = deps.config || LABEL_FORM_INTAKE;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = {
    info: deps.logInfo || logInfo,
    warn: deps.logWarn || logWarn,
    error: deps.logError || logError,
  };
  const transientRetry = deps.transientRetry || resolveTransientRetryConfig();

  let gateway = deps.gateway || null;
  let queue = deps.queue || null;
  let notifications = deps.notifications || null;
  // 惰性取依赖：只 require app.js 的用例不会因此建目录 / 建 gateway / 读凭证。
  const resolveGateway = () => {
    if (!gateway) {
      const { V1BitableGateway } = require('./v1BitableGateway');
      gateway = new V1BitableGateway();
    }
    return gateway;
  };
  const resolveQueue = () => {
    if (!queue) queue = require('./labelPrintQueueRuntime').getLabelPrintQueue();
    return queue;
  };
  const resolveNotifications = () => {
    if (!notifications) {
      const { createDefaultNotificationService } = require('./notificationService');
      notifications = createDefaultNotificationService();
    }
    return notifications;
  };

  // 同一条表单记录的本地去重（飞书事件可能重投；窗口内重复投递不再处理、不再通知）。
  const processed = new Map();
  const alreadyProcessed = (recordId) => {
    const hit = processed.get(recordId);
    if (!hit) return false;
    if (config.dedupeTtlMs > 0 && now() - hit.at > config.dedupeTtlMs) {
      processed.delete(recordId);
      return false;
    }
    return true;
  };

  const tableOf = () => {
    const table = V1_BITABLE_SCHEMA.tables.labelPrintRequest;
    if (!table || !table.tableId) {
      throw new Error('未配置「标签打印」表（FEISHU_V1_LABEL_PRINT_REQUEST_TABLE_ID）');
    }
    return table;
  };

  /** 读一条「标签打印」记录（只读）。瞬时错误（1254607 等）自动小退避重试。 */
  const readRecord = async (recordId) => {
    const record = await withTransientRetry(
      () => resolveGateway().get('labelPrintRequest', recordId, { retry: false }),
      {
        operation: 'label_print.form.record_read',
        config: transientRetry,
        onRetry: ({ attempt, delayMs, error: retryError }) => log.warn('label_print.form.record_read_retry', {
          form_record_id: recordId,
          attempt,
          delay_ms: delayMs,
          error: String(retryError?.message || ''),
        }),
      },
    );
    if (!record) throw new Error(`「标签打印」里找不到记录 ${recordId}`);
    return record;
  };

  /** 把**一个货号**排进打印队列；临时错误重试，永久错误交给调用方分类。 */
  const enqueueOne = async ({ formRecordId, productRecordId }) => {
    const submitKey = `${config.submitKeyPrefix}:${formRecordId}:${productRecordId}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await resolveQueue().enqueueSingle({
          recordId: productRecordId,
          source: config.queueSource,
          submitKey,
        });
        return { ok: true, reused: result?.reused === true, result };
      } catch (error) {
        const classified = classifyThrownError(error);
        // 400 = 她的数据问题（没编号 / 没库存 / 记录没了）⇒ 跳过，不重试。
        if (Number(error?.statusCode) === 400) {
          return { ok: false, kind: 'skipped', reason: classified.message, statusCode: 400 };
        }
        const canRetry = classified.retryable && attempt <= config.retries;
        if (!canRetry) {
          return {
            ok: false, kind: 'failed', reason: classified.message, attempts: attempt,
            exhausted: classified.retryable === true,
          };
        }
        log.warn('label_print.form.retry', {
          form_record_id: formRecordId,
          product_record_id: productRecordId,
          attempt,
          retries: config.retries,
          error: classified.message,
        });
        await sleep(retryDelayMs(attempt));
      }
    }
  };

  /** 同一条表单记录汇总**一条**通知（只在有跳过 / 失败时发）。 */
  const notifySummary = async ({ recordId, outcomes, numbers, queued }) => {
    const texts = config.texts;
    const skipped = outcomes.filter((item) => !item.ok && item.kind === 'skipped');
    const failed = outcomes.filter((item) => !item.ok && item.kind === 'failed');
    const lines = [
      texts.title,
      fill(texts.header, { recordId, total: outcomes.length }),
    ];
    if (numbers.length) {
      const shown = numbers.slice(0, config.notifyMaxItems).join(texts.listSeparator);
      lines.push(fill(texts.queued, { count: numbers.length, items: shown }));
    }
    if (skipped.length) {
      lines.push(fill(texts.skipped, { count: skipped.length, items: describeItems(skipped, texts) }));
    }
    if (failed.length) {
      lines.push(fill(texts.failed, { count: failed.length, items: describeItems(failed, texts) }));
      const exhausted = failed.filter((item) => item.exhausted === true).length;
      if (exhausted) lines.push(fill(texts.retriedNote, { count: exhausted, retries: config.retries }));
    }
    if (queued.length === 0 && skipped.length === 0 && failed.length === 0) {
      lines.push(fill(texts.emptySelection, { recordId }));
    }
    lines.push(fill(texts.time, { time: shanghaiTimeText(now()) }));

    try {
      await resolveNotifications().send(config.notificationEvent, { lines });
    } catch (error) {
      log.warn('label_print.form.notify_failed', { form_record_id: recordId, error: error.message });
    }
    return lines;
  };

  /** 一条货号在通知里的样子：编号 / 记录 ID ＋ 原因。 */
  const describeItems = (items, texts) => {
    const list = items.slice(0, config.notifyMaxItems).map((item) => {
      const label = item.number || item.productRecordId;
      return item.reason ? `${label}${texts.reasonSeparator}${item.reason}` : String(label);
    });
    if (items.length > config.notifyMaxItems) {
      list.push(fill(texts.moreItems, { count: items.length - config.notifyMaxItems }));
    }
    return list.join(texts.listSeparator);
  };

  /** 处理一条表单记录（幂等：同一条记录在去重窗口内只处理一次）。 */
  const processRecord = async (recordId) => {
    if (alreadyProcessed(recordId)) {
      log.info('label_print.form.duplicate_skipped', { form_record_id: recordId });
      return { recordId, duplicate: true, outcomes: [] };
    }
    const table = tableOf();
    const record = await readRecord(recordId);
    const productIds = linkRecordIdsOf(record?.fields?.[table.fields.product]);
    log.info('label_print.form.received', {
      form_record_id: recordId,
      product_count: productIds.length,
    });
    if (!productIds.length) {
      processed.set(recordId, { at: now() });
      const lines = await notifySummary({ recordId, outcomes: [], numbers: [], queued: [] });
      return { recordId, outcomes: [], notified: true, lines };
    }

    const outcomes = [];
    const numbers = [];
    for (const productRecordId of productIds) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await enqueueOne({ formRecordId: recordId, productRecordId });
      const enriched = {
        productRecordId,
        number: outcome.result?.numbers?.[0] || '',
        ...outcome,
      };
      outcomes.push(enriched);
      if (enriched.ok) numbers.push(enriched.number || productRecordId);
      log.info('label_print.form.item', {
        form_record_id: recordId,
        product_record_id: productRecordId,
        ok: enriched.ok === true,
        kind: enriched.kind,
        reused: enriched.reused === true,
        attempts: enriched.attempts,
        error: enriched.ok ? undefined : enriched.reason,
      });
    }

    processed.set(recordId, { at: now() });
    const queued = outcomes.filter((item) => item.ok);
    const needsNotify = outcomes.some((item) => !item.ok);
    let lines = null;
    if (needsNotify) {
      lines = await notifySummary({ recordId, outcomes, numbers, queued });
    }
    log.info('label_print.form.processed', {
      form_record_id: recordId,
      total: outcomes.length,
      queued: queued.length,
      skipped: outcomes.filter((item) => item.kind === 'skipped').length,
      failed: outcomes.filter((item) => item.kind === 'failed').length,
      notified: needsNotify || undefined,
    });
    return {
      recordId, outcomes, queued: queued.length, notified: needsNotify, lines,
    };
  };

  /**
   * 飞书表变更事件入口（只认「新增」动作；删除 / 编辑不触发打印）。
   * ⚠️ 每条记录单独处理；一条失败不影响同一批里的其它记录（各自 catch）。
   */
  const handleTableChanges = async (actionList = []) => {
    const actions = Array.isArray(actionList) ? actionList : [];
    const recordIds = [];
    for (const action of actions) {
      const name = String(action?.action || '').trim();
      const recordId = String(action?.record_id || '').trim();
      if (!recordId) continue;
      if (!config.triggerActions.includes(name)) continue;
      recordIds.push(recordId);
    }
    if (!recordIds.length) {
      log.info('label_print.form.ignored', { action_count: actions.length });
      return { processed: 0, results: [] };
    }
    const results = [];
    for (const recordId of [...new Set(recordIds)]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        results.push(await processRecord(recordId));
      } catch (error) {
        log.error('label_print.form.record_failed', { form_record_id: recordId, error: error.message });
        results.push({ recordId, error: error.message });
      }
    }
    return { processed: results.length, results };
  };

  return {
    handleTableChanges,
    processRecord,
    // 纯函数导出（用例直接跑；也让"关联字段怎么解析"只有一处实现）。
    linkRecordIdsOf,
  };
};

module.exports = { createLabelPrintFormIntakeService, linkRecordIdsOf, shanghaiTimeText };
