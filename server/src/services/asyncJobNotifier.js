'use strict';

/**
 * 异步任务**失败通知**（#948 第 6 节）：最终失败（重试耗尽）后发一条结构化文本到运营群。
 *
 * 群：`ASYNC_JOB_ALERT_CHAT_ID` 优先，否则**复用既有** `PURCHASE_CHAT_ID`
 *   （该群即「邯美皮鞋运营群」；见 `config/asyncJobs.js` 的 `resolveAsyncJobChatId`）。
 *
 * 四条硬约束：
 *   ① **只发一次** —— 去重只认 `notified_at`（调用方在**发送成功**后才写它）。
 *   ② **发送失败不算业务失败** —— 只记 `async_job.notify.failed`，任务状态一个字节不改；
 *      `notified_at` 留空 ⇒ 服务重启 / 下次成功任务时还能再试（`asyncJobService.retryPending`）。
 *   ③ **群没配 → 记 `async_job.notify.chat_missing`**，不静默成功（文档 4 节的明确要求）。
 *   ④ **不发 payload**、不 @人、拿不到的字段（单号 / 操作人）**直接不写**（文档 6.3）。
 *
 * 默认发送器 = 项目现有机器人客户端（`@larksuiteoapi/node-sdk` 的 `im.message.create`），
 * 与 `services/alertNotifier.js` 同一个调用形状；**不新开机器人、不恢复群聊入口**。
 */
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { ASYNC_JOBS, resolveAsyncJobChatId } = require('../config/asyncJobs');

// 默认发送器的报错原文：仍以**配置**为唯一真源（module-level 取一次；用例注入 config 时不建真客户端）。
const SEND_FAILED_TEXT = ASYNC_JOBS.texts.sendFailed;
const { logInfo, logWarn } = require('../utils/logger');

const SHANGHAI_OFFSET_MINUTES = 480;

/** ISO / 毫秒 → 上海时间 `YYYY-MM-DD HH:MM:SS`（向她汇报与群消息一律上海时间）。 */
const formatShanghaiTime = (value, offsetMinutes = SHANGHAI_OFFSET_MINUTES) => {
  const epoch = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  const safe = Number.isFinite(epoch) ? epoch : Date.now();
  const shifted = new Date(safe + Number(offsetMinutes) * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
};

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const truncate = (text, max) => {
  const value = String(text ?? '');
  const limit = Number(max) || 0;
  return limit > 0 && value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
};

const createDefaultSendText = () => {
  let client;
  const getClient = () => {
    if (client) return client;
    const { appId, appSecret } = getLarkAgentCredentials();
    client = new lark.Client({ appId, appSecret, logger: larkLogger });
    return client;
  };
  return async (chatId, text) => {
    const response = await getClient().im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    if (response?.code !== 0) throw new Error(`${SEND_FAILED_TEXT}: ${response?.msg} (Code: ${response?.code})`);
    return { messageId: response?.data?.message_id || '' };
  };
};

/**
 * 通知文案（**唯一真源**：标题 / 各行模板 / 类型名都在 `config/asyncJobs.js`）。
 * 单号与批次只写一个（先单号后批次）；操作人只有拿到名字才写。
 */
const renderAsyncJobFailureMessage = (job = {}, config = ASYNC_JOBS) => {
  const texts = config.texts || {};
  const lineOf = texts.lineOf || {};
  const meta = job.meta || {};
  const lines = [String(texts.groupTitle || '')];
  const push = (key, value) => {
    const template = lineOf[key];
    if (!template || !value) return;
    lines.push(fill(template, { value }));
  };
  const typeLabel = (texts.typeLabels || {})[job.type] || texts.unknownType || String(job.type || '');
  push('type', typeLabel);
  push('orderNo', meta.order_no || meta.batch_no || '');
  push('operator', job.operator_name || meta.operator_name || '');
  push('step', meta.step || texts.defaultStep || '');
  push('error', truncate(job.last_error || texts.unknownError || '', config.notify?.maxErrorLength));
  push('jobId', job.job_id || '');
  push('time', formatShanghaiTime(job.finished_at || job.created_at || Date.now()));
  return lines.join('\n');
};

/**
 * @param {object} deps
 * @param {object} [deps.config]   `ASYNC_JOBS` 形状的配置（用例注入假 env 配置）
 * @param {Function} [deps.sendText] `(chatId, text) => Promise`（用例注入假发送器）
 */
const createAsyncJobNotifier = ({
  config = ASYNC_JOBS,
  sendText,
  resolveChatId = resolveAsyncJobChatId,
  logger = { logInfo, logWarn },
  now = () => new Date(),
} = {}) => {
  const sender = typeof sendText === 'function' ? sendText : createDefaultSendText();
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};

  const notify = async (job = {}) => {
    const jobId = String(job.job_id || '');
    const type = String(job.type || '');
    // ① 终态 + 目标状态（默认只有 failed）才发；每次重试都不发（文档 6.1）
    const statuses = Array.isArray(config.notify?.statuses) ? config.notify.statuses : ['failed'];
    if (!statuses.includes(String(job.status || ''))) {
      return { sent: false, reason: 'not_target_status' };
    }
    // ② 去重：同一 job 只发一次（发送成功才写 notified_at ⇒ 这里见到非空就跳过）
    if (job.notified_at) return { sent: false, reason: 'already_notified' };
    if (config.notify?.enabled !== true) {
      warn('async_job.notify.disabled', { job_id: jobId, type });
      return { sent: false, reason: 'not_enabled' };
    }
    // ③ 群：显式群优先，否则复用 PURCHASE_CHAT_ID；都没有 ⇒ **如实记 chat_missing**（不静默成功）
    const chatId = String(resolveChatId() || '').trim();
    if (!chatId) {
      warn('async_job.notify.chat_missing', {
        job_id: jobId, type,
        env: 'ASYNC_JOB_ALERT_CHAT_ID / PURCHASE_CHAT_ID',
        hint: config.texts?.hints?.chatMissing || '',
      });
      return { sent: false, reason: 'chat_missing' };
    }
    const text = renderAsyncJobFailureMessage(job, config);
    const startedAt = Date.now();
    try {
      await sender(chatId, text);
      info('async_job.notify.sent', {
        job_id: jobId, type, chat_id: chatId, duration_ms: Date.now() - startedAt,
        notified_at: now().toISOString(),
      });
      return { sent: true, reason: 'sent', chatId };
    } catch (error) {
      // 🔴 发送失败**不改业务任务状态**；只记日志、不写 notified_at ⇒ 允许后续重试
      warn('async_job.notify.failed', {
        job_id: jobId, type, chat_id: chatId,
        error: String(error?.message || error).slice(0, 300),
        duration_ms: Date.now() - startedAt,
        hint: config.texts?.hints?.notifyRetry || '',
      });
      return { sent: false, reason: 'send_failed', error: String(error?.message || error) };
    }
  };

  return { notify, render: (job) => renderAsyncJobFailureMessage(job, config), resolveChatId };
};

module.exports = {
  createAsyncJobNotifier,
  renderAsyncJobFailureMessage,
  formatShanghaiTime,
};
