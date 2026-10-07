const express = require('express');
const crypto = require('node:crypto');
const lark = require('@larksuiteoapi/node-sdk');
const { LarkMvpService } = require('../services/larkMvpService');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { larkLogger } = require('../utils/larkLogger');
const { LarkEventHeartbeat } = require('../infrastructure/larkEventHeartbeat');
const { evaluateLarkEventHeartbeat, resolveStaleMinutes } = require('../config/larkEventHeartbeat');

// 事件入口的「最后一次收到事件」心跳（记录器见 infrastructure/larkEventHeartbeat）：
// · 最外层 `recordEvent()`            —— 任何到达的请求（含飞书 URL 验证 challenge）；
// · `recordEvent({business:true})`    —— 真正带业务内容的事件（消息 / 卡片 / 自有多维表格变更）。
// 为什么 challenge 也算：**能收到验证就说明链路通**；分开记 business 是为了区分
// 「飞书只是在验证」和「真的有消息进来」（只有 challenge 说明链路在，但机器人没在干活）。
//
// 心跳是旁路观测：没注入 / 注入的对象不合规时一律静默跳过，绝不因此影响事件处理。
const recordBusinessHeartbeat = (heartbeat) => {
  if (heartbeat && typeof heartbeat.recordEvent === 'function') heartbeat.recordEvent({ business: true });
};

