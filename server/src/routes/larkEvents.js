const express = require('express');
const lark = require('@larksuiteoapi/node-sdk');
const { LarkMvpService } = require('../services/larkMvpService');
const { logError, logInfo } = require('../utils/logger');

const createLarkEventHandlers = (service) => ({
  'im.message.receive_v1': (event) => {
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
  // 多维表格记录变更事件（替代自动化工作流，无运行次数限制）
  'drive.file.bitable_record_changed_v1': (event) => {
    const fileToken = event?.file_token || event?.fileToken;
    const tableId = event?.table_id || event?.tableId;
    const actionList = event?.action_list || event?.actionList || [];

    logInfo('lark.bitable.record_changed', {
      file_token: fileToken,
      table_id: tableId,
      action_count: actionList.length,
      actions: actionList.map((a) => ({ record_id: a?.record_id, action: a?.action })),
    });

    // 只处理我们的多维表格
    if (fileToken !== 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh') {
      return {};
    }

    // 遍历 action_list，处理每条新增记录
    for (const actionItem of actionList) {
      const recordId = actionItem?.record_id;
      const action = actionItem?.action;

      // 只处理新增记录
      if (action !== 'record_added') continue;
      if (!recordId) {
        logError('lark.bitable.record_changed.no_record_id', { table_id: tableId });
        continue;
      }

      // 判断是哪个表，调用对应的采购处理逻辑
      setImmediate(() => {
        try {
          // 供应商报单表
          if (tableId === 'tblo0ffzFt7vyQw2') {
            service.purchaseWebhooks.accept('supplier-report', recordId).catch((error) => {
              logError('lark.bitable.supplier_report.failed', { record_id: recordId, error: error.message });
            });
          }
          // 采购到货表
          else if (tableId === 'tblvLOXKESNTbZ7v') {
            service.purchaseWebhooks.accept('arrival', recordId).catch((error) => {
              logError('lark.bitable.arrival.failed', { record_id: recordId, error: error.message });
            });
          }
        } catch (error) {
          logError('lark.bitable.record_changed.handler_error', { error: error.message });
        }
      });
    }

    return {};
  },
});

const createLarkEventsRouter = (options = {}) => {
  const router = express.Router();
  const service = options.service || new LarkMvpService();
  const verificationToken = process.env.LARK_AGENT_VERIFICATION_TOKEN || '';
  const encryptKey = process.env.LARK_AGENT_ENCRYPT_KEY || '';

  if (process.env.NODE_ENV === 'production' && !verificationToken) {
    throw new Error('生产环境必须配置 LARK_AGENT_VERIFICATION_TOKEN');
  }

  // EventDispatcher validates the callback signature/token before invoking these handlers.
  // The parsed card/menu payload does not consistently retain a top-level token, so handlers
  // must not perform a second token check against the parsed business event.
  const dispatcher = new lark.EventDispatcher({ verificationToken, encryptKey }).register(
    createLarkEventHandlers(service),
  );

  // 调试用：打印所有收到的事件，确认飞书是否推送成功
  router.post('/', (req, res, next) => {
    const eventType = req.body?.header?.event_type || req.body?.event_type || 'unknown';
    const tableId = req.body?.event?.table_id || 'unknown';
    const actionCount = req.body?.event?.action_list?.length || 0;
    logInfo('lark.event.raw_received', {
      event_type: eventType,
      table_id: tableId,
      action_count: actionCount,
      has_challenge: !!req.body?.challenge,
    });
    next();
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
  createLarkEventHandlers,
};
