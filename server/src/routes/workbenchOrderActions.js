/**
 * 工作台【订单列表】的单条操作 —— 写入口（业务负责人 2026-10-09）。
 *
 * 🔴 2026-10-29（旧订单列表前端退场）：`POST /sales/second-delivery` 已删（旧详情页的二次交付入口没了）；
 *    `SecondDeliveryService` 业务能力仍保留，以后独立页要用时从服务层接。
 *
 * ⭐ 2026-10-29：另加一条**只读**入口给「售后扫一扫落地页」——
 *   GET  /api/workbench/sales/after-sales/scan-candidates
 *   为什么放这里：落地页要摆「销售日 + 销售主表总金额」，而既有候选接口
 *   （`salesFollowupService.listAfterSalesCandidates`，订单列表那条读路径）**没有读这两列**；
 *   那个 service 属于另一条任务的作用域（本分支不改它）。
 *   ⇒ 这一条走**独立的只读取数**（`services/afterSalesScanService.js`）：不写库、不改任何既有接口。
 *
 * 🔴 鉴权**不新开一套**：本路由挂在 `createWorkbenchRouter` 内部，于是自动带上
 *    **既有**的 `requireWorkbenchAccess`（未启用认证 503 / 未登录 401 / 白名单外 403）。
 * 🔴 失败口径与 `workbenchInventoryAdjustment.js` 同一套：她填错的（statusCode=400）→ 400，
 *    业务拒绝 → 502，**两种都把原因原样回到页面**（页面上看得见原因，不许静默）。
 * 🔴 这里**没有任何写库逻辑** —— 退货 / 换货全部交新的售后执行器。
 */
const express = require('express');
const { AfterSalesScanService } = require('../services/afterSalesScanService');
const { SAMPLE_PROMOTION } = require('../config/samplePromotion');
const { createScanPageService } = require('../services/scanPageService');
const { saleSizeGroups } = require('../views/scanPageRealm');
const { AfterSalesReturnService } = require('../services/afterSalesReturnService');
const { AfterSalesExchangeService } = require('../services/afterSalesExchangeService');
const { createAfterSalesAsyncService } = require('../services/afterSalesAsyncService');
const { getAsyncJobService } = require('../services/asyncJobRuntime');
const { createPaymentMethodsService } = require('../services/paymentMethodsService');
const { redirectWithSubmitToast } = require('../utils/submitToast');
const { AFTER_SALES_DERIVED } = require('../config/afterSalesDerived');
const { tapIdFromRequest } = require('../utils/correlationFields');
const { logError } = require('../utils/logger');

/**
 * ⭐ 2026-10-12：**写库成功之后要作废订单列表的缓存**（TTL 缓存见 `services/workbenchOrdersCache.js`）。
 * ⚠️ 缓存层不认业务，**路由层才认**"这是一笔写" ⇒ 失效动作放在这里。
 *    `options.ordersCache` 由 `routes/workbench.js` 传同一个实例进来（不新开一份）。
 */
