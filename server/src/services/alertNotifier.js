'use strict';

/**
 * 观测告警的**发送器**（唯一依赖飞书的地方；与判定器解耦，测试注入假 sender 即可）。
 * 收件群：`OBSERVABILITY_ALERTS_CHAT_ID` 优先；否则复用既有 `PURCHASE_CHAT_ID`。
 * 没配群 ⇒ 只打 warn（`observability.alert.skipped`），绝不发私聊/回落到别的群。
 */
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { resolvePurchaseChatId } = require('../config/groupPurchase');
const { OBSERVABILITY_ALERTS } = require('../config/alerts');
const { logWarn, logInfo } = require('../utils/logger');

const createAlertNotifier = ({ config = OBSERVABILITY_ALERTS, clientFactory } = {}) => {
  let client;
  const getClient = () => {
    if (client) return client;
    if (clientFactory) { client = clientFactory(); return client; }
    const { appId, appSecret } = getLarkAgentCredentials();
    client = new lark.Client({ appId, appSecret, logger: larkLogger });
    return client;
  };
  return async (alert) => {
    const chatId = String(config.chatId || '').trim() || resolvePurchaseChatId();
    if (!chatId) {
      logWarn('observability.alert.skipped', { rule: alert.rule, reason: 'no_chat_id' });
      return false;
    }
    try {
      const response = await getClient().im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: alert.text }) },
      });
      if (response.code !== 0) throw new Error(`code=${response.code} msg=${response.msg}`);
      logInfo('observability.alert.sent', { rule: alert.rule, key: alert.key });
      return true;
    } catch (error) {
      logWarn('observability.alert.failed', { rule: alert.rule, error: String(error.message || error).slice(0, 200) });
      return false;
    }
  };
};

module.exports = { createAlertNotifier };
