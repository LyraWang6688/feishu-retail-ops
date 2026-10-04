const express = require('express');
const crypto = require('node:crypto');
const lark = require('@larksuiteoapi/node-sdk');
const { LarkMvpService } = require('../services/larkMvpService');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { larkLogger } = require('../utils/larkLogger');

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
    const interactionId = crypto.randomUUID();
    const value = event?.action?.value || event?.event?.action?.value || {};
    const openId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    logInfo('lark.card.received', {
      interaction_id: interactionId,
      action: value.action,
      draft_id: value.draft_id,
      card_message_id: event?.context?.open_message_id || event?.open_message_id,
      operator_open_id: openId,
    });
    setImmediate(async () => {
      let result;
      try {
        result = await service.handleCardAction(event, { interactionId });
        logInfo('lark.card.handled', { interaction_id: interactionId, action: value.action,
          draft_id: value.draft_id, outcome: result?.toast?.type || 'unknown',
          result: result?.toast?.content });
      } catch (error) {
        logError('lark.mvp.card.failed', { interaction_id: interactionId, action: value.action,
          draft_id: value.draft_id, error: error.message });
        result = { toast: { type: 'error', content: `操作失败：${error.message}` } };
      }
      const message = result?.toast?.content;
      if (message && openId) {
        try {
          await service.sendText(openId, message);
          logInfo('lark.card.feedback.sent', { interaction_id: interactionId, action: value.action,
            draft_id: value.draft_id, outcome: result?.toast?.type });
        } catch (error) {
          logWarn('lark.card.feedback.failed', { interaction_id: interactionId, action: value.action,
            draft_id: value.draft_id, outcome: result?.toast?.type, error: error.message });
        }
      }
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

    // 只处理我们自己的多维表格。目标 Base 来自环境变量，不再写死；
    // 未配置时无法判断归属，忽略并告警，避免误处理别的 Base。
    let ownAppToken = '';
    try {
      ownAppToken = V1_BITABLE_SCHEMA.appToken;
    } catch (error) {
      logWarn('lark.bitable.record_changed.base_unconfigured', { error: error.message });
      return {};
    }
    if (fileToken !== ownAppToken) return {};

    // 表 ID → 采购链路入口。**从 schema 读，不写死表 ID**：
    // 写死的话，换 Base / 多租户时这里不会报错、也不会触发——
    // 现象只是"采购没反应"，属于最难查的一类静默失效。
    const purchaseIntake = [
      { tableId: V1_BITABLE_SCHEMA.tables.purchaseReport.tableId, kind: 'supplier-report', label: '供应商报单' },
      { tableId: V1_BITABLE_SCHEMA.tables.purchaseArrival.tableId, kind: 'arrival', label: '采购到货' },
    ];

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

      const intake = purchaseIntake.find((entry) => entry.tableId && entry.tableId === tableId);
      if (!intake) continue;

      setImmediate(() => {
        try {
          service.purchaseWebhooks.accept(intake.kind, recordId).catch((error) => {
            logError(`lark.bitable.${intake.kind}.failed`, {
              table_id: tableId, record_id: recordId, error: error.message,
            });
          });
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
  const dispatcher = new lark.EventDispatcher({ verificationToken, encryptKey, logger: larkLogger }).register(
    createLarkEventHandlers(service),
  );

  // 手动处理飞书 URL 验证的 challenge 请求（SDK 的 autoChallenge 未生效）
  router.post('/', (req, res, next) => {
    if (req.body?.challenge) {
      logInfo('lark.event.challenge', { challenge: req.body.challenge });
      return res.json({ challenge: req.body.challenge });
    }
    next();
  });

  router.post('/', lark.adaptExpress(dispatcher));
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
