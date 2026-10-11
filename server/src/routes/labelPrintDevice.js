/**
 * **电脑侧**（店里那台「打印小助手」）的接口 —— `/api/label-print/*`。
 *
 * 小助手是**没有飞书登录的无头电脑** ⇒ 用不了工作台那道身份闸门，走**独立设备令牌**
 * （请求头 `x-label-print-token`，值从环境变量 `LABEL_PRINT_DEVICE_TOKEN` 读，**不许硬编码**）。
 *
 * 四个接口，正好对应她 2026-10-11 的四条要求：
 *
 * | 接口 | 干什么 | 对应她的哪句话 |
 * | --- | --- | --- |
 * | `GET  /stream`   | ⭐ **SSE 长连接**：一有任务**立刻推** | 「可以做事件触发吗？」 |
 * | `GET  /pending`  | ⭐⭐ **启动补拉**：开机第一件事把排队的全取回 | 「不一定常开机」 |
 * | `POST /jobs/next`| 认领最老一条（长轮询备选通道） | 同上（`transport: 'longpoll'` 时用） |
 * | `POST /jobs/:id/ack` | 回执 `done` / `failed + 原因` | 「一眼看得见状态」「失败给原因」 |
 * | `GET  /jobs/:id/artifact` | 下载那份 **PDF**（小助手只负责送进打印机） | 「小助手不懂业务，最稳」 |
 *
 * ⚠️ **SSE 不需要改服务器 Nginx 配置**（白名单已经把 `^~ /api/` 整段放行）：
 *    · 唯一的坑是 Nginx 默认 `proxy_buffering on` 会把事件**憋住** ⇒ 回一个
 *      **`X-Accel-Buffering: no`** 头就关掉了（Nginx 认这个头）；
 *    · `proxy_read_timeout` 默认 60s ⇒ 用 **20s 一条 `: ping` 注释心跳**顶住（那个心跳同时兼作在线心跳）。
 *    这两条都在下面落地，**没有任何需要运维改的东西**。
 *
 * ⚠️ **令牌没配 = 大声报错**：`503` + 人话 + error 日志（绝不静默放行、也绝不回退到任何默认令牌）。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { getLabelPrintQueue } = require('../services/labelPrintQueueRuntime');
const { resolveLabelPrintQueueConfig, STATES } = require('../config/labelPrintQueue');
const { logError, logInfo, logWarn } = require('../utils/logger');

/** 定长比较（`crypto.timingSafeEqual` 要求两个 Buffer 等长，所以先比长度）。 */
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/** 一条 SSE 事件（`data` 一律 JSON —— 小助手解析起来没有歧义）。 */
const sendEvent = (res, event, payload) => {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
};

