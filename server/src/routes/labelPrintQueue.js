/**
 * **手机侧**的打印接口（`/api/workbench/label-print/*`）—— 她在手机上点"打印"走的就是这里。
 *
 * 两件事：① **提交**一个打印任务（`POST /jobs`）；② **看状态**（`GET /status`，含
 * "打印电脑在线 / 未连接（任务已排队）"，以及最近几条任务的 `已打印` / `失败 + 原因`）。
 *
 * 🔴 **不新开鉴权**：`requireWorkbenchAccess` 是从 `routes/workbench.js` **import 复用**的那一个
 *    （与扫码页 `GET /s/:number` 同一条闸门：认证没启用 503 / 未登录 401 / 白名单外 403）。
 *    本文件**一个字都没有改** `routes/workbench.js` —— 只 import 它已经导出的那个函数。
 *
 * ⚠️ **与电脑侧共用同一个队列实例**（见 `services/labelPrintQueueRuntime.js`）：
 *    不然手机会把任务排进一个"小助手永远看不到"的队列里。
 *
 * ⚠️ **手机端保持零 JS** 那条约束落在**扫码页**（见 `views/scanPageRenderer.js`）：
 *    那个页面是**表单 POST + 服务端重渲染**，不碰这个 JSON 接口。
 *    本文件服务的是**工作台里的标签打印页**（那一页本来就有 JS）。
 */
const express = require('express');

const { requireWorkbenchAccess } = require('./workbench');
const { getLabelPrintQueue } = require('../services/labelPrintQueueRuntime');
const { logError } = require('../utils/logger');
const { STATES } = require('../config/labelPrintQueue');

const createLabelPrintQueueRouter = (options = {}) => {
  const router = express.Router();
  // 与工作台其它接口**同一道**闸门（不新开鉴权、也不允许匿名读库存/写队列）。
  router.use(requireWorkbenchAccess);

  const service = () => getLabelPrintQueue(options);

  const fail = (res, error, event, extra = {}) => {
    const status = error?.statusCode === 400 ? 400 : (error?.statusCode === 503 ? 503 : 502);
    logError(event, {
      request_id: res.req?.requestId,
      error: error.message,
      ...extra,
    });
    return res.status(status).json({ success: false, error: error.message });
  };

  /**
   * 提交打印：`{ mode: 'single', number }` 打这一款；`{ mode: 'batch', filters }` 打一批。
   * 返回里带上**当前在线状态** ⇒ 她一点就能看到"打印电脑在线"还是"未连接（任务已排队）"。
   *
   * ⭐⭐ 2026-10-11 真机反馈（「连点几次 ⇒ 多打了好几张」）：
   *    · `submit_key` —— 表单带回来的幂等键（同一批结果一个 key）⇒ **同一个 key 只建一个任务**；
   *    · `again: true` —— **她明确要再打一份** ⇒ **绕过**防连点窗口（页面上那颗【再打一份】）。
   *    返回里的 `reused: true` = **这次没有重复提交**（页面据此说清楚，不是静默复用）。
   */
  router.post('/jobs', async (req, res) => {
    const mode = String(req.body?.mode || '').trim();
    const actor = req.workbenchUser?.open_id || '';
    const submitKey = String(req.body?.submit_key || '').trim();
    const again = req.body?.again === true || String(req.body?.again || '') === '1';
    // ⭐ 打印方向：**不传 = 跟随服务器配置**（`artifact.rotate`）；
    //    传了 = 只对这一次生效（她试"90° 还是 270° 对"时，一次部署就能试完，不用改配置重启）。
    //    ⚠️ 只认 0/90/180/270 —— 别的值由 service 当场抛错（400），不静默按 0 印。
    const rotate = req.body?.rotate === undefined || req.body?.rotate === null || req.body?.rotate === ''
      ? undefined
      : req.body.rotate;
    try {
      const queue = service();
      const result = mode === 'batch'
        ? await queue.enqueueBatch({ filters: req.body?.filters || {}, actor, submitKey, again, rotate })
        : await queue.enqueueSingle({ number: req.body?.number, actor, submitKey, again, rotate });
      const status = await queue.status();
      return res.json({
        success: true,
        ...result,
        status: {
          online: status.online,
          last_seen_at: status.last_seen_at,
          seconds_since_seen: status.seconds_since_seen,
          counts: status.counts,
        },
      });
    } catch (error) {
      return fail(res, error, 'workbench.label_print.enqueue.failed', { mode });
    }
  });

  /** 在线状态 + 最近任务（她用"刷新状态"看的就是这一条）。 */
  router.get('/status', async (req, res) => {
    try {
      const queue = service();
      const [status, jobs] = await Promise.all([
        queue.status(),
        queue.listJobs({ limit: Number(req.query.limit) || undefined }),
      ]);
      return res.json({
        success: true,
        online: status.online,
        status,
        jobs: jobs.map((job) => queue.summaryOf(job)),
        states: Object.values(STATES).map((state) => ({ id: state.id, label: state.label })),
        // ⭐ 文案随响应下来（**唯一真源**是 `config/labelPrintQueue.js` 的 `texts`）——
        //    页面不抄第二份"在线 / 未连接"那些句子（抄了就会两边慢慢走歪）。
        texts: typeof queue.texts === 'function' ? queue.texts() : {},
      });
    } catch (error) {
      return fail(res, error, 'workbench.label_print.status.failed');
    }
  });

  /** 一条任务（页面轮询某一条时用；**不返回产物字节**，只有引用与状态）。 */
  router.get('/jobs/:jobId', async (req, res) => {
    try {
      const job = await service().getJob(String(req.params.jobId || '').trim());
      if (!job) return res.status(404).json({ success: false, error: '没有这条打印任务' });
      return res.json({ success: true, job: service().summaryOf(job) });
    } catch (error) {
      return fail(res, error, 'workbench.label_print.job.failed');
    }
  });

  /** ⭐ **补打**（人工点的）：生成一条**新任务**，原任务不改（对账看得见补打过一次）。 */
  router.post('/jobs/:jobId/reprint', async (req, res) => {
    const jobId = String(req.params.jobId || '').trim();
    try {
      const result = await service().reprint({ jobId, actor: req.workbenchUser?.open_id || '' });
      return res.json({ success: true, ...result });
    } catch (error) {
      return fail(res, error, 'workbench.label_print.reprint.failed', { job_id: jobId });
    }
  });

  return router;
};

module.exports = { createLabelPrintQueueRouter };
