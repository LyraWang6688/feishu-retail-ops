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
        // 只为确认「群聊 + 引用」能不能做（不改任何行为）：
        // chat_id=该消息属于哪个会话（群聊靠它把采购单发进那个群）
        // parent_id=这条"引用/回复"的是哪一条（用户引用机器人消息时=被引用那条的 id）
        // mentions=@了谁（引用回复机器人通常会带 @机器人）；text_preview=核对 @ 占位符形态
        chat_id: event?.message?.chat_id,
        parent_id: event?.message?.parent_id,
        root_id: event?.message?.root_id,
        thread_id: event?.message?.thread_id,
        mentions: (event?.message?.mentions || []).map((mm) => ({ key: mm?.key, id: mm?.id?.open_id, name: mm?.name })),
        text_preview: String(event?.message?.content || '').slice(0, 200),
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

    // ⚠️ 2026-10-05：业务负责人把「采购到货」表的识别字段（类型/识别状态/识别失败原因）删了，
    // 并决定「拍照 → 识别 → 入库」这条链路整体退场（改成纯对话驱动）。
    // 「类型」「识别状态」「识别失败原因」三个字段已不在生产表里，识别流程也没有出口了，
    // 所以这里**把 arrival 从分派表里摘掉**：往「采购到货」表新增记录不再触发任何事。
    //
    // 为什么"摘掉"而不是"留着让它什么都不做"：留着 kind:'arrival' 的话，
    // accept('arrival') 会走进一条已经被删掉的链路——那是死路，还会在日志里
    // 伪装成"处理过了"。摘掉之后语义唯一：这条链路不存在。
    //
    // 开关模块（config/purchaseArrivalIntake.js）**刻意保留**：将来要恢复「对话到货」时，
    // 它是一个现成的、语义明确的显式开关（且已钉住"空字符串不等于关闭"那个坑）。
    // 现在它没有任何读取点，属于孤儿配置——这是有意的。
    //
    // ⚠️ 报货（supplier-report）是当前唯一的采购入口，不受影响，永远留在分派表里。
    //
    // 表 ID → 采购链路入口。**从 schema 读，不写死表 ID**：
    // 写死的话，换 Base / 多租户时这里不会报错、也不会触发——
    // 现象只是"采购没反应"，属于最难查的一类静默失效。
    const purchaseIntake = [
      { tableId: V1_BITABLE_SCHEMA.tables.purchaseReport.tableId, kind: 'supplier-report', label: '供应商报单' },
    ];
    // 到货表 ID 只用于下面那条"链路已退场"的排查日志，不再进分派表。
    const arrivalTableId = V1_BITABLE_SCHEMA.tables.purchaseArrival.tableId;

    // 遍历 action_list：同一张表的多个 record_added 收成**一包**再分派。
    //
    // 为什么：一次表单提交会写成同一张表的多条记录，飞书把它们放在同一个
    // action_list 里推过来。逐条 accept 会让这一批记录各自走一遍处理，
    // 报货链路就会出 N 张采购申请图。收成一包交给 acceptMany，语义上就是
    // 「这几条是一起来的」；即便飞书把包拆开，报货链路的批次窗口仍会把
    // 同批次号的记录归成一批（见 PurchaseWebhookService.handleReportBatch）。
    const recordsByIntake = new Map();
    for (const actionItem of actionList) {
      const recordId = actionItem?.record_id;
      const action = actionItem?.action;

      // 只处理新增记录
      if (action !== 'record_added') continue;
      if (!recordId) {
        logError('lark.bitable.record_changed.no_record_id', { table_id: tableId });
        continue;
      }

      // 开关关闭时的排查线索（保留给将来恢复「对话到货」用）：确实有人往「采购到货」
      // 表新增了记录，但这条链路当前不存在。只在**到货表真的新增**时记这一条，
      // 不在每条 Base 变更事件上刷日志——销售录入走的是同一个事件，否则日志会被淹没。
      if (arrivalTableId && tableId === arrivalTableId) {
        logInfo('lark.intake.arrival_retired', { table_id: tableId, record_id: recordId });
        continue;
      }

      const intake = purchaseIntake.find((entry) => entry.tableId && entry.tableId === tableId);
      if (!intake) continue;

      if (!recordsByIntake.has(intake.kind)) {
        recordsByIntake.set(intake.kind, { intake, recordIds: [] });
      }
      recordsByIntake.get(intake.kind).recordIds.push(recordId);
    }

    for (const { intake, recordIds } of recordsByIntake.values()) {
      setImmediate(() => {
        try {
          // acceptMany 对单条与多条都能用：多条 = 同一包一起交给处理逻辑。
          //
          // ⚠️ 第三个参数刻意把「这一包应有几条」传下去（业务负责人 2026-10-06 的最终口径：
          // 「到齐就发」）。链路不再靠时间窗决定"什么时候出图"，而是等这一包里**真正进了
          // 链路的每一条**都处理完（成功 / 跳过 / 重试 3 次读不到，都算处理完）再出图。
          // 传下去的 recordIds.length 就是"到齐"的分母——它已经筛过了（修改/删除、
          // 无 record_id、到货表都在上面 continue 掉了），所以数的是"进了链路的条数"。
          service.purchaseWebhooks.acceptMany(intake.kind, recordIds, {
            expectedCount: recordIds.length,
          }).catch((error) => {
            logError(`lark.bitable.${intake.kind}.failed`, {
              table_id: tableId, record_ids: recordIds, error: error.message,
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
    // mode 现在是**事实描述**（私聊 + 群里 @ 机器人），不再是"只收私聊"的声明：
    // 值写错会让排查的人以为群聊这条链路没上线。
    res.json({ success: true, mode: 'p2p+group', schema: 'v1' });
  });
  return router;
};

module.exports = {
  createLarkEventsRouter,
  createLarkEventHandlers,
};
