const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('node:crypto');
const { logError, logInfo } = require('./utils/logger');
const { uploadDir } = require('./utils/upload');
const { startUploadCleanup } = require('./utils/uploadCleanup');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3000;
const workbenchPath = path.join(__dirname, '../public/workbench');

// Middleware
if (process.env.ENABLE_CORS === 'true') {
  app.use(cors());
}
app.use(express.json());
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

// Basic health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api', require('./middleware/auth'));
if (process.env.ENABLE_LEGACY_WECHAT !== 'false') {
  app.use('/api', require('./routes/legacyWechat').createLegacyWechatRouter());
  logInfo('legacy.wechat.enabled', { removal_state: 'frozen' });
} else {
  logInfo('legacy.wechat.disabled');
}

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
  app.listen(port, () => {
    logInfo('server.started', { port });
  });
}

module.exports = app;
