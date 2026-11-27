'use strict';

/**
 * 采购页**提交**（供应 → 录单 → 采购 → 点「提交」）——
 * 一个模块只干一件事：把页面交上来的 items 变成既有采购链路能吃的**一次提交**。
 *
 * 🔴 复用既有链路（不新建写库路径 / 不新建草稿表）：
 *   · 校验 + 批量落库：`services/multiItemOrderService.js`（`validateDraft` / `submitDraft`），
 *     它的 `writers.purchase` 就是 `PurchaseWebhookService.publishPurchaseRequest`（既有采购批次 + 明细）；
 *   · 草稿种子写进**既有** `scanWriteService.sessions`（`data/scan_sessions/` 那个 store，与引擎同一容器）；
 *   · 「后台那一跑」用既有 `purchaseWriteBackgroundService.scheduleCustomRest`（不另造后台件）。
 *
 * 🔴 三条硬要求：
 *   ① **同步校验**（提交键 / items 形状 / 尺码 / 数量 / 重复 / 20 货品 / 50 行 / 货品存在）——
 *      全部在**排后台之前**；不通过 ⇒ 400 + 人话 + **零写入**；
 *   ② **异步成功口径**：先回 `accepted` + 「已提交成功，数据会更新」；后台失败记 warn + 落会话 `last_error`
 *      （引擎自己写；绝不假装成功）；
 *   ③ **幂等**：`submitKey` 原样传给 `submitDraft`（taskId / 明细幂等键都由它派生）；
 *      同一把键重复提交 ⇒ 草稿已 `submitted` ⇒ 直接返回 `reused`，不再排后台、不再写一次。
 *
 * ⚠️ 供应商由**服务端权威反查**（按 `product_record_id` 批量读货品信息），不信页面传值；
 *    这样既有 supplierSplit（按供应商分组）拿到的就是货品信息上的真实供应商。
 */

const { createMultiItemOrderService } = require('./multiItemOrderService');
const { resolveMultiItemOrderConfig } = require('../config/multiItemOrder');
const { createPurchaseWriteBackgroundService } = require('./purchaseWriteBackgroundService');
// #948：统一异步任务（重试 / 最终失败发运营群）
const { createAsyncJobPurchaseRunner } = require('./asyncJobPurchaseRunner');
const { getAsyncJobService } = require('./asyncJobRuntime');
const { PROCUREMENT_PAGE } = require('../config/procurementPage');
const { SCAN_WRITE } = require('../config/scanWrite');
const { ASYNC_JOBS } = require('../config/asyncJobs');
const { SUBMIT_TOAST } = require('../config/submitToast');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { createProcurementPurchaseWriters } = require('./procurementPurchaseWriters');
const { createProductEnricher } = require('./procurementProductEnricher');
const { createProcurementSubmissionIndex } = require('./procurementSubmissionIndex');
const { logInfo, logWarn } = require('../utils/logger');
const { groupItemsBySupplier } = require('./supplierSubmissionSplit');

const reject = (code, message) => ({ ok: false, code, message });


