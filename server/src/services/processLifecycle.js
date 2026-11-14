'use strict';

/**
 * 进程生命周期（2026-11-14，#50）：**SIGTERM/SIGINT 优雅退出 + 未处理异常留痕**。
 *
 * 为什么要有：原来全仓 `process.on` 0 处 ⇒ `pm2 restart` 直接杀进程，
 * 「正在跑的异步 job / 待落盘的写入审计」被硬切，只能等下次启动靠补发兜底。
 *
 * 这里只做三件事（不改业务语义）：
 *   1. 收到 SIGTERM / SIGINT：停止接新连接（`server.close`）→ 依次 drain（job / 审计）
 *      → 超时也退出（不卡死部署）；
 *   2. `unhandledRejection`：记 error（不退出，避免一个漏 catch 把服务弄挂）；
 *   3. `uncaughtException`：记 error → 走同一条优雅退出（进程状态已不可信）。
 */

const { logInfo, logWarn, logError } = require('../utils/logger');

// ⚠️ 不许 unref：这是**必须触发**的退出兜底超时；unref 后若事件循环里没别的 handle，
//   Node 会直接"事件循环已空"退出，导致 drain 卡住时退出处理器永远不返回（CI 实测）。
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 可单测的退出处理器：server + drains + 超时，全部可注入。 */
const createShutdownHandler = ({
  server,
  drains = [],
  timeoutMs = 10000,
  logger = { logInfo, logWarn },
  exit = (code) => process.exit(code),
} = {}) => {
  let started = false;
  return async (signal = 'SIGTERM', code = 0) => {
    if (started) return;
    started = true;
    logger.logInfo('process.shutdown.start', { signal, timeout_ms: timeoutMs, drains: drains.length });
    // ① 停止接新连接（不 await 回调本身，下面用超时兜底）
    if (server && typeof server.close === 'function') {
      server.close(() => {});
    }
    // ② 依次 drain（每个 drain 独立超时，避免一个卡死拖垮退出）
    for (let index = 0; index < drains.length; index += 1) {
      const drain = drains[index];
      try {
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([Promise.resolve().then(() => drain()), sleep(timeoutMs)]);
      } catch (error) {
        logger.logWarn('process.shutdown.drain_failed', {
          index,
          error: String(error?.message || error).slice(0, 200),
        });
      }
    }
    logger.logInfo('process.shutdown.done', { signal, code });
    exit(code);
  };
};

/** 注册 SIGTERM/SIGINT（只注册一次；重复调用无害）。 */
const installGracefulShutdown = ({ server, drains = [], timeoutMs, logger } = {}) => {
  const handler = createShutdownHandler({ server, drains, timeoutMs, logger });
  process.on('SIGTERM', () => { handler('SIGTERM', 0); });
  process.on('SIGINT', () => { handler('SIGINT', 0); });
  return handler;
};

/** 未处理异常/拒绝的兜底（不再静默；uncaughtException 走优雅退出）。 */
const installProcessGuards = ({ onFatal, logger = { logWarn, logError } } = {}) => {
  process.on('unhandledRejection', (reason) => {
    logger.logWarn('process.unhandled_rejection', {
      error: String(reason && reason.message ? reason.message : reason).slice(0, 300),
    });
  });
  process.on('uncaughtException', (error) => {
    logger.logError('process.uncaught_exception', {
      error: String(error && error.message ? error.message : error).slice(0, 300),
      stack: String(error && error.stack ? error.stack : '').slice(0, 2000),
    });
    if (typeof onFatal === 'function') Promise.resolve(onFatal(error)).catch(() => {});
  });
};

module.exports = {
  createShutdownHandler,
  installGracefulShutdown,
  installProcessGuards,
};