const createLarkEventHandlers = (service, { heartbeat } = {}) => ({
  'im.message.receive_v1': (event) => {
    recordBusinessHeartbeat(heartbeat);
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
    recordBusinessHeartbeat(heartbeat);
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
    // ⭐ 卡片动作**不再额外发一条私聊文字**（业务负责人 2026-10-06：「我们的消息卡片会变化啊！」）。
    //
    // 「点按钮后必须回一个响应」这条飞书要求由**两个东西**一起满足，两个都在，所以那条
    // 私聊文字是多余的（而且正是"私聊专属"的最后一处卡片动作出口）：
    //   ① 同步响应 —— 本 handler 的返回值（下面那句 `return { toast: … }`），飞书要求必须回；
    //   ② 业务结果 —— `handleCardAction` 内部对**那张卡片本身**的更新（updateInteractiveCard），
    //      也就是她说的"卡片会变化"。她要看到的结果在卡片上，不在私聊里。
    //
    // ⚠️ 删除的**只是那条 `sendText(operator_open_id, toast)`**，不是整个响应：
    //    卡片更新与同步 toast 都原样保留（回归用例把调用次数钉死：卡片更新 1 次 / 私聊发送 0 次）。
    // ⚠️ 顺带的好处：这条路由路径**不再认识 `operator_open_id` 作为收件人**——
    //    私聊入口整条删掉时，这里不需要跟着改。
    setImmediate(async () => {
      try {
        const result = await service.handleCardAction(event, { interactionId });
        logInfo('lark.card.handled', { interaction_id: interactionId, action: value.action,
          draft_id: value.draft_id, outcome: result?.toast?.type || 'unknown',
          result: result?.toast?.content });
      } catch (error) {
        // 失败只记日志：不给她发私聊失败提示（同上——结果反馈在卡片上），
        // 但**同步响应照旧**（handler 早就 return 了），所以点击方不会觉得"点不动"。
        logError('lark.mvp.card.failed', { interaction_id: interactionId, action: value.action,
          draft_id: value.draft_id, error: error.message });
      }
    });
    return { toast: { type: 'info', content: '已收到，正在处理' } };
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
    // 走到这里 = 我们自己的表的记录变更，算「真正带业务内容的事件」。
    recordBusinessHeartbeat(heartbeat);

    // ⚠️ 2026-10-05：业务负责人把「采购到货」表的识别字段（类型/识别状态/识别失败原因）删了，
    // 并决定「拍照 → 识别 → 入库」这条链路整体退场（改成纯对话驱动）。
    // 「类型」「识别状态」「识别失败原因」三个字段已不在生产表里，识别流程也没有出口了，
    // 所以这里**把 arrival 从分派表里摘掉**：往那张表新增记录不再触发任何事。
    // ⚠️ 2026-10-07 晚：那张表（「到货验收」）**已被她整个删除**，到货落点搬到「报货批次」——
    //    所以现在连"那张表的新增事件"都不存在了，下面原有的 `arrivalTableId` 判据一并删除。
    //    这里保留这段历史说明：**arrival 不再是本文件里的一个 kind，将来也别加回来**
    //   （到货只由「群话题对话式核对」驱动，不靠表变更事件）。
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

      // ⚠️ 2026-10-07 晚：原先这里有一段「往「到货验收」表新增 → 记一条
      //    lark.intake.arrival_retired 日志并 continue」的排查线索。那张表已被删除 ⇒ 删除。
      //    （保留这条注释是为了让下一次改这里的人知道：这里**曾经**有一段到货相关的分派。）

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

// 飞书事件回调的 envelope 形状：challenge（URL 验证）/ header（v2 事件）/ type（v1 事件）。
// 只用来决定"要不要记心跳"，不参与任何业务判据。
const looksLikeLarkEnvelope = (body) =>
  Boolean(body && typeof body === 'object' && (body.challenge || body.header || body.event || body.type));

const createLarkEventsRouter = (options = {}) => {
  const router = express.Router();
  const service = options.service || new LarkMvpService();
  // 心跳记录器（内存 + server/data/lark_event_heartbeat.json）。测试可注入假的。
  const heartbeat = options.heartbeat || new LarkEventHeartbeat();
  const verificationToken = process.env.LARK_AGENT_VERIFICATION_TOKEN || '';
  const encryptKey = process.env.LARK_AGENT_ENCRYPT_KEY || '';

  if (process.env.NODE_ENV === 'production' && !verificationToken) {
    throw new Error('生产环境必须配置 LARK_AGENT_VERIFICATION_TOKEN');
  }

  // EventDispatcher validates the callback signature/token before invoking these handlers.
  // The parsed card/menu payload does not consistently retain a top-level token, so handlers
  // must not perform a second token check against the parsed business event.
  const dispatcher = new lark.EventDispatcher({ verificationToken, encryptKey, logger: larkLogger }).register(
    createLarkEventHandlers(service, { heartbeat }),
  );

  // 手动处理飞书 URL 验证的 challenge 请求（SDK 的 autoChallenge 未生效）
  router.post('/', (req, res, next) => {
    // 心跳记在**最外层**：任何到达的事件都算"链路是通的"，challenge 也算
    // （能收到验证就说明飞书找得到我们）。
    // ⚠️ 这个端点是公网可达的（飞书回调必须如此），所以只认**飞书信封**的请求：
    //    否则任何扫描器 POST 一个空 body 都能把心跳刷新成"刚刚收到"，把真正的
    //    "回调地址填错"掩盖掉——监控被喂假数据比没有监控更糟。
    if (looksLikeLarkEnvelope(req.body)) heartbeat.recordEvent();
    if (req.body?.challenge) {
      logInfo('lark.event.challenge', { challenge: req.body.challenge });
      return res.json({ challenge: req.body.challenge });
    }
    next();
  });

  router.post('/', lark.adaptExpress(dispatcher));
  // 事件回调健康检查。**刻意不并进主 `/health`**：那个是给负载均衡用的、要轻，
  // 加业务字段会让它承担不该承担的职责（也会让 LB 的探测与业务观测耦合）。
  router.get('/health', (_req, res) => {
    // 与自检脚本共用 config/larkEventHeartbeat 的同一套判定，避免"接口说正常、脚本说超时"。
    const snapshot = heartbeat.snapshot();
    const evaluation = evaluateLarkEventHeartbeat(snapshot, {
      staleMinutes: resolveStaleMinutes(),
      now: new Date(),
    });
    logInfo('lark.mvp.health.checked', {
      status: evaluation.status,
      minutes_since_last_event: evaluation.minutesSinceLastEvent,
      has_data: evaluation.hasData,
    });
    // mode 现在是**事实描述**（私聊 + 群里 @ 机器人），不再是"只收私聊"的声明：
    // 值写错会让排查的人以为群聊这条链路没上线。
    res.json({
      success: true,
      mode: 'p2p+group',
      schema: 'v1',
      // ── 「机器人还收不收得到消息」的心跳 ─────────────────────────────────
      // lastEventAt：任何到达的事件（含 challenge）——**主判据**；
      // lastBusinessEventAt：真正带业务内容的事件（只有 challenge 时为 null）；
      // hasData：false = 从没收到过/文件不存在 —— 与「确实很久没收到」区分开；
      // status：'ok' | 'stale'（超过 LARK_EVENT_STALE_MINUTES 分钟没事件）。
      lastEventAt: snapshot.lastEventAt,
      lastBusinessEventAt: snapshot.lastBusinessEventAt,
      minutesSinceLastEvent: evaluation.minutesSinceLastEvent,
      minutesSinceLastBusinessEvent: evaluation.minutesSinceLastBusinessEvent,
      staleMinutes: evaluation.staleMinutes,
      hasData: evaluation.hasData,
      status: evaluation.status,
    });
  });
  return router;
};

module.exports = {
  createLarkEventsRouter,
  createLarkEventHandlers,
};
