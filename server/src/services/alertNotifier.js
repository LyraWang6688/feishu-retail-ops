'use strict';

/**
 * 观测告警发送器：统一走 notificationService（CardKit v2 卡片）。
 *
 * 收件人由 config/notifications.js 的 private 目标决定：
 *   NOTIFY_PRIVATE_OPEN_ID → OBSERVABILITY_ALERTS_OPEN_ID
 * 总开关仍由 OBSERVABILITY_ALERTS_ENABLED 控制（事件注册表里的 masterEnv）。
 */
const { OBSERVABILITY_ALERTS } = require('../config/alerts');
const { logWarn, logInfo } = require('../utils/logger');
const { createDefaultNotificationService } = require('./notificationService');

const createAlertNotifier = ({
  config = OBSERVABILITY_ALERTS,
  notificationService,
  logger = { logWarn, logInfo },
} = {}) => {
  const service = notificationService || createDefaultNotificationService();
  const warn = typeof logger.logWarn === 'function' ? logger.logWarn : () => {};
  const info = typeof logger.logInfo === 'function' ? logger.logInfo : () => {};
  return async (alert) => {
    const result = await service.send('observability_alert', {
      lines: [String(alert?.text || '')],
      title: config?.prefix ? undefined : undefined,
    });
    if (!result.ok) {
      warn('observability.alert.skipped', {
        rule: alert?.rule, reason: result.reason || 'send_failed',
      });
      return false;
    }
    info('observability.alert.sent', {
      rule: alert?.rule, target: result.target, card_id: result.cardId, message_id: result.messageId,
    });
    return true;
  };
};

module.exports = { createAlertNotifier };