const createLabelPrintDeviceRouter = (options = {}) => {
  const router = express.Router();
  const config = options.config || resolveLabelPrintQueueConfig();
  const service = () => getLabelPrintQueue(options);
  const requestedDeviceId = (req) => String(req.get(config.device.idHeader) || config.device.id || '').trim()
    || config.device.id;

  /**
   * 设备令牌闸门。⚠️ 它**故意**不是工作台那一道：小助手没有飞书会话。
   * 令牌不存在 ⇒ 503（配错了要一眼看出来，而不是"点了没反应"）。
   */
  router.use((req, res, next) => {
    const expected = String(config.device.token || '');
    if (!expected) {
      logError('label_print.device.token_missing', { path: req.path, env: config.device.tokenEnv });
      return res.status(503).json({
        success: false,
        error: `打印小助手的令牌没有配置（${config.device.tokenEnv}）—— 请在服务器 .env 里配上，再重启服务`,
        device_token_missing: true,
      });
    }
    const provided = req.get(config.device.header) || '';
    if (!safeEqual(provided, expected)) {
      logWarn('label_print.device.rejected', {
        path: req.path,
        reason: provided ? 'invalid_token' : 'missing_token',
        ip: req.ip,
      });
      return res.status(401).json({ success: false, error: '打印小助手的令牌不对（请核对 config.json 里的 deviceToken）' });
    }
    req.labelPrintDeviceId = requestedDeviceId(req);
    // ⭐ **任何一次通过令牌的请求都算一次心跳** —— 不只是 SSE 的 ping。
    // 为什么：万一长连接被中间设备掐了（而小助手还在用 `/pending` + `/jobs/next` 兜底干活），
    // 没有这一条的话手机上会显示"未连接"、而她那边其实正打着 —— 状态说反了比没有状态更坏。
    try {
      service().heartbeat({ deviceId: req.labelPrintDeviceId });
    } catch (error) {
      logWarn('label_print.device.heartbeat_failed', { path: req.path, error: error.message });
    }
    return next();
  });

  /**
   * 显式心跳（小助手空闲时的兜底：长连接断了它也能靠这条让手机看到"在线"）。
   * ⚠️ 真正的刷新发生在上面那道中间件里（任何请求都算），这里只是给一个语义明确的落点。
   */
  const heartbeatHandler = async (req, res) => {
    const queue = service();
    const status = await queue.status();
    return res.json({
      success: true,
      device_id: req.labelPrintDeviceId,
      last_seen_at: status.last_seen_at,
      online: status.online,
      counts: status.counts,
    });
  };
  router.get('/heartbeat', heartbeatHandler);
  router.post('/heartbeat', heartbeatHandler);

  /**
   * ⭐ **SSE 长连接**（事件推送）。这是"她一点打印、秒级出纸"的那条通道。
   *
   * 连上时**立刻**发两条：`hello`（服务器此刻的状态）与 `backlog`（**现在排队的所有任务**）——
   * 后者就是"**启动补拉**"的第一道保险（第二道是 `GET /pending`，小助手启动时两条都走）。
   */
  router.get('/stream', async (req, res) => {
    const deviceId = req.labelPrintDeviceId;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // 事件流绝不能被缓存 / 被中间设备改写（`no-transform` 防压缩缓冲）。
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // ⭐ 这一个头让 Nginx **不缓冲**这条响应（无需改服务器配置）—— SSE 能不能实时全靠它。
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    service().heartbeat({ deviceId, info: { transport: 'sse' } });
    sendEvent(res, 'hello', { server_time: new Date().toISOString(), transport: 'sse' });
    let backlog = [];
    try {
      backlog = await service().listPending({ deviceId });
    } catch (error) {
      logWarn('label_print.stream.backlog_failed', { error: error.message });
    }
    sendEvent(res, 'backlog', { jobs: backlog });
    logInfo('label_print.stream.connected', { device_id: deviceId, backlog: backlog.length });

    const unsubscribe = service().subscribe((event) => {
      if (!sendEvent(res, event.type, event.payload)) cleanup();
    });
    // `: ping` 注释心跳：① 顶住 Nginx/中间设备的空闲断链；② **兼作在线心跳**（长连接活着 = 电脑在线）。
    const ping = setInterval(() => {
      if (!sendEvent(res, 'ping', { at: new Date().toISOString() })) {
        cleanup();
        return;
      }
      service().heartbeat({ deviceId, info: { transport: 'sse' } });
    }, Math.max(1000, Number(config.ssePingMs) || 20_000));
    if (typeof ping.unref === 'function') ping.unref();

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      try {
        res.end();
      } catch {
        // 客户端已经走了 —— 无事可做。
      }
      logInfo('label_print.stream.disconnected', { device_id: deviceId });
    }
    req.on('close', cleanup);
    res.on('close', cleanup);
    return undefined;
  });

  /**
   * ⭐⭐ **启动补拉**：小助手一启动（或重连后）就先调这个，把**电脑关着期间排队**的任务一次取回。
   * **只列不认领** —— 列完崩了，任务还应该是"待打印"（认领由 `/jobs/next` 逐个做）。
   */
  router.get('/pending', async (req, res) => {
    try {
      const queue = service();
      const jobs = await queue.listPending({ deviceId: req.labelPrintDeviceId });
      const status = await queue.status();
      return res.json({ success: true, jobs, online: status.online, counts: status.counts });
    } catch (error) {
      logError('label_print.device.pending.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  /**
   * **认领**最老的一条待打任务（先进先出）。没有就回 `job: null`（**不是错误**）。
   * `transport: 'longpoll'` 时可带 `?waitMs=` 挂一会儿（SSE 走不通时的备选通道；
   * ⚠️ 最长由配置钳死，且 Nginx `proxy_read_timeout` 默认 60s，所以默认只挂 25s）。
   */
  router.post('/jobs/next', async (req, res) => {
    const deviceId = req.labelPrintDeviceId;
    try {
      const queue = service();
      let job = await queue.claimNext({ deviceId });
      const rawWait = Number(req.query.waitMs ?? req.body?.waitMs ?? 0);
      const maxWait = Math.max(0, Number(config.longPollWaitMs) || 0);
      const waitMs = Number.isFinite(rawWait) ? Math.min(Math.max(0, rawWait), maxWait) : maxWait;
      if (!job && waitMs > 0) {
        await new Promise((resolve) => {
          let settled = false;
          let timer = null;
          let unsubscribe = () => {};
          const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            unsubscribe();
            resolve();
          };
          unsubscribe = queue.subscribe(finish);
          timer = setTimeout(finish, waitMs);
          if (typeof timer.unref === 'function') timer.unref();
        });
        job = await queue.claimNext({ deviceId });
      }
      return res.json({
        success: true,
        job: job ? queue.summaryOf(job) : null,
      });
    } catch (error) {
      logError('label_print.device.next.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  /** **回执**：`{ status: 'done' }` 或 `{ status: 'failed', reason: '…' }`（失败必须带原因）。 */
  router.post('/jobs/:jobId/ack', async (req, res) => {
    const jobId = String(req.params.jobId || '').trim();
    try {
      const result = await service().ack({
        jobId,
        status: req.body?.status,
        reason: req.body?.reason,
        deviceId: req.labelPrintDeviceId,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('label_print.device.ack.failed', { request_id: req.requestId, job_id: jobId, error: error.message });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  /**
   * **下载可打印产物**（PDF；`?format=png` 取首张 PNG 预览）。
   * ⚠️ 文件名**只从任务记录里取**（不接受任何外部输入的文件名）⇒ 没有路径穿越的口子。
   * ⚠️ 回一个 `x-label-print-sha256` 头，小助手可以核对下载有没有截断（它自己比对，不信任网络）。
   */
  router.get('/jobs/:jobId/artifact', async (req, res) => {
    const jobId = String(req.params.jobId || '').trim();
    try {
      const job = await service().getJob(jobId);
      if (!job) return res.status(404).json({ success: false, error: '没有这条打印任务' });
      const format = String(req.query.format || 'pdf').toLowerCase();
      const fileName = format === 'png' ? job.artifact?.png : job.artifact?.pdf;
      if (!fileName) return res.status(404).json({ success: false, error: `这条任务没有 ${format.toUpperCase()} 产物` });
      const absolute = service().artifactPath(fileName);
      if (!fs.existsSync(absolute)) return res.status(410).json({ success: false, error: '打印文件已过期（超过保留期），请重新提交打印' });
      res.set('Content-Type', format === 'png' ? 'image/png' : 'application/pdf');
      // ⚠️ 只用**文件名**（`path.basename`）——任务记录里的名字是我们自己写的，不含路径。
      res.set('Content-Disposition', `attachment; filename="${path.basename(String(fileName))}"`);
      if (job.artifact?.sha256) res.set('x-label-print-sha256', job.artifact.sha256);
      res.set('x-label-print-labels', String(job.total_labels ?? ''));
      return res.sendFile(absolute);
    } catch (error) {
      logError('label_print.device.artifact.failed', { request_id: req.requestId, job_id: jobId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  /** ⭐ **补打**（小助手本地页面上那颗按钮，人工点）：生成一条新任务。 */
  router.post('/jobs/:jobId/reprint', async (req, res) => {
    const jobId = String(req.params.jobId || '').trim();
    try {
      const result = await service().reprint({ jobId, actor: req.labelPrintDeviceId });
      return res.json({ success: true, ...result });
    } catch (error) {
      const status = error?.statusCode === 400 ? 400 : 502;
      logError('label_print.device.reprint.failed', { request_id: req.requestId, job_id: jobId, error: error.message });
      return res.status(status).json({ success: false, error: error.message });
    }
  });

  /** 小助手本地页面用的状态（在线心跳来自它自己，所以这里主要看队列计数与最近任务）。 */
  router.get('/status', async (req, res) => {
    try {
      const queue = service();
      const [status, jobs] = await Promise.all([queue.status(), queue.listJobs({ limit: 20 })]);
      return res.json({
        success: true,
        online: status.online,
        status,
        jobs: jobs.map((job) => queue.summaryOf(job)),
        states: Object.values(STATES).map((state) => ({ id: state.id, label: state.label })),
      });
    } catch (error) {
      logError('label_print.device.status.failed', { request_id: req.requestId, error: error.message });
      return res.status(502).json({ success: false, error: error.message });
    }
  });

  return router;
};

module.exports = { createLabelPrintDeviceRouter };
