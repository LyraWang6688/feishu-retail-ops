'use strict';

/**
 * 观测告警的**发送器**（唯一依赖飞书的地方；与判定器解耦，测试注入假 sender 即可）。
 * 收件人优先级：
 *   ① `OBSERVABILITY_ALERTS_OPEN_ID`（**私发给业务负责人本人**；只发不收，不是恢复私聊入口）
 *   ② `OBSERVABILITY_ALERTS_CHAT_ID` / `PURCHASE_CHAT_ID`（发群）
 * 都没配 ⇒ 只打 warn（`observability.alert.skipped`），绝不乱发。
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
    const openId = String(config.openId || '').trim();
    const chatId = openId ? '' : (String(config.chatId || '').trim() || resolvePurchaseChatId());
    if (!openId && !chatId) {
      logWarn('observability.alert.skipped', { rule: alert.rule, reason: 'no_receiver' });
      return false;
    }
    const receiveIdType = openId ? 'open_id' : 'chat_id';
    const receiveId = openId || chatId;
    try {
      const response = await getClient().im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: alert.text }) },
      });
      if (response.code !== 0) throw new Error(`code=${response.code} msg=${response.msg}`);
      logInfo('observability.alert.sent', { rule: alert.rule, key: alert.key, receive_id_type: receiveIdType });
      return true;
    } catch (error) {
      logWarn('observability.alert.failed', { rule: alert.rule, error: String(error.message || error).slice(0, 200) });
      return false;
    }
  };
};

module.exports = { createAlertNotifier };
