'use strict';

/**
 * 通知卡片底座（Card JSON 2.0 + CardKit v1）。
 *
 * 新通知只用 CardKit，不再使用旧消息 patch： 
 *   · 创建卡片实体：cardkit.v1.card.create → card_id
 *   · 发送：im.message.create，msg_type=interactive，content 引用 card_id
 *   · 编辑：cardkit.v1.card.update（Card JSON 2.0）
 *
 * 所有通知（私聊/群聊）共用同一张卡片结构；接收人只由 target 决定。
 */
const { NOTIFICATION_EVENTS, NOTIFICATION_TEXTS } = require('../config/notifications');

const CARD_SCHEMA = '2.0';

const asLines = (lines) => (Array.isArray(lines) ? lines : [])
  .map((line) => String(line ?? '').trim())
  .filter(Boolean);

const buildNotificationCard = (event, data = {}) => {
  if (data.card && typeof data.card === 'object') return data.card;
  const definition = NOTIFICATION_EVENTS[String(event || '')] || {};
  const title = String(data.title || definition.title || event || NOTIFICATION_TEXTS.defaultTitle);
  const lines = asLines(data.lines);
  const elements = [
    { tag: 'markdown', content: `**${title}**` },
    ...lines.map((content) => ({ tag: 'markdown', content })),
  ];
  if (data.footer) elements.push({ tag: 'markdown', content: String(data.footer) });
  return {
    schema: CARD_SCHEMA,
    config: { update_multi: true, width_mode: 'fill' },
    body: { elements },
  };
};

const assertOk = (response, action) => {
  if (!response || response.code !== 0) {
    throw new Error(`${action} 失败: ${response?.msg || 'unknown'} (Code: ${response?.code ?? 'unknown'})`);
  }
  return response;
};

const createNotificationCard = async ({ client, card }) => {
  const api = client?.cardkit?.v1?.card;
  if (!api?.create) throw new Error(NOTIFICATION_TEXTS.cardUnsupported);
  const response = assertOk(await api.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  }), NOTIFICATION_TEXTS.cardCreateFailed);
  const cardId = String(response?.data?.card_id || '');
  if (!cardId) throw new Error(NOTIFICATION_TEXTS.cardMissingId);
  return cardId;
};

const sendCardMessage = async ({ client, target, cardId, replyToMessageId = '', inThread = false }) => {
  const api = client?.im?.v1?.message || client?.im?.message;
  if (!api?.create) throw new Error(NOTIFICATION_TEXTS.messageUnsupported);
  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  const replied = String(replyToMessageId || '').trim();
  const response = assertOk(await (replied && api.reply
    ? api.reply({
      path: { message_id: replied },
      data: { msg_type: 'interactive', content, ...(inThread === true ? { reply_in_thread: true } : {}) },
    })
    : api.create({
      params: { receive_id_type: target.receiveIdType },
      data: { receive_id: target.receiveId, msg_type: 'interactive', content },
    })), NOTIFICATION_TEXTS.messageSendFailed);
  const messageId = String(response?.data?.message_id || '');
  if (!messageId) throw new Error(NOTIFICATION_TEXTS.messageMissingId);
  return messageId;
};

/** 发送一张通知卡片；返回 CardKit 的 card_id 与消息的 message_id。 */
const sendNotificationCard = async ({ client, target, card, replyToMessageId = '', inThread = false }) => {
  if (!target?.receiveId || !target?.receiveIdType) {
    throw new Error(NOTIFICATION_TEXTS.targetMissing);
  }
  const cardId = await createNotificationCard({ client, card });
  const messageId = await sendCardMessage({ client, target, cardId, replyToMessageId, inThread });
  return { cardId, messageId };
};

/** 编辑已发送卡片的全部内容（CardKit v1，卡片 JSON 2.0）。 */
const updateNotificationCard = async ({ client, cardId, card }) => {
  const api = client?.cardkit?.v1?.card;
  if (!api?.update) throw new Error(NOTIFICATION_TEXTS.updateUnsupported);
  const id = String(cardId || '');
  if (!id) throw new Error(NOTIFICATION_TEXTS.updateMissingId);
  assertOk(await api.update({
    path: { card_id: id },
    data: { type: 'card_json', data: JSON.stringify(card) },
  }), NOTIFICATION_TEXTS.cardUpdateFailed);
  return { cardId: id };
};

module.exports = {
  CARD_SCHEMA,
  buildNotificationCard,
  createNotificationCard,
  sendNotificationCard,
  updateNotificationCard,
};
