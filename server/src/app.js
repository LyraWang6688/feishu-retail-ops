const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('node:crypto');
const { logError, logInfo } = require('./utils/logger');
const { uploadDir } = require('./utils/upload');
const { startUploadCleanup } = require('./utils/uploadCleanup');

// Load environment variables.
//
// quiet 是为日志契约服务的：dotenv 从 17 起默认会往 stdout 打一行
// "injected env (N) from .env"。本服务的日志是结构化 JSON（utils/logger.js），
// 任何非 JSON 行都会污染日志流，让"按行解析 / 按 bitable.record.* 事件过滤"
// 的排查方式失效。在 dotenv 16 上该选项会被忽略，所以这行可以先落地，
// 等依赖升到 18 时才真正生效。
dotenv.config({ path: path.join(__dirname, '../../.env'), quiet: true });

const app = express();
const port = process.env.PORT || 3000;
const workbenchPath = path.join(__dirname, '../public/workbench');

// Middleware
if (process.env.ENABLE_CORS === 'true') {
  app.use(cors());
}
// 请求体上限：**必须显式设**。
// express.json() 默认只有 100kb，超了会**直接 413 把整个请求拒掉**——
// 对飞书事件回调来说，这意味着「事件根本没进来」，而飞书侧以为推送成功了，
// 于是业务**静默消失**（违反"不静默失败"这条红线）。
// 线上确实出现过 `request entity too large` on POST /api/lark/events。
// 飞书事件本身不大，但**加密后的密文**、以及批量 record_changed（一次可带几十条 action）
// 都会明显变大，所以给到 2mb（足够宽松，同时仍是一个明确的上限）。
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const requestId = String(req.get('x-request-id') || crypto.randomUUID());
  req.requestId = requestId;
  res.set('x-request-id', requestId);
  const startedAt = Date.now();
  res.on('finish', () => {
    logInfo('http.request.completed', {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: Date.now() - startedAt,
    });
  });
  next();
});

// Feishu callbacks do not carry the project's x-api-key, so mount the verified
// Lark event endpoint before the generic /api authentication middleware.
app.use('/api/lark/events', require('./routes/larkEvents').createLarkEventsRouter());
// Feishu web-app OAuth routes are mounted before generic /api authentication.
app.use('/api/auth/feishu', require('./routes/feishuWebAuth').createFeishuWebAuthRouter());
// The workbench uses Feishu web sessions; its query and follow-up endpoints
// never expose the service credentials to the browser.
app.use('/api/workbench', require('./routes/workbench').createWorkbenchRouter());
app.use('/workbench', express.static(workbenchPath, { index: 'index.html' }));
// Feishu web apps commonly open the configured homepage as "/".
app.get('/', (req, res) => res.sendFile(path.join(workbenchPath, 'index.html')));

// Health check route. Also answers "服务器上跑的是哪一版"——部署时由 deploy_run.sh
// 写入版本号与 commit，否则回落到 package.json 的版本。
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: process.env.APP_VERSION || require('../package.json').version || 'unknown',
    commit: process.env.APP_COMMIT || '',
    deployed_at: process.env.APP_DEPLOYED_AT || '',
    timestamp: new Date().toISOString(),
  });
});

// Routes
// Legacy WeChat was retired on 2026-10-01: the frozen router and the
// miniprogram that drove it are gone, so no switch re-enables them.
app.use('/api', require('./middleware/auth'));

// Error handling middleware
app.use((err, req, res, next) => {
  logError('http.unhandled_error', {
    method: req.method,
    path: req.path,
    request_id: req.requestId,
    error: err.message,
    stack: err.stack,
  });
  const isUploadError = err && (err.name === 'MulterError' || /仅支持上传|Unexpected field/i.test(String(err.message || '')));
  if (isUploadError) {
    return res.status(400).json({ success: false, error: err.message || '上传参数错误' });
  }
  return res.status(500).json({ success: false, error: 'Internal Server Error' });
});

if (require.main === module) {
  const ttlMs = Number(process.env.UPLOAD_TTL_MS || 24 * 60 * 60 * 1000);
  const intervalMs = Number(process.env.UPLOAD_CLEAN_INTERVAL_MS || 60 * 60 * 1000);
  if (Number.isFinite(ttlMs) && ttlMs > 0 && Number.isFinite(intervalMs) && intervalMs > 0) {
    startUploadCleanup({ dir: uploadDir, ttlMs, intervalMs });
  }
  // 只监听回环地址：公网一律走 Nginx。
  //
  // 原来写的是 app.listen(port)，那会绑到 0.0.0.0（所有网卡）——等于把 Express
  // 直接暴露在公网，绕过 Nginx 的 TLS 与过滤。实测从公网 nc 该端口 TCP 握手成功。
  // Nginx 本来就是转发到 127.0.0.1:port，所以改成回环不影响任何入口。
  const host = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
  app.listen(port, host, () => {
    logInfo('server.started', { port, host });
  });
}

module.exports = app;