const createProcurementPageSubmitService = (options = {}) => {
  const gateway = options.gateway || null;
  const schema = options.schema || V1_BITABLE_SCHEMA;
  const config = options.config || PROCUREMENT_PAGE;
  const orderConfig = options.orderConfig || resolveMultiItemOrderConfig();
  const writeService = options.writeService || null;
  const now = options.now || (() => Date.now());
  const logger = options.logger || { logInfo, logWarn };
  const submissionIndex = options.submissionIndex || createProcurementSubmissionIndex();
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  const background = options.background || createPurchaseWriteBackgroundService({
    // 失败日志里的提示语也走**注入的配置**（本件不写中文 ✗）
    config: {
      ...SCAN_WRITE,
      texts: {
        ...(SCAN_WRITE.texts || {}),
        backgroundFailedNotified: ASYNC_JOBS.texts.hints.backgroundFailedNotified,
      },
    },
    // 统一异步任务：重试 + 失败通知；用例注入 `options.background` 时不建
    jobRunner: options.jobRunner !== undefined
      ? options.jobRunner
      : createAsyncJobPurchaseRunner({
        asyncJob: options.asyncJobs !== undefined ? options.asyncJobs : getAsyncJobService(),
      }),
  });
  if (!writeService || !writeService.sessions) throw new Error('procurementPageSubmitService 需要 scanWriteService');

  const sessions = writeService.sessions;
  const chainConfig = orderConfig.chains[config.draft.chain];
  if (!chainConfig) throw new Error(`未声明的采购链：${config.draft.chain}`);
  // 🔴 写入件**形状适配层**（Bug-1 修复）：引擎传扁平 payload，既有写入件要 task.draft。
  //    适配层只建/更新本地 task + 转调既有 `publishPurchaseRequest`，不新开写库路径。
  const writers = options.writers || createProcurementPurchaseWriters({ gateway, writeService, config });
  const enricher = options.enricher || createProductEnricher({ gateway, schema, logger });
  const engine = options.engine || createMultiItemOrderService({
    sessions, config: orderConfig, writers,
  });
  const submitKeyOf = (raw) => {
    const text = String(raw ?? '').trim();
    if (text.length < config.limits.minSubmitKeyLength || text.length > config.limits.maxSubmitKeyLength) return '';
    return /^[A-Za-z0-9:_-]+$/.test(text) ? text : '';
  };

  /**
   * 页面 items → 引擎草稿 items（货品字段由服务端按 record_id 权威反查）。
   * 🔴 反查结果走 `procurementProductEnricher` 归一化（Bug-2）：`getBatch` 的形状与列表接口不同，
   *    直接读会把 `[object Object]` 写进 payload、把颜色读成空串。
   */
  const buildItems = async (items) => {
    const wanted = items.map((item) => String(item?.productRecordId ?? item?.product_record_id ?? '').trim());
    const byId = await enricher.enrich(wanted);
    const built = [];
    for (let index = 0; index < items.length; index += 1) {
      const productRecordId = wanted[index];
      const product = byId.get(productRecordId);
      if (!product) return { ok: false, missing: productRecordId };
      const rawSource = String(items[index]?.source || '').trim();
      built.push({
        product_record_id: productRecordId,
        // ⭐ 2026-11-09：页面来源（new / replenish）；旧载荷没带 ⇒ ''（回填按补货口径处理，见回填服务）
        source: rawSource === 'new' || rawSource === 'replenish' ? rawSource : '',
        number: product.number,
        item_no: product.itemNo,
        color: product.color,
        supplier_record_id: product.supplierRecordId,
        entries: (Array.isArray(items[index]?.entries) ? items[index].entries : []).map((entry) => ({
          size: entry?.size, quantity: entry?.quantity,
        })),
      });
    }
    return { ok: true, items: built };
  };

  /**
   * 提交一次。返回 `{ ok, accepted, reused, message }` 或 `{ ok:false, code, message }`（人话）。
   */
  const submit = async ({ openId, submitKey: rawKey, items = [], requestId = '' } = {}) => {
    const submitKey = submitKeyOf(rawKey);
    if (!submitKey) return reject('submit_key_invalid', config.texts.submitKeyInvalid);
    if (!String(openId || '').trim()) return reject('not_authenticated', config.texts.submitFailed);
    if (!Array.isArray(items) || !items.length) return reject('empty_items', config.texts.itemInvalid);
    if (items.length > config.limits.maxRequestItems) return reject('too_many_items', config.texts.itemInvalid);
    const malformed = items.some((item) => !String(item?.productRecordId ?? item?.product_record_id ?? '').trim()
      || !Array.isArray(item?.entries));
    if (malformed) return reject('item_invalid', config.texts.itemInvalid);

    const built = await buildItems(items);
    if (!built.ok) return reject('product_missing', config.texts.productMissing);

    const grouped = groupItemsBySupplier(built.items).map((group) => ({
      ...group,
      orderKey: config.draft.orderKeyPrefix + ':' + engine.sanitizeKey(submitKey) + ':' + group.key,
      submitKey: submitKey + ':' + group.key,
    }));
    const ordersField = config.draft.ordersField;
    const sessionId = sessions.idOf(openId);
    const existingSession = await sessions.store.get(sessionId);
    const existingOrders = (existingSession && existingSession[ordersField]) || {};
    const allSubmitted = grouped.every((group) => (
      existingOrders[group.orderKey]?.status === orderConfig.session.submittedStatus
    ));
    if (allSubmitted) {
      info(config.events.submitAccepted, {
        request_id: requestId, open_id: String(openId || ''), submit_key: submitKey, reused: true,
      });
      return { ok: true, accepted: true, reused: true, message: SUBMIT_TOAST.text };
    }

    const timestamp = new Date(now()).toISOString();
    const drafts = grouped.map((group) => {
      const draft = {
        chain: chainConfig.id,
        open_id: String(openId || ''),
        created_at: existingOrders[group.orderKey]?.created_at || timestamp,
        updated_at: timestamp,
        submit_key: group.submitKey,
        order_key: group.orderKey,
        items: group.items,
        order_amount: '',
        batch_record_id: '',
        batch_no: '',
        detail_ids: [],
        status: orderConfig.session.draftStatus,
        chain_prefix: chainConfig.orderKeyPrefix,
      };
      return { group, draft, checked: engine.validateDraft({ draft, chainConfig }) };
    });
    const invalid = drafts.find((plan) => plan.checked.ok !== true);
    if (invalid) {
      info(config.events.submitRejected, {
        request_id: requestId, open_id: String(openId || ''), submit_key: submitKey, code: invalid.checked.code,
      });
      return reject(invalid.checked.code, invalid.checked.message);
    }

    let behavior = {};
    try {
      behavior = await writers.behavior(chainConfig.id);
    } catch (error) {
      warn(config.events.submitRejected, {
        request_id: requestId, submit_key: submitKey, code: 'behavior_missing', error: String(error?.message || error),
      });
      return reject('behavior_missing', config.texts.submitFailed);
    }

    await sessions.ensure(openId);
    let totalProducts = 0;
    let totalLines = 0;
    for (const plan of drafts) {
      if (existingOrders[plan.group.orderKey]?.status === orderConfig.session.submittedStatus) continue;
      const { group, draft, checked } = plan;
      totalProducts += group.items.length;
      totalLines += checked.normalized.lineCount;
      await sessions.store.update(sessionId, (session) => {
        const orders = { ...((session || {})[ordersField] || {}) };
        orders[group.orderKey] = draft;
        return { [ordersField]: orders, updated_at: timestamp };
      });
      background.scheduleCustomRest({
        chain: chainConfig.id,
        requestId,
        submitKey: group.submitKey,
        context: { orderKey: group.orderKey },
        jobMeta: { ownerOpenId: openId, step: ASYNC_JOBS.texts.stepLabels.procurementPageReplenish },
        run: async () => {
          const result = await engine.submitDraft({
            openId, chain: chainConfig.id, orderKey: group.orderKey, submitKey: group.submitKey, requestId,
            behavior: { recordId: behavior.recordId || '', kind: chainConfig.behaviorCode || '' },
          });
          if (result?.ok === true && result?.purchase?.batch_no) {
            await submissionIndex.record({
              openId,
              batchNo: result.purchase.batch_no,
              submittedAt: new Date(now()).toISOString(),
              requestIds: result.purchase.request_ids || [],
            }).catch((error) => {
              warn('procurement.submission_index.record_failed', {
                batch_no: result.purchase.batch_no, error: String(error?.message || error), request_id: requestId,
              });
            });
          }
          return result;
        },
      });
    }
    info(config.events.submitAccepted, {
      request_id: requestId,
      open_id: String(openId || ''),
      submit_key: submitKey,
      products: totalProducts,
      lines: totalLines,
      supplier_groups: grouped.length,
      reused: false,
    });
    return { ok: true, accepted: true, reused: false, message: SUBMIT_TOAST.text };
  };

  return { submit, submitKeyOf };
};

module.exports = { createProcurementPageSubmitService };
