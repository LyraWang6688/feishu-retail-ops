'use strict';

/**
 * 工作台「销售」路由（从 routes/workbench.js 拆出，行为不变）。
 * 鉴权、no-store、ui-tap 仍由 workbench.js 的父 router 统一加。
 */
const express = require('express');
const { V1BitableGateway } = require('../../services/v1BitableGateway');
const { createWorkbenchOrderActionsRouter } = require('../workbenchOrderActions');
const { createWorkbenchSalesDeliveryRoutes } = require('../workbenchSalesDelivery');
const { createScanWriteService } = require('../../services/scanWriteService');
const { SCAN_WRITE } = require('../../config/scanWrite');
const { logError, logInfo, logWarn } = require('../../utils/logger');

const createWorkbenchSalesRoutes = ({ options = {}, followup, ordersCache } = {}) => {
  const router = express.Router();
  // 订单动作（售后 / 二次交付）与售后扫一扫候选：2026-10-28 第一阶段拆分时误删，现恢复。
  router.use(createWorkbenchOrderActionsRouter({
    gateway: options.gateway || followup.gateway,
    service: options.orderActions,
    ordersCache,
  }));
  router.use(createWorkbenchSalesDeliveryRoutes({ options, followup, ordersCache }));
  router.get('/sales/after-sales/candidates', async (req, res) => {
    try {
      const result = await followup.listAfterSalesCandidates({
        productRecordId: req.query.productRecordId || req.query.product_record_id,
        days: req.query.days,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.after_sales.candidates.failed', {
        request_id: req.requestId, error: error.message,
      });
      return res.status(error?.statusCode === 400 ? 400 : 502)
        .json({ success: false, error: error.message || 'after-sales candidates failed' });
    }
  });

  router.get('/sales/orders', async (req, res) => {
    try { return res.json({ success: true, ...await followup.listOrders() }); }
    catch (error) {
      logError('workbench.sales.orders.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  /**
   * ⭐⭐ 2026-10-11（业务负责人 20:30 确认）：**补样品**（工作台 → 销售 → 订单列表 →【待补充】）。
   *
   * 她卖掉的样品没指定门盒 ⇒ 订单列表里有一条待办 ⇒ 她在这里选一个码 ⇒
   * 那一双 **门盒 → 样品**（**1 双**，库存总数不变），待办消失。
   *
   * ⚠️ 本路由**一行业务判断都没有**：待办/门盒/幂等全在
   *    `services/samplePendingService.js` → `InventoryService.promoteToSample`
   *    （**与群卡片共用同一个 `operationId`** ⇒ 跨入口绝不重复挪）；
   *    鉴权走本文件既有的那道闸门（`requireWorkbenchAccess`），**不新开**。
   */
  router.post('/sales/sample-fill', async (req, res) => {
    try {
      const result = await followup.fillSample({
        detailRecordId: req.body?.detailRecordId,
        size: req.body?.size,
        requestId: req.body?.requestId,
        operatorOpenId: req.workbenchUser.open_id,
      });
      // ⭐ 写成功了才作废订单列表缓存（她下一次读一定是新数据）。
      ordersCache.invalidate();
      return res.json({ success: true, ...result });
    } catch (error) {
      // 她选错了 / 这一条不是待办 ⇒ 400（人话原样给她）；系统没做成 ⇒ 502。
      const status = error.statusCode === 400 ? 400 : 502;
      logError('workbench.sales.sample_fill.failed', {
        request_id: req.requestId, detail_record_id: req.body?.detailRecordId,
        size: req.body?.size, error: error.message,
      });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  // ⭐ 2026-10-15 收尾（只改注释）：这里原来挂着一整段说明**工作台自建配品两条路由**的 JSDoc
  //   （`GET /sales/accessories` 只读清单 / `POST /sales/accessory-sales` 自建成单）。
  //   那两条路由**已随她那句「配品就是走表单了～工作台自建写服务可以删除了」整段删除**（见下面那块注释 ✓）
  //   ⇒ 这段"它还在这儿"的旧说明**留着就是误导** ✗ 换成这一句沿革即可。
  //   ⚠️ 那两条路由当年的**业务判据没有丢**：一步成单 / 收款明细形状 / 不动库存 / 幂等 / 失败如实
  //     ⇒ 已迁到新链路 `services/accessorySaleIntakeService.js` ＋ `test/accessorySaleIntake.test.js`
  //     的 **AC-MIG1…AC-MIG5**（迁移清单见 `test/workbenchAccessoryTab.test.js` 文件头 ✓）。
  const scanWrite = options.scanWrite || createScanWriteService({
    gateway: options.gateway || new V1BitableGateway(), config: SCAN_WRITE,
  });
  /**
   * ⭐⭐ 2026-10-15（⑰b-1 · 她逐字）：「失败落「**写入失败**」、工作台显示「**未完成，可点重试**」」
   *   ⇒ **工作台「续写 / 重试」入口**：那一单**能点、点了真能续上** ✓
   *
   * 口径（Lead 2026-10-15 批准）：
   *   · 🔴 **复用** `submitSale`（**不新开写库** ✗）：**同一把 `session.sale.key`**
   *     ＋ `session.sale.submitPending` 里那套资金入参 —— 与她点资金页那颗按钮**同一次调用** ✓
   *     （幂等一字没拆 ✗；同一把键 + 同一份入参 ⇒ 重试不会写第二遍 ✓）
   *   · ⭐ 主表已经建过（`master_record_id` 在会话里）⇒ `wasResume=true` ⇒ **不再往后丢**、
   *     这一次**同步跑完** ⇒ 她点下去能看到"好了 / 还没好" ✓
   *   · 🔴 **绝不直调 `_confirm`** ✓（走的是既有 `sales().confirm`）
   *   · 🔴 **不新开鉴权**：它挂在本文件上方那条既有 `router.use(requireWorkbenchAccess)` 之后 ✓
   *   · 🔴 **没有待续的单 / 单号对不上** ⇒ **如实 400 + 人话**（绝不假成功 ✗）
   */
  router.post('/sales/retry', async (req, res) => {
    const openId = req.workbenchUser?.open_id;
    const requestId = req.body?.requestId || req.requestId;
    const texts = SCAN_WRITE.texts || {};
    try {
      const session = await scanWrite.sessions?.get?.(openId).catch(() => null);
      const key = String(session?.sale?.key || '').trim();
      const masterRecordId = String(session?.sale?.master_record_id || '').trim();
      const orderNo = String(session?.sale?.order_no || '').trim();
      const pending = session?.sale?.submitPending || {};
      // 🔴 没有"已经建过主表、还没写完"的单 ⇒ 如实告诉她（不假成功 ✗）
      if (!key || !masterRecordId) {
        logWarn('workbench.sales.retry.no_pending', {
          request_id: requestId, open_id: String(openId || ''), has_key: Boolean(key),
        });
        return res.status(400).json({ success: false, code: 'no_pending_order', error: texts.saleRetryNoPendingBody });
      }
      // 🔴 点的是哪一单就重试哪一单：她给的单号与会话里那一单不一致 ⇒ 不动手 ✗
      const askedOrderNo = String(req.body?.order_no ?? '').trim();
      if (askedOrderNo && orderNo && askedOrderNo !== orderNo) {
        logWarn('workbench.sales.retry.order_mismatch', {
          request_id: requestId, asked_order_no: askedOrderNo, order_no: orderNo,
        });
        return res.status(400).json({ success: false, code: 'order_mismatch', error: texts.saleRetryMismatchBody });
      }
      const result = await scanWrite.submitSale({
        openId,
        requestId,
        // 🔴 **同一把 `submitKey`**（幂等不许拆 ✗）
        submitKey: key,
        payments: Array.isArray(pending.payments) ? pending.payments : [],
        lineAmounts: Array.isArray(pending.lineAmounts) ? pending.lineAmounts : [],
        paymentStatus: String(pending.paymentStatus || '').trim(),
        paidAmount: String(pending.paidAmount ?? ''),
        timing: {},
      });
      if (result?.ok) {
        // 写成了 ⇒ 让她下一次读到的是**真的新数据**（不看缓存 ✗）
        if (typeof ordersCache?.invalidate === 'function') ordersCache.invalidate();
        logInfo('workbench.sales.retry.done', {
          request_id: requestId, order_no: result.order_no || orderNo,
          detail_count: result.detail_count, payment_count: result.payment_count,
        });
        return res.json({
          success: true, order_no: result.order_no || orderNo,
          detail_count: result.detail_count || 0, payment_count: result.payment_count || 0,
          // ⭐ 她刷新/回看时看到的是**真实状态**：`reused:true` = "这一单刚才已经交过了"（不是又写了一遍 ✗）
          reused: result.reused === true,
          message: texts.saleRetryDoneBody,
        });
      }
      logWarn('workbench.sales.retry.failed', {
        request_id: requestId, order_no: orderNo,
        code: String(result?.code || ''), reason: String(result?.message || ''),
      });
      // 部成那类（主表已在、后面没写完）= 500（系统没写成）；她填错类 = 400 ✓
      const status = result?.code === 'sale_partial_failed' ? 500 : 400;
      return res.status(status).json({
        success: false, code: String(result?.code || ''),
        error: result?.message || texts.saleRetryFailedBody, order_no: orderNo,
      });
    } catch (error) {
      logError('workbench.sales.retry.error', {
        request_id: requestId, error: String(error?.message || error),
      });
      return res.status(500).json({ success: false, code: 'retry_failed', error: texts.saleRetryFailedBody });
    }
  });
  // ⭐⭐ 2026-10-15（业务负责人逐字）：「**配品就是走表单了～工作台自建写服务"可以删除了**」
  //   ⇒ 这一整块（`GET /sales/payment-methods` 收款方式清单 / `GET /sales/accessories` 配品清单 /
  //      `POST /sales/accessory-sales` 自建成单）**整段删除** —— 工作台点「配品」现在**直接跳她那张
  //      飞书表单**（`config/domains.js` 的直跳页 + `config/links.js` 的 `ACCESSORY_SALE_FORM_URL`）✓
  //   ⚠️ 这三条路由当年的**业务判据没有跟着消失**：一步成单 / 收款明细形状 / 不动库存 / 幂等（同一把键）/
  //      失败如实 ⇒ 已迁到**新链路**（`services/accessorySaleIntakeService.js` ＋
  //      `test/accessorySaleIntake.test.js` 的 **AC-MIG1/2/3/4**）—— 迁移清单见
  //      `test/workbenchAccessoryTab.test.js` 文件头 ✓
  //   ⚠️ `services/paymentMethodsService.js` **保留**（它有自己的用例 `test/paymentMethodsService.test.js`）——
  //      这一刀**只删工作台自建那套**，**不删业务模块** ✗
  /**
   * ⭐⭐ 2026-10-11（方案甲之后**唯一的补充入口**）：**逐件补「实收金额」**。
   * 业务负责人 2026-10-11：「待补充的时候，**一定要把每件的实收都留下来**」。
   * ⚠️ 本路由**一行业务判断都没有**：校验与两条红线全在
   *    `services/salesFollowupService.updateDetailAmounts`（同一个 service 管工作台这一页的写入，
   *    鉴权走本文件既有的那道闸门，不新开）。
   */
  router.post('/sales/detail-amounts', async (req, res) => {
    try {
      const result = await followup.updateDetailAmounts({
        salesEntryRecordId: req.body?.salesEntryRecordId,
        amounts: req.body?.amounts,
        requestId: req.body?.requestId,
        operatorOpenId: req.workbenchUser.open_id,
      });
      // ⭐ 补实收金额成功 ⇒ 作废缓存。
      ordersCache.invalidate();
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.detail_amount.failed', { request_id: req.requestId, error: error.message });
      return res.status(400).json({ success: false, error: error.message });
    }
  });
  return router;
};

module.exports = { createWorkbenchSalesRoutes };
