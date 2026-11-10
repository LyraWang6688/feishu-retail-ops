'use strict';

/**
 * 统一通知发送/编辑服务（唯一入口）。
 *
 * 事件 → config/notifications.resolveNotification → target
 *      → Card JSON 2.0 → CardKit 创建/发送/编辑
 *
 * 本文件不读任何 CHAT_ID / OPEN_ID；目标解析全在 config/notifications.js。
 */
const { resolveNotification } = require('../config/notifications');
const {
  buildNotificationCard, sendNotificationCard, updateNotificationCard,
} = require('./notificationCard');
const { logInfo, logWarn } = require('../utils/logger');
const { NOTIFICATION_EVENTS, NOTIFICATION_TEXTS } = require('../config/notifications');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const { getLarkAgentCredentials } = require('../config/larkAgent');


const sendTextMessage = async ({ client, target, text, replyToMessageId = '', inThread = false }) => {
  const api = client?.im?.v1?.message || client?.im?.message;
  if (!api?.create) throw new Error(NOTIFICATION_TEXTS.messageUnsupported);
  const replied = String(replyToMessageId || '').trim();
  const response = replied && api.reply
    ? await api.reply({
      path: { message_id: replied },
      data: { msg_type: 'text', content: JSON.stringify({ text: String(text || '') }), ...(inThread === true ? { reply_in_thread: true } : {}) },
    })
    : await api.create({
      params: { receive_id_type: target.receiveIdType },
      data: { receive_id: target.receiveId, msg_type: 'text', content: JSON.stringify({ text: String(text || '') }) },
    });
  if (!response || response.code !== 0) throw new Error(`${NOTIFICATION_TEXTS.textSendFailed}: ${response?.msg || 'unknown'}`);
  const messageId = String(response?.data?.message_id || '');
  if (!messageId) throw new Error(NOTIFICATION_TEXTS.textMissingId);
  return { messageId, threadId: String(response?.data?.thread_id || '') };
};

const createDefaultClient = () => {
  const { appId, appSecret } = getLarkAgentCredentials();
  return new lark.Client({ appId, appSecret, logger: larkLogger });
};

const createNotificationService = ({
  client,
  resolve = resolveNotification,
  logger = { logInfo, logWarn },
} = {}) => {
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};

  const send = async (event, data = {}, options = {}) => {
    const resolved = resolve(event);
    // 显式 target 只允许覆盖**收件人**（事件本身没有开关：2026-11-11 业务负责人
    // 「事件不需要开关，因为就是要通知」）。能不能发只看目标有没有配：
    // reason = ok / target_missing / unknown_event / unknown_target。
    const target = options.target
      ? {
        ...resolved,
        ...(options.target.receiveId ? { receiveId: options.target.receiveId } : {}),
        ...(options.target.receiveIdType ? { receiveIdType: options.target.receiveIdType } : {}),
        ...(options.target.target ? { target: options.target.target } : {}),
        reason: resolved.enabled && (options.target.receiveId || resolved.receiveId) ? 'ok' : resolved.reason,
      }
      : resolved;
    if (!target.enabled || target.reason !== 'ok') {
      warn('notification.skipped', {
        event, reason: target.reason || 'disabled', target: target.target || '', source_env: target.sourceEnv || '',
      });
      return { ok: false, event, reason: target.reason || 'disabled' };
    }
    try {
      const definition = NOTIFICATION_EVENTS[event] || {};
      const format = options.format || definition.format || 'card';
      if (format === 'text') {
        const text = data.text != null ? String(data.text) : (Array.isArray(data.lines) ? data.lines.join('\n') : '');
        const sent = await sendTextMessage({
          client, target, text,
          replyToMessageId: options.replyToMessageId, inThread: options.inThread === true,
        });
        info('notification.sent', {
          event, target: target.target, receive_id_type: target.receiveIdType,
          message_id: sent.messageId, format: 'text',
        });
        return { ok: true, event, target: target.target, format: 'text', ...sent };
      }
      const card = data.card && typeof data.card === 'object'
        ? data.card : buildNotificationCard(event, data);
      const sent = await sendNotificationCard({
        client, target, card,
        replyToMessageId: options.replyToMessageId, inThread: options.inThread === true,
      });
      info('notification.sent', {
        event, target: target.target, receive_id_type: target.receiveIdType,
        card_id: sent.cardId, message_id: sent.messageId, format: 'card',
      });
      return { ok: true, event, target: target.target, format: 'card', ...sent };
    } catch (error) {
      warn('notification.failed', {
        event, target: target.target, receive_id_type: target.receiveIdType,
        error: String(error?.message || error).slice(0, 300),
      });
      return { ok: false, event, reason: 'send_failed', error: String(error?.message || error) };
    }
  };

  const update = async (event, cardId, data = {}) => {
    try {
      const card = data.card && typeof data.card === 'object'
        ? data.card : buildNotificationCard(event, data);
      const result = await updateNotificationCard({ client, cardId, card });
      info('notification.updated', { event, card_id: result.cardId });
      return { ok: true, event, ...result };
    } catch (error) {
      warn('notification.update_failed', {
        event, card_id: String(cardId || ''), error: String(error?.message || error).slice(0, 300),
      });
      return { ok: false, event, reason: 'update_failed', error: String(error?.message || error) };
    }
  };

  return { send, notify: send, update };
};

const createDefaultNotificationService = () => createNotificationService({ client: createDefaultClient() });

module.exports = { createNotificationService, createDefaultNotificationService, createDefaultClient };
