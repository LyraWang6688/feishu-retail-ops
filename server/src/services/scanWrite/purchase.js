'use strict';

/**
 * scanWrite 的采购补货 / 采购退货域（阶段 4 从 `scanWriteService.js` 搬出）。
 * 只搬不改：写入仍走既有采购业务件，本文件不直接写业务表。
 */
const { fillText } = require('../../config/scanWrite');
const { REPORT_BEHAVIOR } = require('../purchaseBehaviorPolicy');
const { linkedRecordIds, textValue } = require('../v1BitableGateway');
const { logInfo } = require('../../utils/logger');

const createScanWritePurchase = ({
  config, texts, schema, sessionKeyOf, queue, sessions,
  fail, userMessageFor, positiveInteger, resolveProductRecord, productNumber,
  references, purchaseStore, purchase, purchaseReturn,
}) => {
  const replenishFingerprint = ({ productRecordId = '', number = '', entries = [] } = {}) => {
    const lines = (Array.isArray(entries) ? entries : [])
      .map((item) => `${Number(item?.size)}x${Number(item?.quantity)}`)
      .sort()
      .join(',');
    return [String(productRecordId || '').trim(), String(number || '').trim(), lines].join('|');
  };

  const submitReplenish = async ({ openId, submitKey, productRecordId = '', number = '', entries = [], requestId = '', sessionKey = '' }) => {
    // ⭐⭐ 2026-10-18（task-2 会话按页面/设备隔离）：**可选**的会话键（与 addSaleLine / submitSale 同一个机制）。
    //   · 不传 ⇒ 会话键 = openId ⇒ **改前行为逐字不变** ✓；
    //   · 传了（扫码页 per-page token 那条路）⇒ 会话按它分；`openId` 仍然只当**操作人**（写进草稿里的
    //     `operator_open_id` / 日志里的 `open_id`）。
    const sessionId = sessionKeyOf(openId, sessionKey);
    return queue.run(`sale:${sessionId}`, async () => {
    if (!config.replenish.enabled) {
      return fail({ code: 'disabled', message: texts.writeDisabledBody, requestId });
    }
    let current = await sessions.get(sessionId);
    // ⚠️ **扫开就直接补货**是完全正常的用法（她从没点过「加入本单」）⇒ 会话还没建。
    //    这时页面上的补货键就是第 1 轮那把（`submitKeyFor` 纯函数算出来的），建出来即对上。
    if (!current) current = await sessions.ensure(sessionId);
    // 🔴 2026-10-12：与销售那条链同样的坑 —— 过期不该是死路 ⇒ **续上**（草稿/键都保留）
    if (current.expired) {
      logInfo(config.events.sessionExpired, {
        session_id: current.session_id, open_id: String(openId || ''), reason: 'revived_on_replenish',
        request_id: requestId,
      });
      current = await sessions.revive(sessionId, { submitKey: String(submitKey || '').trim(), flow: 'replenish' });
    }
    const replenish = current.replenish || {};
    let key = String(submitKey || '').trim();
    const completed = replenish.completed || [];
    const fingerprint = replenishFingerprint({ productRecordId, number, entries });
    const done = completed.find((item) => item.key === key);
    // ⚠️ 只有**同一份草稿**才算重放（`fingerprint` 相同）；换了货号 / 加了行 / 改了数量 ⇒ 新的一次 ✓
    if (done && (done.fingerprint === undefined || done.fingerprint === fingerprint)) {
      logInfo(config.events.replenishReused, {
        session_id: current.session_id, submit_key: key, batch_no: done.batch_no, request_id: requestId,
      });
      return {
        ok: true, reused: true, batch_no: done.batch_no, request_count: done.request_count,
      };
    }
    if (replenish.key !== key) {
      const last = completed[completed.length - 1];
      // ⚠️ 同样是"**同一份草稿**才当重放"：她换了货号 ⇒ 这一把旧键**不该吸收** ✗
      //    ⇒ 换成会话**当前**那把键，继续走正常提交（批次照建 ✓）。
      if (last && last.fingerprint === fingerprint) {
        logInfo(config.events.replenishReused, {
          session_id: current.session_id, submit_key: key, stale: true, batch_no: last.batch_no,
          request_id: requestId,
        });
        return { ok: true, reused: true, stale: true, batch_no: last.batch_no, request_count: last.request_count };
      }
      if (!last) {
        return fail({ code: 'session_expired', message: texts.replenishAgainBody, requestId });
      }
      logInfo(config.events.replenishRegenerated, {
        session_id: current.session_id, submit_key: key, effective_submit_key: replenish.key,
        request_id: requestId, reason: 'draft_changed',
      });
      key = replenish.key;
    }

    // ① 校验：勾了哪些尺码、每个几双（勾了不填数量按 1 双 —— 每条明细至少一双）。
    const picked = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const size = positiveInteger(entry?.size);
      if (size === null) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'size_unknown', message: userMessageFor(error), requestId, error });
      }
      const rawQuantity = String(entry?.quantity ?? '').trim();
      const quantity = rawQuantity ? positiveInteger(rawQuantity) : config.replenish.defaultQuantity;
      if (quantity === null || quantity > config.replenish.maxQuantity) {
        const message = fillText(texts.quantityInvalidBody, { max: config.replenish.maxQuantity });
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({ code: 'quantity_invalid', message, requestId, error });
      }
      picked.push({ size, quantity });
    }
    if (!picked.length) {
      const error = new Error(texts.replenishNoneBody);
      error.scanUserMessage = texts.replenishNoneBody;
      return fail({ code: 'replenish_empty', message: userMessageFor(error), requestId, error });
    }
    if (picked.length > config.replenish.maxSizes) {
      const message = fillText(texts.replenishTooManyBody, { max: config.replenish.maxSizes });
      const error = new Error(message);
      error.scanUserMessage = message;
      return fail({ code: 'replenish_too_many', message, requestId, error });
    }

    try {
      // ② 货品 + 供应商 + 采购行为：**全部来自既有表**（供应商取「货品信息.供应商」，
      //    那条文字报单链路退场之前取的也是**同一个字段** ⇒ 出图分组口径没变）。
      const product = await resolveProductRecord({ productRecordId, number });
      if (!product) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'product_missing', message: userMessageFor(error), requestId, error });
      }
      const productId = product.record_id || productRecordId;
      const productFields = schema.tables.product.fields;
      const supplierRecordId = linkedRecordIds(product.fields?.[productFields.supplier])[0] || '';
      const behavior = await references.resolveBehavior(config.replenish.behaviorCode);
      const itemNo = textValue(product.fields?.[productFields.itemNo]).trim();
      const color = textValue(product.fields?.[productFields.color]).trim();
      const items = picked.map(({ size, quantity }) => ({
        product_record_id: productId,
        product_number: productNumber(product),
        item_no: itemNo,
        color,
        size,
        quantity,
        // 供应商只用于"按供应商出图"（既有链路的分组依据），不从扫码页另立一套。
        supplier_record_id: supplierRecordId,
        // ⛔ 2026-10-09：这里原有 `report_record_id: ''`（"扫码补货没有报单记录 ⇒ 留空"）
        //   —— 「信息填写」整表被删之后，**报单记录这个身份彻底不存在了**，
        //   计划（`ensurePostingPlan`）里那个字段也一起删了 ⇒ 不再往下传。
        behavior_record_id: behavior.recordId,
        behavior_kind: REPORT_BEHAVIOR.PURCHASE_REQUEST,
      }));
      const draft = {
        // ⚠️ 2026-10-09：`is_batch: true` 保留着 —— 它只是"这一次提交是**一批**明细"的标记，
        //   走同一条计划/幂等代码；原先那两行 `report_record_id` / `report_record_ids`
        //   （报单记录清单）**已删除**：报单记录这个身份随「信息填写」退场消失了，
        //   "回写报单记录状态"那一步在 `confirmPurchaseRequest` 里也整段删掉了。
        is_batch: true,
        product_record_id: productId,
        product_number: productNumber(product),
        supplier_record_id: supplierRecordId,
        behavior_record_id: behavior.recordId,
        operator_open_id: openId,
        items,
      };
      // task id 由**这一次提交的幂等键**推出来 ⇒ 重放同一个键 = 同一个 task
      // ⇒ 采购申请 / 报货批次在主键上命中既有记录（`createOnceByKey`），只写一次。
      // ⭐ 2026-10-18：task id 加**会话代次** —— 远端「采购批次」的幂等键由 task id 推出；
      //   只带「会话 id + 轮次」会跨天撞历史键（成功页但零新写入）。同一会话内重试代次不变 ⇒ 仍幂等。
      const generation = String(current?.generation || '').trim() || 'legacy';
      const taskId = `${config.replenish.taskIdPrefix}_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}_${generation}`;
      const existingTask = await purchaseStore.get(taskId).catch(() => null);
      const task = existingTask || await purchaseStore.create({
        task_id: taskId, kind: 'scan_replenish', status: 'posting', draft,
      });
      logInfo(config.events.replenishSubmitting, {
        session_id: current.session_id, submit_key: key, task_id: taskId,
        line_count: items.length, supplier_record_id: supplierRecordId, request_id: requestId,
      });
      const result = await purchase().publishPurchaseRequest(taskId, task);
      const summary = {
        batch_no: result?.batch_no || '',
        batch_record_id: result?.batch_record_id || '',
        request_count: (result?.request_ids || []).length,
      };
      await sessions.completeReplenish(sessionId, { key, result: summary, fingerprint });
      logInfo(config.events.replenishSubmitted, {
        session_id: current.session_id, submit_key: key, task_id: taskId, ...summary,
        request_id: requestId,
      });
      return { ok: true, reused: false, ...summary };
    } catch (error) {
      const message = userMessageFor(error);
      await sessions.markReplenishFailed(sessionId, String(error.message || error)).catch(() => undefined);
      return fail({ code: 'replenish_write_failed', message, requestId, error });
    }
    });
  };

  // ── 采购退货：勾尺码 + 数量 → 采购退货（**与补货同形**；写库/扣库存/出图都在既有构件里）──
  /**
   * 生成采购退货（业务负责人 2026-10-11：「和"报货"逻辑一样，也走扫码」）。
   *
   * 本方法只做四件事：**会话 / 幂等 / 校验 / 说人话**；真正的写入交给
   * `services/purchaseReturnService.js`（它又只调既有的批次服务 / `createOnceByKey` /
   * `InventoryService.applyPurchaseReturn` / 既有出图链路）。
   *
   * @param {object} input
   * @param {Array<{size:number|string, quantity:number|string}>} input.entries 勾选的尺码与退货数量
   * @returns {Promise<object>} 成功时带 `batch_no / request_count / taken_count / shortfall / shortfalls`
   */
  const submitPurchaseReturn = async ({
    openId, submitKey, productRecordId = '', number = '', entries = [], requestId = '', orderAmount = '',
    // ⭐⭐ 2026-10-18（task-2）：可选会话键（机制与 submitReplenish 逐字同源 ✓ 不传 ⇒ 改前行为不变 ✓）
    sessionKey = '',
  }) => {
    const sessionId = sessionKeyOf(openId, sessionKey);
    return queue.run(`sale:${sessionId}`, async () => {
    if (!config.purchaseReturn.enabled) {
      return fail({ code: 'disabled', message: texts.writeDisabledBody, requestId });
    }
    let current = await sessions.get(sessionId);
    // 扫开就直接退货也是正常用法（她从没点过「加入本单」）⇒ 会话还没建。
    if (!current) current = await sessions.ensure(sessionId);
    if (current.expired) {
      return fail({ code: 'session_expired', message: texts.sessionExpiredBody, requestId });
    }
    const flow = current.purchaseReturn || {};
    const key = String(submitKey || '').trim();
    const completed = flow.completed || [];
    const done = completed.find((item) => item.key === key);
    if (done) {
      logInfo(config.events.returnReused, {
        session_id: current.session_id, submit_key: key, batch_no: done.batch_no, request_id: requestId,
      });
      return {
        ok: true,
        reused: true,
        batch_no: done.batch_no,
        batch_record_id: done.batch_record_id || '',
        request_count: done.request_count,
        taken_count: done.taken_count || 0,
        shortfall: done.shortfall || 0,
        shortfalls: done.shortfalls || [],
      };
    }
    if (flow.key !== key) {
      const last = completed[completed.length - 1];
      if (last) {
        logInfo(config.events.returnReused, {
          session_id: current.session_id, submit_key: key, stale: true, batch_no: last.batch_no,
          request_id: requestId,
        });
        return { ok: true, reused: true, stale: true, batch_no: last.batch_no, request_count: last.request_count };
      }
      return fail({ code: 'session_expired', message: texts.sessionExpiredBody, requestId });
    }

    // ① 校验：勾了哪些尺码、每个退几双（勾了不填数量按配置的默认值 —— 至少一双）。
    const picked = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const size = positiveInteger(entry?.size);
      if (size === null) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'size_unknown', message: userMessageFor(error), requestId, error });
      }
      const rawQuantity = String(entry?.quantity ?? '').trim();
      const quantity = rawQuantity ? positiveInteger(rawQuantity) : config.purchaseReturn.defaultQuantity;
      if (quantity === null || quantity > config.purchaseReturn.maxQuantity) {
        const message = fillText(texts.quantityInvalidBody, { max: config.purchaseReturn.maxQuantity });
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({ code: 'quantity_invalid', message, requestId, error });
      }
      picked.push({ size, quantity });
    }
    if (!picked.length) {
      const error = new Error(texts.returnNoneBody);
      error.scanUserMessage = texts.returnNoneBody;
      return fail({ code: 'return_empty', message: userMessageFor(error), requestId, error });
    }
    if (picked.length > config.purchaseReturn.maxSizes) {
      const message = fillText(texts.returnTooManyBody, { max: config.purchaseReturn.maxSizes });
      const error = new Error(message);
      error.scanUserMessage = message;
      return fail({ code: 'return_too_many', message, requestId, error });
    }

    try {
      // ② 货品 + 供应商 + 采购行为：**全部来自既有表**（与补货那条取的是同几个字段）。
      const product = await resolveProductRecord({ productRecordId, number });
      if (!product) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'product_missing', message: userMessageFor(error), requestId, error });
      }
      const productId = product.record_id || productRecordId;
      const productFields = schema.tables.product.fields;
      const supplierRecordId = linkedRecordIds(product.fields?.[productFields.supplier])[0] || '';
      // 退货那条**既有行为编码**（解析不到 ⇒ 停下来报人话：绝不写一条没有"采购行为"的退货）
      const behavior = await references.resolveBehavior(config.purchaseReturn.behaviorCode);
      const itemNo = textValue(product.fields?.[productFields.itemNo]).trim();
      const color = textValue(product.fields?.[productFields.color]).trim();
      const items = picked.map(({ size, quantity }) => ({
        size, quantity,
        product_record_id: productId,
        product_number: productNumber(product),
        item_no: itemNo,
        color,
        supplier_record_id: supplierRecordId,
      }));
      const draft = {
        product_record_id: productId,
        product_number: productNumber(product),
        item_no: itemNo,
        color,
        supplier_record_id: supplierRecordId,
        behavior_record_id: behavior.recordId,
        operator_open_id: openId,
        items,
        // ⭐ 2026-10-15（她裁决ⓐ）：这一次填的**整单金额**
        //   ⇒ 写进退货批次行的「实际金额」（由 `purchaseReturnService` 在批次行建好后落）。
        //   ⚠️ 页面那道闸门已拦了空与非数字；这里原样透传（不重算 ✗）。
        order_amount: String(orderAmount ?? '').trim(),
      };
      // task id 由**这一次提交的幂等键**推出来 ⇒ 重放同一个键 = 同一个任务
      // ⇒ 批次行 / 明细行 / 库存操作都命中既有幂等（只写一次）。
      const taskId = `${config.purchaseReturn.taskIdPrefix}_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      logInfo(config.events.returnSubmitting, {
        session_id: current.session_id, submit_key: key, task_id: taskId,
        line_count: items.length, supplier_record_id: supplierRecordId, request_id: requestId,
      });
      const result = await purchaseReturn().submit(taskId, draft);
      const summary = {
        batch_no: result?.batch_no || '',
        batch_record_id: result?.batch_record_id || '',
        request_count: (result?.request_ids || []).length,
        taken_count: result?.taken_count || 0,
        shortfall: result?.shortfall || 0,
        shortfalls: result?.shortfalls || [],
      };
      if (result?.skipped === 'no_stock') {
        // 🔴 一双都退不成：**一个字都没写**（连批次行都没有）。不记 completed（她改一改还能再来），
        //    照实把"要退几双、现在一双都没有"说给她。
        const declared = (summary.shortfalls || [])
          .reduce((sum, item) => sum + Number(item.declared || 0), 0);
        const message = fillText(texts.returnStockEmptyBody, { declared });
        await sessions.markPurchaseReturnFailed(sessionId, message).catch(() => undefined);
        return fail({ code: 'return_stock_empty', message, requestId });
      }
      await sessions.completePurchaseReturn(sessionId, { key, result: summary });
      logInfo(config.events.returnSubmitted, {
        session_id: current.session_id, submit_key: key, task_id: taskId, ...summary,
        request_id: requestId,
      });
      return { ok: true, reused: false, ...summary };
    } catch (error) {
      const message = userMessageFor(error);
      await sessions.markPurchaseReturnFailed(sessionId, String(error.message || error)).catch(() => undefined);
      return fail({ code: 'return_write_failed', message, requestId, error });
    }
    });
  };



  return { replenishFingerprint, submitReplenish, submitPurchaseReturn };
};

module.exports = { createScanWritePurchase };
