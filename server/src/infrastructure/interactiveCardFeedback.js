const { logInfo, logWarn } = require('../utils/logger');

const cardTarget = (task, event) => {
  const callbackId = event?.context?.open_message_id || event?.open_message_id;
  if (callbackId) return { messageId: callbackId, source: 'callback' };
  if (task?.card_message_id) return { messageId: task.card_message_id, source: 'task' };
  return { messageId: '', source: 'missing' };
};

const updateInteractiveCard = async ({ client, task, event, card, stage, interactionId,
  eventPrefix = 'lark.card.update' }) => {
  const { messageId, source } = cardTarget(task, event);
  const meta = { task_id: task?.task_id, interaction_id: interactionId,
    card_message_id: messageId, target_source: source, stage };
  if (!messageId) {
    logWarn(`${eventPrefix}.skipped`, { ...meta, reason: 'missing_message_id' });
    return false;
  }
  const startedAt = Date.now();
  try {
    const api = client?.im?.v1?.message?.patch ? client.im.v1.message : client?.im?.message;
    if (!api?.patch) throw new Error('飞书客户端不支持更新消息卡片');
    const response = await api.patch({ path: { message_id: messageId },
      data: { content: JSON.stringify(card) } });
    if (response.code !== 0) throw new Error(`${response.msg} (Code: ${response.code})`);
    logInfo(`${eventPrefix}.succeeded`, { ...meta, duration_ms: Date.now() - startedAt });
    return true;
  } catch (error) {
    logWarn(`${eventPrefix}.failed`, { ...meta, duration_ms: Date.now() - startedAt,
      error: error.message });
    return false;
  }
};

module.exports = { cardTarget, updateInteractiveCard };
