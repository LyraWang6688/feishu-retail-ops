/**
 * **手机侧**的打印接口（`/api/workbench/label-print/*`）—— 她在手机上点"打印"走的就是这里。
 *
 * 三件事：① **提交**一个打印任务（`POST /jobs`，`single` 支持
 *   **按编号** / ⭐ 2026-10-14「**扫码打印**」按记录 ID（`scan` = 扫到的字符串，服务端解析）；
 *   ② **看状态**（`GET /status`，含 "打印电脑在线 / 未连接（任务已排队）"，以及最近几条任务的
 *   `已打印` / `失败 + 原因`）；③ 补打（`POST /jobs/:jobId/reprint`）。
 *
 * 🔴 **不新开鉴权**：`requireWorkbenchAccess` 是从 `routes/workbench.js` **import 复用**的那一个
 *    （与扫码页 `GET /s/:number` 同一条闸门：认证没启用 503 / 未登录 401 / 白名单外 403）。
 *    本文件**一个字都没有改** `routes/workbench.js` 的闸门 —— 只 import 它已经导出的那个函数。
 * 🔴 **不新开打印接口**：扫码打印走的仍是**这一条** `POST /jobs`（解析在服务端做，
 *    `parseLabelScanUrl` 与 `buildLabelScanUrl` 是一对反函数）。
 *
 * ⚠️ **与电脑侧共用同一个队列实例**（见 `services/labelPrintQueueRuntime.js`）：
 *    不然手机会把任务排进一个"小助手永远看不到"的队列里。
 *
 * ⚠️ **扫码页**那条【打印这一款】是**另一条路**（原生表单 POST + 服务端重渲染，不碰这个 JSON 接口）；
 *    本文件服务的是**工作台里的标签打印页**（那一页本来就有 JS，允许动态交互 ✓ 她 2026-10-12 口径）。
 */
const express = require('express');

const { requireWorkbenchAccess } = require('./workbench');
const { getLabelPrintQueue } = require('../services/labelPrintQueueRuntime');
const { parseLabelScanUrl } = require('../services/labelPrintService');
const { logError, logWarn } = require('../utils/logger');
const { STATES, SOURCES } = require('../config/labelPrintQueue');

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
    // ⭐⭐ 2026-10-14「**扫码打印**」（她选了 ⓐ「扫完直接打印这一张」）：
    //   页面把**扫到的字符串原样**交上来（`scan`），由**服务端**按 `config/tagQrCode.js` 的
    //   URL 形状解析（`parseLabelScanUrl` 与 `buildLabelScanUrl` 是**一对反函数**，
    //   全仓只有这一份形状 ✗ 页面不抄第二份）⇒ 拿到**记录 ID** ⇒ 交给下面的 `enqueueSingle`。
    //   🔴 **不新开打印接口**：走的仍是这一条 `POST /jobs` 与同一个队列实例。
    //   ⚠️ 认不出来 ⇒ **400 + 可操作的人话**（不是 500、不静默、不猜 ✗）。
    const scan = String(req.body?.scan || '').trim();
    // ⭐ 打印方向：**不传 = 跟随服务器配置**（`artifact.rotate`）；
    //    传了 = 只对这一次生效（她试"90° 还是 270° 对"时，一次部署就能试完，不用改配置重启）。
    //    ⚠️ 只认 0/90/180/270 —— 别的值由 service 当场抛错（400），不静默按 0 印。
    const rotate = req.body?.rotate === undefined || req.body?.rotate === null || req.body?.rotate === ''
      ? undefined
      : req.body.rotate;
    // ⭐⭐ 画布方向也可以按这一次覆盖：`portrait` = **旋转画布**（方向对 + 原尺寸铺满）。
    const canvas = req.body?.canvas === undefined || req.body?.canvas === null || req.body?.canvas === ''
      ? undefined
      : req.body.canvas;
    try {
      const queue = service();
      let result;
      if (mode === 'batch') {
        result = await queue.enqueueBatch({
          filters: req.body?.filters || {}, actor, submitKey, again, rotate, canvas,
        });
      } else if (scan) {
        // ⭐ 「扫码打印」：先按形状解析（**服务端唯一一份**，与 `buildLabelScanUrl` 反函数）。
        const parsed = parseLabelScanUrl(scan);
        if (!parsed.ok) {
          // **人话拒绝**：400 + 原因码进日志（她要的是"这是什么、该怎么办"，不是"格式不对"）。
          logWarn('workbench.label_print.scan.rejected', {
            request_id: req.requestId, reason: parsed.reason,
          });
          return res.status(400).json({ success: false, error: parsed.message, reason: parsed.reason });
        }
        result = await queue.enqueueSingle({
          recordId: parsed.value,
          actor,
          submitKey,
          again,
          rotate,
          canvas,
          // 从工作台页面扫的 ⇒ 来源如实记 `workbench`（排障时与扫码页那条区分得开）。
          source: SOURCES.workbench,
        });
      } else {
        result = await queue.enqueueSingle({
          number: req.body?.number, actor, submitKey, again, rotate, canvas,
        });
      }
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
