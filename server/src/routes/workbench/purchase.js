'use strict';

/**
 * 工作台「供应 / 采购」路由（从 routes/workbench.js 拆出，行为不变）。
 * 鉴权、no-store、ui-tap 仍由 workbench.js 的父 router 统一加。
 */
const express = require('express');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { createPurchaseQueryRouter } = require('../purchaseQuery');
const { WorkbenchPurchaseArrivalService } = require('../../services/workbenchPurchaseArrivalService');
const { createPurchaseQueryService } = require('../../services/purchaseQueryService');
const { PurchaseWebhookService } = require('../../services/purchaseWebhookService');
const { PurchaseArrivalConversationService, parseActualAmount } = require('../../services/purchaseArrivalConversationService');
const { pageMessages } = require('../../config/purchaseArrivalTexts');
const { SCAN_WRITE } = require('../../config/scanWrite');
const arrivalTab = require('../../config/workbenchArrival');
const { createScanArrivalService } = require('../../services/scanArrivalService');
const { createPurchaseWriteBackgroundService } = require('../../services/purchaseWriteBackgroundService');
const { logError, logWarn } = require('../../utils/logger');
// ⭐ 2026-10-28（采购页进入生产）：采购页的**只读读模型 + 提交**端点。
//   🔴 挂在本文件（= 既有 workbench 父 router 已挂载的子路由）⇒ **不改共享文件 `routes/workbench.js`**，
//     也自动带上父 router 的准入闸门 / no-store / ui-tap 结果事件（不新开鉴权）。
//   🔴 提交走既有 `multiItemOrderService` → `publishPurchaseRequest`（不新建写库路径）。
const { PROCUREMENT_PAGE } = require('../../config/procurementPage');
const { createProcurementPageService } = require('../../services/procurementPageService');
const { createProcurementPageSubmitService } = require('../../services/procurementPageSubmitService');
const { createScanWriteService } = require('../../services/scanWriteService');