const createWorkbenchOrderActionsRouter = (options = {}) => {
  const router = express.Router();

  // ⭐⭐⭐ 2026-10-29：售后**扫一扫落地页**的只读候选（不写库、不作废缓存 —— 它什么都没改）。
  //   入参：`productRecordId`（二维码里的货品记录 id）+ `days`（默认 7，配置里封顶）。
  //   出错口径与上面两条写入口一致：她那边的问题（缺参数 / 货品不存在）→ 400，读库失败 → 502；
  //   **两种都把原因原样回页面**（页面上看得见原因，不许静默）。
  //   ⚠️ 事件名复用既有的 `workbench.sales.after_sales.candidates.failed`（同一件事：售后候选读失败），
  //      不新造事件（新事件要进 `config/events.js`，那是另一条任务的作用域）。
  let scanService = options.scanService || null;
  const resolveScanService = () => {
    if (!scanService) scanService = new AfterSalesScanService({ gateway: options.gateway });
    return scanService;
  };
  router.get('/sales/after-sales/scan-candidates', async (req, res) => {
    try {
      const result = await resolveScanService().listCandidates({
        productRecordId: req.query?.productRecordId || req.query?.product_record_id,
        days: req.query?.days,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      logError('workbench.sales.after_sales.candidates.failed', {
        request_id: req.requestId,
        product_record_id: req.query?.productRecordId || req.query?.product_record_id || '',
        error: error.message,
      });
      return res.status(error?.statusCode === 400 ? 400 : 502)
        .json({ success: false, error: error.message });
    }
  });

  // ⭐ 2026-10-29：换尺码 —— **复用销售扫码页的视图模型**（`scanPageService.lookup` + `saleSizeGroups`），
  //   售后页不再自己写一份"现货/预订/特殊码"分组规则；销售页改口径，这里自动跟着变。
  let scanPageService = options.scanPageService || null;
  const resolveScanPageService = () => {
    if (!scanPageService) scanPageService = createScanPageService(options.gateway);
    return scanPageService;
  };
  const sizeItems = (items) => (items || []).map((item) => ({
    size: Number(item.size_text), count: Number(item.count) || 0,
    // 把门盒 / 样品 / 空状态带到售后换尺码弹窗，不能只给尺码数字。
    states: Array.isArray(item.states) ? item.states : [],
  }));
  router.get('/sales/after-sales/stock-sizes', async (req, res) => {
    const productRecordId = String(req.query?.productRecordId || req.query?.product_record_id || '').trim();
    if (!productRecordId) return res.status(400).json({ success: false, error: 'missing productRecordId' });
    const originalSize = Number(req.query?.originalSize || 0);
    try {
      const view = await resolveScanPageService().lookup({ recordId: productRecordId, requestId: req.requestId });
      const groups = saleSizeGroups(view);
      const all = [...groups.inStock, ...groups.prepaid, ...groups.folded];
      const sampleCandidates = all
        .filter((item) => (item.states || []).some((state) => (
          (state.key === SAMPLE_PROMOTION.texts.tagDoorbox || state.key === '')
          && Number(state.count) > 0
        )))
        .map((item) => String(item.size_text));
      // ⭐ 换回来的原尺码即使只有样品也可作为候选；不能假设它一定回到门盒。
      if (originalSize > 0 && all.some((item) => Number(item.size_text) === originalSize)) {
        const text = String(originalSize);
        if (!sampleCandidates.includes(text)) sampleCandidates.push(text);
      }
      return res.json({
        success: true,
        groups: {
          inStock: sizeItems(groups.inStock),
          reserve: sizeItems(groups.prepaid),
          special: sizeItems(groups.folded),
          sampleCandidates,
        },
      });
    } catch (error) {
      logError('workbench.sales.after_sales.candidates.failed', {
        request_id: req.requestId, product_record_id: productRecordId, error: error.message,
      });
      return res.status(error?.statusCode === 400 ? 400 : 502)
        .json({ success: false, error: error.message });
    }
  });

  // ⭐⭐ 2026-11-08（业务负责人定稿）：售后「退货」写入 —— 表单 POST → 入队 → 303 统一 toast → 后台写库。
  //   · 提交**成功** ⇒ 回**工作台首页**（统一 toast 的默认落点，与销售/采购一致，业务负责人 2026-11-09 定）；
  //   · 填错（400）⇒ 仍回售后页并带 `err=`，她可以就地改（这条需要 productRecordId 才能回到原页面）。
  const landingPath = (productRecordId) => (productRecordId
    ? `/workbench/after-sales.html?productRecordId=${encodeURIComponent(productRecordId)}`
    : '/workbench/after-sales.html');
  let paymentMethods = options.paymentMethodsService || null;
  const resolvePaymentMethods = () => {
    if (!paymentMethods) paymentMethods = createPaymentMethodsService(options.gateway);
    return paymentMethods;
  };
  let returnService = options.afterSalesReturn || null;
  const resolveReturnService = () => {
    if (!returnService) returnService = new AfterSalesReturnService({ gateway: options.gateway });
    return returnService;
  };
  let exchangeService = options.afterSalesExchange || null;
  const resolveExchangeService = () => {
    if (!exchangeService) {
      exchangeService = new AfterSalesExchangeService({ gateway: options.gateway });
    }
    return exchangeService;
  };
  let jobs = options.afterSalesJobs || null;
  const resolveJobs = () => {
    if (!jobs) {
      jobs = createAfterSalesAsyncService({
        dir: options.afterSalesJobsDir,
        // #948：统一 job（状态 / 重试分类 / 失败通知发运营群）。用例注入 `options.asyncJobs`。
        asyncJobs: options.asyncJobs !== undefined ? options.asyncJobs : getAsyncJobService(),
        // 退货 / 换货共用同一条售后异步队列（payload.action 决定执行器）。
        execute: (payload, execOptions) => (payload?.action === 'exchange'
          ? resolveExchangeService().execute(payload, execOptions)
          : resolveReturnService().execute(payload, execOptions)),
        onSettled: () => resolveScanService().invalidateCache(),
      });
      jobs.start().catch((error) => logError('workbench.orders.after_sales.failed', {
        reason: 'job_start_failed', error: error.message,
      }));
    }
    return jobs;
  };

  // 退款方式候选：**唯一数据源 = 「支付方式管理」**（走统一配置缓存；不写死选项）。
  router.get('/sales/after-sales/payment-methods', async (req, res) => {
    try {
      // `?use=refund` ⇒ 只回「可用于退款」的方式（「支付方式管理」里勾了那列的）；
      // 不传 ⇒ 全部（保持既有调用方/测试的形状不变）。
      const useRefund = String(req.query?.use || '').trim() === 'refund';
      const listed = useRefund
        ? await resolvePaymentMethods().listRefundable()
        : await resolvePaymentMethods().list();
      const items = (listed?.items || []).map((item) => (typeof item === 'string' ? item : item.name));
      return res.json({ success: true, items });
    } catch (error) {
      logError('workbench.sales.after_sales.candidates.failed', {
        request_id: req.requestId, reason: 'payment_methods', error: error.message,
      });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  // 提交退货：表单 POST（不是 XHR）→ **本地形状校验**（不读飞书）→ 入队 → 立刻 303 统一 toast。
  // ⭐ 2026-11-11（业务负责人）：「我们就是要实现异步」——飞书侧校验（原单/明细/金额/退款方式）
  //   与写库全部在后台 worker；POST 不再同步读飞书（原来会等十几秒，页面像没反应）。
  router.post('/sales/after-sales/submit', async (req, res) => {
    const body = req.body || {};
    const productRecordId = String(body.productRecordId || '').trim();
    const backTo = landingPath(productRecordId);
    const payload = {
      action: 'return',
      requestId: String(body.requestId || '').trim(),
      salesEntryRecordId: String(body.salesEntryRecordId || '').trim(),
      detailRecordId: String(body.detailRecordId || '').trim(),
      moneyMode: String(body.moneyMode || '').trim(),
      paymentMethod: String(body.paymentMethod || '').trim(),
      productRecordId,
      operatorOpenId: req.workbenchUser?.open_id || '',
    };
    try {
      // 只做本地形状校验（缺字段 / 退款必选方式）——她当场能改；飞书侧校验交给 worker。
      const shaped = resolveReturnService().validateShape(payload);
      await resolveJobs().enqueue({
        type: 'return', requestId: shaped.requestId,
        payload,
        correlation: tapIdFromRequest(req),
        // #948：状态接口"只能查自己的任务"靠它；通知里的"操作人"也用它（拿不到名字就不写）
        ownerOpenId: req.workbenchUser?.open_id || '',
        operatorName: req.workbenchUser?.name || '',
      });
      // 立刻回工作台（统一落点 + 统一 toast；不传 orderNo —— 单号在后台才读到）
      return redirectWithSubmitToast(res, {});
    } catch (error) {
      logError('workbench.orders.after_sales.failed', {
        request_id: req.requestId, reason: 'submit', error: error.message,
      });
      const message = error?.statusCode === 400 ? error.message : AFTER_SALES_DERIVED.texts.submitFailed;
      return res.redirect(303, `${backTo}${backTo.includes('?') ? '&' : '?'}err=${encodeURIComponent(message)}`);
    }
  });

  // 提交换货：表单 POST → 本地形状校验（不读飞书）→ 入队 → 立刻 303 统一 toast。
  //   · 换尺码：scenario=same + newSize（金额 = 原明细金额，后台算）；
  //   · 换款式：scenario=new + newProductRecordId/newSize/newAmount（她填的实收金额）+
  //             diffPaymentMethod（有差价时她选的补/退方式）。
  router.post('/sales/after-sales/exchange/submit', async (req, res) => {
    const body = req.body || {};
    const productRecordId = String(body.productRecordId || '').trim();
    const backTo = landingPath(productRecordId);
    const payload = {
      action: 'exchange',
      requestId: String(body.requestId || '').trim(),
      salesEntryRecordId: String(body.salesEntryRecordId || '').trim(),
      detailRecordId: String(body.detailRecordId || '').trim(),
      scenario: String(body.scenario || '').trim(),
      newProductRecordId: String(body.newProductRecordId || '').trim(),
      newSize: String(body.newSize || '').trim(),
      newAmount: String(body.newAmount || '').trim(),
      diffPaymentMethod: String(body.diffPaymentMethod || '').trim(),
      samplePromotionSize: String(body.samplePromotionSize || body.sample_promotion_size || '').trim(),
      productRecordId,
      operatorOpenId: req.workbenchUser?.open_id || '',
    };
    try {
      const shaped = resolveExchangeService().validateShape(payload);
      await resolveJobs().enqueue({
        type: 'exchange', requestId: shaped.requestId, payload,
        correlation: tapIdFromRequest(req),
        ownerOpenId: req.workbenchUser?.open_id || '',
        operatorName: req.workbenchUser?.name || '',
      });
      return redirectWithSubmitToast(res, {});
    } catch (error) {
      logError('workbench.orders.after_sales.failed', {
        request_id: req.requestId, reason: 'exchange_submit', error: error.message,
      });
      const message = error?.statusCode === 400 ? error.message : AFTER_SALES_DERIVED.texts.submitFailed;
      return res.redirect(303, `${backTo}${backTo.includes('?') ? '&' : '?'}err=${encodeURIComponent(message)}`);
    }
  });

  // 后台任务状态（只读；排查/幂等用，页面不依赖它）
  router.get('/sales/after-sales/jobs/:jobId', async (req, res) => {
    const job = await resolveJobs().get(String(req.params.jobId || '').trim()).catch(() => null);
    if (!job) return res.status(404).json({ success: false, error: 'job not found' });
    return res.json({
      success: true,
      job: {
        jobId: job.job_id, status: job.status, attempts: Number(job.attempts || 0),
        error: job.last_error || '', result: job.result || null,
      },
    });
  });

  return router;
};

module.exports = { createWorkbenchOrderActionsRouter };
