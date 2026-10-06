const path = require('path');
const dotenv = require('dotenv');

// ⚠️ .env 必须在**任何业务模块之前**加载。这是顺序约束，不是代码风格。
//
// 踩过的坑（2026-10-06 线上事故）：schema 里
// `tableId: getEnv('FEISHU_V1_SIZE_TABLE_ID')` 是**模块级对象字面量**里的求值——
// require 那一刻取一次，之后就永不重算（同一份 schema 里只有 appToken 写成了 getter，
// 所以只有它不受影响）。一旦某个 service 在 dotenv 之前被 require，
// 那条 require 链上的 schema 就在**空环境**里定了稿：没有硬编码兜底的表
// （「尺码管理」「其他配品」）永久拿到空串，请求打到 `.../tables//records`，
// 飞书回 404 `404 page not found`；其余表有默认值、照常工作，
// 于是现象看起来只是"某一个功能坏了"，极难定位。
//
// 因此：require('dotenv') 本身放最前面没问题，但 **dotenv.config(...) 必须排在
// 所有业务 require 之前**。以后往下面加 require 时，不要再挪到这一行上面去。
//
// quiet 是为日志契约服务的：dotenv 从 17 起默认会往 stdout 打一行
// "injected env (N) from .env"。本服务的日志是结构化 JSON（utils/logger.js），
// 任何非 JSON 行都会污染日志流，让"按行解析 / 按 bitable.record.* 事件过滤"
// 的排查方式失效。在 dotenv 16 上该选项会被忽略，所以这行可以先落地，
// 等依赖升到 18 时才真正生效。
dotenv.config({ path: path.join(__dirname, '../../.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');
const { logError, logInfo } = require('./utils/logger');
const { uploadDir } = require('./utils/upload');
const { startUploadCleanup } = require('./utils/uploadCleanup');
const { SecondDeliveryService } = require('./services/secondDeliveryService');
const { startSecondDeliveryReminder } = require('./utils/secondDeliveryReminder');
const { PendingDealPushService } = require('./services/pendingDealPushService');
const { resolvePendingDealPushConfig } = require('./config/pendingDealPush');
// 「销售战报」定时推送（9/12/15/18/21 + 22 点收官）：service + 自己的配置。
const { SalesDailyReportService } = require('./services/salesDailyReportService');
const { resolveSalesDailyReportPushConfig } = require('./config/salesDailyReportPush');
const { startShanghaiDailyScheduler } = require('./utils/shanghaiDailyScheduler');

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
  // 「第二次交付」的每日 9 点（北京时间）成交提醒：把没成交的未付 / 预付单推成群卡片。
  // 没有 cron 依赖——setInterval 轮询 + 按天认领（见 utils/secondDeliveryReminder 与服务里
  // sendDailyReminder 的注释）。只在真正启动服务时拉起，被 require 进测试不会起定时器。
  const secondDelivery = new SecondDeliveryService();
  startSecondDeliveryReminder({ run: ({ now }) => secondDelivery.sendDailyReminder({ now }) });
  // 「维度 1」：每天 9 点（北京时间）把最近 7 天未付 / 预付、尚未成交的销售单推到群里
  // （每笔一行：单号 + 待收金额 + 深链）。**显式开关**，默认关：
  // 没配群 id 或开关关着时，连定时器都不起（配置在这里读一次，写错就在启动时吵）。
  const pendingDealPush = resolvePendingDealPushConfig();
  if (pendingDealPush.enabled) {
    const pendingDealPushService = new PendingDealPushService({ settings: pendingDealPush });
    startShanghaiDailyScheduler({
      run: ({ now }) => pendingDealPushService.sendDailyPush({ now }),
      eventPrefix: 'sales.pending_deal_push.reminder',
      hour: pendingDealPush.hour,
      intervalMs: pendingDealPush.intervalMs,
    });
  } else {
    logInfo('sales.pending_deal_push.disabled', { env: 'PENDING_DEAL_PUSH_ENABLED' });
  }
  // 「销售战报」：北京时间 9 / 12 / 15 / 18 / 21 点 ＋ 22 点（当日收官），
  // 把**消息卡片**（销售单数 / 销售金额）发到收采购图那个群的主聊天。
  // 时间点 / 群列表 / 开关都从 config/salesDailyReportPush 读（改口径不改代码）；
  // ⚠️ 过掉的时段**不补推**（12 点的战报 13 点发就是错的快照，见服务的注释）。
  const salesDailyReport = resolveSalesDailyReportPushConfig();
  if (salesDailyReport.enabled) {
    const salesDailyReportService = new SalesDailyReportService({ settings: salesDailyReport });
    startShanghaiDailyScheduler({
      run: ({ now }) => salesDailyReportService.sendReport({ now }),
      eventPrefix: 'sales.daily_report',
      hours: salesDailyReport.slots,
      intervalMs: salesDailyReport.intervalMs,
    });
    logInfo('sales.daily_report.enabled', {
      hours: salesDailyReport.hours,
      summary_hour: salesDailyReport.summaryHour,
      chat_count: salesDailyReport.chatIds.length,
      chat_from_purchase_chat_id: salesDailyReport.chatFallback,
    });
  } else {
    logInfo('sales.daily_report.disabled', { env: 'SALES_DAILY_REPORT_PUSH_ENABLED' });
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