const createWorkbenchPurchaseRoutes = ({ options = {}, ordersCache } = {}) => {
  const router = express.Router();
  // ⭐ 2026-10-09（业务负责人当天 15:07：「**采购**，按照**采购订单**，有**验收到货**的按钮」）：
  //   订单列表 · **采购**子 tab 那一行上的「验收到货」。
  //   🔴 **不新开鉴权**：它就挂在这条 `requireWorkbenchAccess` 之后（与其它工作台接口同一道闸门）。
  //   🔴 **不新写一套入库**：本路由只收 `{ batchNo, actualAmount }`（她 2026-10-16：「到货说明必须得删」），
  //      原样交给 `WorkbenchPurchaseArrivalService` → 既有
  //      `PurchaseArrivalConversationService.confirmBatchArrival` →
  //      既有 `PurchaseWebhookService.confirmArrival`（逐条 `InventoryService.applyPurchase`）。
  //   ⚠️ 「发生金额」是**既有必填口径**（业务负责人 2026-10-08：「金额这个是必填的」），
  //      所以那个按钮点开的是一个小表单，不是一个"点了就入库"的裸按钮。
  //   ⚠️ 依赖**延迟构建**：只想注入一个桩的调用方（测试）不必先配好飞书凭证。
  let purchaseArrival = options.purchaseArrival || null;
  const resolvePurchaseArrival = () => {
    if (!purchaseArrival) {
      const arrivalGateway = options.gateway || new V1BitableGateway();
      const webhooks = new PurchaseWebhookService({ gateway: arrivalGateway });
      const arrivalConversation = new PurchaseArrivalConversationService({
        gateway: arrivalGateway,
        // ⚠️ 与采购链路**共用同一个任务存储**：`confirmArrival` 要读的草稿就在那里。
        store: webhooks.store,
        sizeReferences: webhooks.getSizeReferences,
        confirmArrival: (taskId, task, operatorOpenId) =>
          webhooks.confirmArrival(taskId, task, operatorOpenId),
        // 入库之后把批次行的「到货状态」改成已到货 —— 仍是**既有** `PurchaseOrderBatchService`。
        markBatchArrived: (batchNo, arriveOptions) =>
          webhooks.orderBatches.markArrived(batchNo, arriveOptions),
      });
      purchaseArrival = new WorkbenchPurchaseArrivalService({
        purchaseQuery: createPurchaseQueryService(arrivalGateway),
        arrivalConversation,
      });
    }
    return purchaseArrival;
  };
  router.post('/purchase/arrivals/confirm', async (req, res) => {
    const batchNo = String(req.body?.batchNo || '').trim();
    try {
      const result = await resolvePurchaseArrival().confirmArrival({
        batchNo,
        actualAmount: req.body?.actualAmount,
        operatorOpenId: req.workbenchUser?.open_id,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.purchase.arrival_confirm.failed', {
        request_id: req.requestId, batch_no: batchNo, error: error.message,
      });
      // 失败口径与 `workbenchOrderActions` 同一套：她填错的 400 / 业务拒绝 502，
      // **两种都把原因原样回到页面**（页面上看得见原因，不许静默）。
      const status = error?.statusCode === 400 ? 400 : error?.statusCode === 503 ? 503 : 502;
      return res.status(status).json({ success: false, error: error.message });
    }
  });
  /**
   * ⭐⭐ 2026-10-14 晚（业务负责人：「把老验收整块搬进工作台」✓ 真源 `docs/acceptance-into-workbench-full-2026-10-14.md`）
   *   · `GET /purchase/arrivals/detail`  —— **只读**该批采购明细（既有 `listPurchaseRequests` ✓ 不新造读取口 ✗）
   *   · `POST /purchase/arrivals/accept` —— 走**既有** `scanArrivalService`（start → addScan… → finish ✓
   *     幂等键 = 它自己的 `submitKeyOf(session)` ✓ 同键两跑只写一次 ✗）· 加库存仍走 `InventoryService.applyPurchase` ✓
   *     🔴 失败**如实**（人话 + 不当成功 ✗）
   *     ⭐⭐ **2026-10-16（task-56）起这一条是异步的**：start / addScan（= 校验那一半）仍**同步**，
   *       `finish`（= 写库那一半）丢给下面那件共用后台件 ⇒ 她**先拿到统一成功页** ✓（见下方注释）。
   */
  const purchaseQueryForArrival = () => {
    if (options.purchaseQuery) return options.purchaseQuery;
    if (options.gateway) return createPurchaseQueryService({ gateway: options.gateway });
    return createPurchaseQueryService({ gateway: new V1BitableGateway() });
  };
  const arrivalService = options.arrival || createScanArrivalService({
    gateway: options.gateway || new V1BitableGateway(),
    config: (options.writeConfig || SCAN_WRITE).acceptance,
    store: options.arrivalStore,
  });
  /**
   * ⭐⭐ 2026-10-16（task-56 · 业务负责人**弹窗选定 B**：「**工作台那半也接异步**」；她当天逐字
   *   「**补货、退货还有验收，它都是异步的**……都是一句『**已提交成功，数据会更新**』」）：
   *   工作台【确认到货】= **先回成功页（200 ＋ 统一那一句）⇒ 「后台那一跑」再写库** ✓
   *
   * 🔴 三条硬要求都落在这一处（判据见 `test/acceptAsyncWrite.test.js`）：
   *   ① **校验仍当场同步拦** ✗ —— 批次号缺失 / 明细读不到 / 空单 / 货号认不出 /
   *      尺码数量非法 / 不在本批 全部在**排后台之前**（拦住 ＋ 人话 ＋ **零业务写入** ＋ **一次后台都不排** ✓）。
   *   ② **绝不假装成功** ✗ —— 后台那一跑没成就记一条 warn ＋ 把原因落回会话 `last_error`
   *      （共用件 `services/purchaseWriteBackgroundService.js` 的 `markFailed` ✓）⇒ 可查、可重试 ✓。
   *   ③ **同一把 `submitKey` 原样透传** ✗ —— 键仍由既有 `arrivalService.submitKeyOf(session)` 算
   *      （**不取表单** ✗、不拼、不加后缀 ✓）；幂等三层（会话键 ｜ 批次任务闸门 ｜ 库存三元组）**一层都不拆** ✓。
   *
   * ⚠️ **复用既有共用件**（`createPurchaseWriteBackgroundService` ✓ #664）—— 不另造后台件 ✗；
   *    事件名 / 看门狗阈值都取既有配置（`SCAN_WRITE.events.purchaseBackground*` /
   *    `SCAN_WRITE.purchaseAsync` ⇒ `config/scanWrite.js` **一个字不动** ✓）。
   */
  const acceptBackground = options.acceptBackground || createPurchaseWriteBackgroundService({
    // 🔴 `runRest` = **既有写入口**（`scanArrivalService.finish` ✓ 不新开写库路径 ✗）——
    //    实参形状与改前那一次 `await arrivalService.finish(...)` **逐字同形**（键名一个不改 ✗）。
    runRest: async ({ requestId, submitKey, restInput = {} }) => {
      const result = await arrivalService.finish({
        openId: restInput.openId,
        actualAmount: restInput.actualAmount,
        submitKey,
        operatorOpenId: restInput.operatorOpenId,
      });
      // 写完才作废订单列表缓存（她下一次读一定是新数据 ✓）——改前是"写成功后立刻作废"，语义不变 ✓
      if (result?.ok) ordersCache.invalidate();
      return result;
    },
    // 🔴 失败如实：共用件已经记了 warn；这里把**原因**落回会话（可查、可重试 ✓ 绝不吞成成功 ✗）。
    markFailed: async ({ requestId, context = {}, result, error }) => {
      const message = String(result?.message || error?.message || '').trim();
      if (!message) return;
      try {
        const session = await arrivalService.get(String(context.openId || ''));
        if (session?.session_id) {
          await arrivalService.store.update(session.session_id, { last_error: message });
        }
      } catch (markError) {
        logWarn(SCAN_WRITE.events.purchaseBackgroundMarkFailed, {
          request_id: requestId, chain: 'accept',
          error: String(markError?.message || markError).slice(0, 200),
        });
      }
    },
    purchaseAsync: (options.writeConfig && options.writeConfig.purchaseAsync) || SCAN_WRITE.purchaseAsync || {},
    config: {
      events: {
        restTiming: SCAN_WRITE.events.purchaseBackgroundTiming,
        restFailed: SCAN_WRITE.events.purchaseBackgroundFailed,
        markFailedError: SCAN_WRITE.events.purchaseBackgroundMarkFailed,
      },
    },
  });
  router.get(arrivalTab.api.detail, async (req, res) => {
    const batchNo = String(req.query?.[arrivalTab.fields.batchNo] || '').trim();
    if (!batchNo) return res.status(400).json({ success: false, error: arrivalTab.texts.batchMissing });
    try {
      const rows = (await purchaseQueryForArrival().listPurchaseRequests({
        batchNo, reportBehavior: 'purchase_request',
      })) || [];
      if (!rows.length) return res.json({ success: true, rows: [], notice: arrivalTab.texts.emptyDetail });
      // ⭐ **只读**：只回 货号 / 尺码 / 数量（前端渲染成不可输入的清单 ✓）
      return res.json({
        success: true,
        rows: rows.map((row) => ({
          item_no: row.item_no || row.product_item_no || '',
          size: row.size ?? '',
          quantity: row.quantity ?? 0,
          product_record_id: row.product_record_id || '',
        })),
      });
    } catch (error) {
      logError('workbench.purchase.arrival_detail.failed', { request_id: req.requestId, batch_no: batchNo, error: error.message });
      return res.status(400).json({ success: false, error: arrivalTab.texts.detailFailed });
    }
  });
  router.post(arrivalTab.api.accept, async (req, res) => {
    const openId = req.workbenchUser?.open_id;
    const batchNo = String(req.body?.[arrivalTab.fields.batchNo] || '').trim();
    const lines = Array.isArray(req.body?.[arrivalTab.fields.lines]) ? req.body[arrivalTab.fields.lines] : [];
    if (!batchNo) return res.status(400).json({ success: false, error: arrivalTab.texts.batchMissing });
    try {
      // ⭐⭐ 2026-10-17（业务负责人逐字）：「验收就是我报货、然后货到了，我需要验收；
      //   退货是发给别人的，也就不用验收」⇒ **硬闸门**：只有「发生行为 = 报货」的批次能验收；
      //   退货批次 ⇒ 400 ＋ 人话 ＋ **零写入**（`scanArrivalService` 自己不判行为，必须在这里挡）。
      const batchRows = (await purchaseQueryForArrival().listPurchaseRequests({ batchNo })) || [];
      if (batchRows.some((row) => row.report_behavior === 'purchase_return')) {
        return res.status(400).json({ success: false, error: arrivalTab.texts.notRequestBatch });
      }
      // ① 开会话（既有 `start` 读该批采购明细 ✓ 读不到 ⇒ 它自己的人话 `no_request_rows` ✓ 如实回 400 ✗）
      const started = await arrivalService.start({ openId, batchNo, operatorOpenId: openId });
      if (!started?.ok) {
        const status = started?.reason === 'not_wired' ? 503 : 400;
        return res.status(status).json({ success: false, error: started?.message || arrivalTab.texts.detailFailed });
      }
      // ② 逐行 `addScan`（**既有自定义路** ✓：认得出 productRecordId 才收；认不出**如实**回 400 ✗ 不静默丢）
      for (const line of lines) {
        const productRecordId = String(line?.[arrivalTab.fields.productRecordId] || '').trim();
        const size = Number(line?.[arrivalTab.fields.size]);
        const quantity = Number(line?.[arrivalTab.fields.quantity]);
        if (!productRecordId) {
          // 自定义货号：既有 `addScan` 只吃 `productRecordId` ⇒ 认不出就**如实说**（不许静默丢 ✗）
          return res.status(400).json({ success: false, error: arrivalTab.texts.itemNoUnresolved });
        }
        if (!Number.isSafeInteger(size) || !Number.isSafeInteger(quantity) || size <= 0 || quantity <= 0) {
          return res.status(400).json({ success: false, error: arrivalTab.texts.sizeInvalid });
        }
        // eslint-disable-next-line no-await-in-loop
        const added = await arrivalService.addScan({ openId, productRecordId, size, quantity });
        if (!added?.ok) return res.status(400).json({ success: false, error: added?.message || arrivalTab.texts.acceptFailed });
      }
      // ③ 同步闸门（🔴 **校验必须留在同步路径** ✗ —— 不许顺手挪进后台）：
      //    · `no_session` / `no_scan_lines`（空单）＝ **写层自己的判据与文案**（`scanArrivalService.finish`
      //      用的就是这两条 ✓ 本文件照它那两句回，不新写中文 ✗）；
      //    · 金额 = `PurchaseArrivalConversationService` 里**唯一那一份** `parseActualAmount`
      //      ＋ `config/purchaseArrivalTexts` 的 `pageMessages.m2/m3` ✓（不抄第二份规则 ✗）。
      //    ⚠️ 顺序与**改前那一版同步路径**逐字一致（会话 ⇒ 空单 ⇒ 金额）——两个都错时提示不换 ✗。
      //    命中 ⇒ **400 ＋ 人话 ＋ 零业务写入 ＋ 一次后台都不排** ✓。
      const session = await arrivalService.get(openId);
      if (!session) {
        return res.status(400).json({ success: false, error: SCAN_WRITE.texts.acceptNoSessionBody });
      }
      if (!(session.scans || []).length) {
        return res.status(400).json({ success: false, error: SCAN_WRITE.texts.acceptNoScansBody });
      }
      const amount = parseActualAmount(req.body?.[arrivalTab.fields.actualAmount]);
      if (!amount.ok) {
        return res.status(400).json({
          success: false,
          error: amount.reason === 'amount_missing' ? pageMessages.m2 : pageMessages.m3,
        });
      }
      // ④ 幂等键：**服务端算**（既有 `submitKeyOf(session)` ✓ 不取表单里的键 ✗）——
      //    ⚠️ 它**只在这里算一次**，原样交给后台那一跑（同一把键 ⇒ 幂等第一层仍在 ✓）。
      const submitKey = arrivalService.submitKeyOf(session);
      // ⑤ 排「后台那一跑」（🔴 **不 await** ⇒ 她**先拿到成功页** ✓；写库仍在既有 `finish` 里 ✗ 不新开路径）。
      //    ⚠️ 位置**必须在上面那几道校验之后**：先排后台再校验 = 把"她填错了"变成"看起来成功" ✗。
      acceptBackground.schedulePurchaseRest({
        chain: 'accept',
        requestId: req.requestId,
        submitKey,
        context: { openId, requestId: req.requestId, batchNo },
        restInput: {
          openId,
          // ⚠️ 金额**原样**透传（不改成 `amount.value`）—— 形状与改前那一次 `finish(...)` 逐字同形 ✓；
          //    金额规则在写层还会再走一遍同一份解析（幂等、无副作用 ✓）。
          actualAmount: req.body?.[arrivalTab.fields.actualAmount],
          operatorOpenId: openId,
        },
      });
      // ⑥ 成功页 = **统一那一句**（「已提交成功，数据会更新」· 真源在 `config/scanPage.js` 的
      //    `SCAN_PAGE.saleSuccess` ✓ 本文件不新造字面量 ✗）。
      //    ⚠️ **不许**回 "已确认到货"：这一刻后台还没写 ⇒ 那是假成功 ✗（真失败另有出口：
      //       后台件的 warn ＋ 会话 `last_error` ⇒ 可查、可重试 ✓）。
      return res.json({
        success: true,
        accepted: true,
        batchNo,
        message: arrivalTab.texts.submitted,
      });
    } catch (error) {
      logError('workbench.purchase.arrival_accept.failed', { request_id: req.requestId, batch_no: batchNo, error: error.message });
      const status = error?.statusCode === 400 ? 400 : error?.statusCode === 503 ? 503 : 502;
      return res.status(status).json({ success: false, error: error.message });
    }
  });
  // ── 采购页（供应 → 录单 → 采购）：补货 / 上新 两个 tab 的真实数据 + 统一提交 ────────────
  //   业务口径（2026-10-28 业务负责人确认，见 `docs/procurement-page-real-2026-10-28.md`）：
  //   · 补货：只查「销售明细」一张表（库存数量 = 0；销售日 = 今天 00:00 往前 3 个自然日）；
  //   · 上新：货品信息 上架日期 = 今天；顶部统计只有「新增货品」；
  //   · 扫一扫：本轮只占位（无接口）；提交复用既有采购链路（不新建草稿表/写库路径）。
  //   ⚠️ 依赖**延迟构建**：只想注入一个桩的用例不必先配好飞书凭证。
  let procurementPage = options.procurementPage || null;
  const resolveProcurementPage = () => {
    if (!procurementPage) {
      procurementPage = createProcurementPageService({
        gateway: options.gateway || new V1BitableGateway(),
        config: PROCUREMENT_PAGE,
      });
    }
    return procurementPage;
  };
  let procurementSubmit = options.procurementSubmit || null;
  const resolveProcurementSubmit = () => {
    if (!procurementSubmit) {
      const procurementGateway = options.gateway || new V1BitableGateway();
      procurementSubmit = createProcurementPageSubmitService({
        gateway: procurementGateway,
        config: PROCUREMENT_PAGE,
        writeService: options.scanWrite || createScanWriteService({
          gateway: procurementGateway, config: SCAN_WRITE,
        }),
      });
    }
    return procurementSubmit;
  };
  const procurementTexts = PROCUREMENT_PAGE.texts;
  router.get(PROCUREMENT_PAGE.endpoints.replenish, async (req, res) => {
    try {
      const result = await resolveProcurementPage().loadReplenish({ requestId: req.requestId });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.procurement.replenish.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: procurementTexts.loadFailed });
    }
  });
  router.get(PROCUREMENT_PAGE.endpoints.newProducts, async (req, res) => {
    try {
      const result = await resolveProcurementPage().loadNewProducts({ requestId: req.requestId });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.procurement.new_products.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: procurementTexts.loadFailed });
    }
  });
  router.post(PROCUREMENT_PAGE.endpoints.submit, async (req, res) => {
    try {
      // 🔴 同步校验全在 `procurementPageSubmitService.submit` 里（校验不通过 ⇒ 人话 + **零写入**）；
      //    通过之后才排「后台那一跑」，HTTP 先回统一那一句（「已提交成功，数据会更新」）。
      const result = await resolveProcurementSubmit().submit({
        openId: req.workbenchUser?.open_id,
        submitKey: req.body?.submitKey,
        items: req.body?.items,
        requestId: req.requestId,
      });
      if (!result.ok) {
        const status = result.code === 'behavior_missing' ? 502 : 400;
        return res.status(status).json({ success: false, code: result.code, error: result.message });
      }
      return res.json({
        success: true, accepted: true, reused: result.reused === true, message: result.message,
      });
    } catch (error) {
      logError('workbench.procurement.submit.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: procurementTexts.submitFailed });
    }
  });
  router.use('/purchase', createPurchaseQueryRouter({ gateway: options.gateway || new V1BitableGateway() }));
  return router;
};

module.exports = { createWorkbenchPurchaseRoutes };
