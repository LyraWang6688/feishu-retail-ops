const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const { LarkMvpService } = require('../services/larkMvpService');
const { logError, logInfo } = require('../utils/logger');

const sameToken = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && require('node:crypto').timingSafeEqual(a, b);
};

const createLarkEventsRouter = (options = {}) => {
  const router = express.Router();
  const service = options.service || new LarkMvpService();
  const verificationToken = process.env.LARK_AGENT_VERIFICATION_TOKEN || '';
  const encryptKey = process.env.LARK_AGENT_ENCRYPT_KEY || '';

  if (process.env.NODE_ENV === 'production' && !verificationToken) {
    throw new Error('生产环境必须配置 LARK_AGENT_VERIFICATION_TOKEN');
  }

  const checkToken = (event) => {
    if (verificationToken && !sameToken(event?.token, verificationToken)) {
      throw new Error('飞书回调 verification token 校验失败');
    }
  };

  const dispatcher = new lark.EventDispatcher({ verificationToken, encryptKey }).register({
    'im.message.receive_v1': (event) => {
      checkToken(event);
      logInfo('lark.event.received', {
        event_type: 'im.message.receive_v1',
        message_id: event?.message?.message_id,
        message_type: event?.message?.message_type,
        chat_type: event?.message?.chat_type,
        sender_open_id: event?.sender?.sender_id?.open_id,
      });
      setImmediate(() => {
        service.acceptMessage(event).catch((error) => {
          logError('lark.mvp.event.failed', { event_type: 'im.message.receive_v1', error: error.message });
        });
      });
      return {};
    },
    'card.action.trigger': (event) => {
      checkToken(event);
      const openId =
        event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
      logInfo('lark.card.received', {
        action: event?.action?.value?.action || event?.event?.action?.value?.action,
        draft_id: event?.action?.value?.draft_id || event?.event?.action?.value?.draft_id,
        operator_open_id: openId,
      });
      setImmediate(() => {
        service
          .handleCardAction(event)
          .then((result) => {
            const message = result?.toast?.content;
            if (message && openId) return service.sendText(openId, message);
            return undefined;
          })
          .catch(async (error) => {
            logError('lark.mvp.card.failed', { error: error.message });
            if (openId) await service.sendText(openId, `入账失败：${error.message}`).catch(() => undefined);
          });
      });
      return { toast: { type: 'info', content: '已收到，正在处理' } };
    },
    'application.bot.menu_v6': (event) => {
      checkToken(event);
      const openId =
        event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
      const eventKey = event?.event_key || event?.event?.event_key;
      logInfo('lark.bot.menu.received', { event_key: eventKey, operator_open_id: openId });
      setImmediate(() => {
        service.handleBotMenu(event).catch(async (error) => {
          logError('lark.bot.menu.failed', { event_key: eventKey, error: error.message });
          if (openId) await service.sendText(openId, `查询失败：${error.message}`).catch(() => undefined);
        });
      });
      return {};
    },
  });

  router.post('/', lark.adaptExpress(dispatcher, { autoChallenge: true }));
  router.get('/health', (_req, res) => {
    logInfo('lark.mvp.health.checked');
    res.json({ success: true, mode: 'p2p', schema: 'v1' });
  });
  return router;
};

module.exports = {
  createLarkEventsRouter,
  sameToken,
};
