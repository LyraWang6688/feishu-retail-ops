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

/**
 * ⚠️ 2026-10-15（intake-finish 接手时修的**真 bug**，不是口径问题）：
 *   第二位实现者给「配品销售」支路写了 `options.accessorySaleIntakeConfig` / `options.accessorySaleIntake`，
 *   但本工厂的第二个形参当时是**解构**写法 `({ heartbeat } = {})` ⇒ 函数体里**根本没有 `options` 这个名字**
 *   ⇒ 每个 `drive.file.bitable_record_changed_v1` 事件都在这一行抛 `ReferenceError: options is not defined`，
 *   **整条表变更事件（含既有的「货品信息 → 标签二维码」）都会炸** —— `test/larkEvents.test.js` 当场红。
 *   ⇒ 改成 `{ heartbeat, ...options }`：既有调用 `(service)` / `(service, { heartbeat })` **逐字兼容** ✓，
 *   同时把其余配置（`accessorySaleIntake` / `accessorySaleIntakeConfig` / `accessorySaleScanWrite` /
 *   `gateway`）**原样透传**给下面那条支路（用例可注入计数替身 ✓）。
 */
const createLarkEventHandlers = (service, { heartbeat, ...options } = {}) => ({
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
    // ⛔⛔ 2026-10-09：**「信息填写」报单入口整块删除**。
    //
    // 事实：业务负责人把那张表（`purchaseReport`，`tblo0ffzFt7vyQw2`）**整个从 Base 删掉了**
    //   ⇒ 这里原先按 `V1_BITABLE_SCHEMA.tables.purchaseReport.tableId` 分派 `supplier-report`
    //   的 `purchaseIntake` 表、以及「把同一 action_list 的多条记录收成一包交给
    //   `purchaseWebhooks.acceptMany`」那一段（连同它的 `recordsByIntake` 台账）**全部删除**。
    //   她的口径是**「自然语言 ＋ AI 录入」整套退场** —— 这条就是从"表变更事件"进来的那条链。
    //
    // ⇒ 现在本分支对**任何**表的记录变更都**不做采购分派**：
    //   · 采购申请不再由"表里新增一行"触发；它由**扫码补货报单 / 工作台**直接调
    //     `PurchaseWebhookService.publishPurchaseRequest`（免确认那条路，一行没动）；
    //   · 到货仍然只由**群话题对话式核对**驱动（见文件上面对 arrival 的说明）；
    //   · 下面「货品信息 → 标签二维码」那条支路**不受影响**，照旧按 table_id 分派。
    //
    // ⚠️ 恢复这条入口（她改主意时）= **重新实现**：从 git 历史取回 `acceptMany` 与
    //    那一串解析方法（`git log -S 'ensureReportBatchNo'`），不是翻开关。

    // ── 货品信息：「标签二维码」自动补齐（**新增** / **编号变更**才触发）──────────────
    //
    // ⚠️ 2026-10-08 新增的**另一条支路**；2026-10-09 报单入口退场之后，
    //    这里成了**本分支唯一还会按 table_id 分派**的地方：
    //    · 这里按 **table_id 分派**（`schema.tables.product.tableId`，**不写死表 ID**）：
    //      只有"事件来自货品信息表"时才进这条支路，别的表的事件根本不会走到这里。
    //    · 「哪条动作要出码」（新增 / 修改）与「编号变没变」的判定**不在路由里**，
    //      整个 `action_list` 原样交给 `tagQrCodes.handleTableChanges`，
    //      口径在 `config/tagQrCode.js`（`events.created` / `events.updated`）+ 那个 service 里。
    //      ⇒ 将来加一个触发动作只改配置，不用碰这个路由。
    //    · 写库是**异步**的（`setImmediate`，沿用本文件既有形状），不阻塞事件响应。
    const productTableId = V1_BITABLE_SCHEMA.tables.product.tableId;
    if (productTableId && tableId === productTableId) {
      const tagQrCodes = service?.tagQrCodes;
      if (tagQrCodes && typeof tagQrCodes.handleTableChanges === 'function') {
        setImmediate(() => {
          tagQrCodes.handleTableChanges(actionList).catch((error) => {
            logError('product.tag_qr.dispatch_failed', { table_id: tableId, error: error.message });
          });
        });
      } else {
        // 没接线时给一条**明确的**排查线索，而不是静默什么都不做。
        logWarn('product.tag_qr.not_wired', { table_id: tableId, action_count: actionList.length });
      }
    }

    // ── 配品销售（她 2026-10-15 新建的那张表）：**入口换了，处理照旧** ─────────────
    //   她逐字：「这就相当于实际上我们只是换了一个让用户交互的入口。但是我们**一旦收到这样的一个请求，
    //   还是要做同样的处理：销售主表、销售明细以及收款明细**」✓
    //   ⚠️ table_id **走配置**（`config/accessorySaleIntake`，不写死 ✗）；字段名/触发动作/开关也都在那份配置里
    //   ⚠️ 写服务**在路由内现场建**（`options.accessorySaleIntake` 优先 ⇒ 用例可注入；**不动 `app.js`** ✓）
    //   ⚠️ 配置读不出来（例如环境变量被填成认不出的值 ⇒ `readFlag` 当场抛）**只许影响这一条新支路** ✗：
    //      同一次事件里「货品信息 → 标签二维码」那条支路**必须照跑**（解耦 ✓ 一条链路的配置问题
    //      绝不许把另一条在线链路一起带走 —— 这正是本项目"换掉一条链路不影响别的"的要求）。
    let accessorySaleTableId = '';
    try {
      accessorySaleTableId = (options.accessorySaleIntakeConfig
        || require('../config/accessorySaleIntake').resolveAccessorySaleIntakeConfig()).tableId;
    } catch (error) {
      logError('accessory_sale_intake.config_invalid', { table_id: tableId, error: error.message });
    }
    if (accessorySaleTableId && tableId === accessorySaleTableId) {
      const intake = resolveAccessorySaleIntake(service, options);
      if (intake && typeof intake.handleTableChanges === 'function') {
        setImmediate(() => {
          // ⚠️ 把**整个事件**一起交下去：这条支路要用它取**操作人**（谁填的表谁是录单人 ⇒ 主表「录单人」列）
          intake.handleTableChanges(actionList, { event }).catch((error) => {
            logError('accessory_sale_intake.dispatch_failed', { table_id: tableId, error: error.message });
          });
        });
      } else {
        logWarn('accessory_sale_intake.not_wired', { table_id: tableId, action_count: actionList.length });
      }
    }

    return {};
  },
});

// 飞书事件回调的 envelope 形状：challenge（URL 验证）/ header（v2 事件）/ type（v1 事件）。
// 只用来决定"要不要记心跳"，不参与任何业务判据。
/**
 * ⭐ 2026-10-15：把那条约会写库的链**在路由内建起来**（`options.accessorySaleIntake` 优先 ⇒ 用例可注入 ✓）。
 * 为什么不放 `app.js`：本刀只想碰"入口那半边"（写作用域 ✓），
 * 而它要的只是**一个既有网关实例**（`service.gateway` / `options.gateway`）⇒ 现场建最省、也不改别人文件 ✓
 * ⚠️ 同一个进程只建一次（延迟 + 缓存）；建不起来 ⇒ 返 `null`（调用方记 `not_wired` 排查线索 ✓）
 */
let lazyAccessorySaleIntake = null;
const resolveAccessorySaleIntake = (service, options = {}) => {
  if (options.accessorySaleIntake) return options.accessorySaleIntake;
  if (lazyAccessorySaleIntake) return lazyAccessorySaleIntake;
  const gateway = options.gateway || service?.gateway;
  if (!gateway) return null;
  try {
    // eslint-disable-next-line global-require
    const { createAccessorySaleIntakeService } = require('../services/accessorySaleIntakeService');
    // eslint-disable-next-line global-require
    const { createScanWriteService } = require('../services/scanWriteService');
    // eslint-disable-next-line global-require
    const { SCAN_WRITE } = require('../config/scanWrite');
    lazyAccessorySaleIntake = createAccessorySaleIntakeService({
      gateway,
      config: options.accessorySaleIntakeConfig,
      scanWrite: options.accessorySaleScanWrite
        || createScanWriteService({ gateway, config: SCAN_WRITE }),
    });
    return lazyAccessorySaleIntake;
  } catch (error) {
    logWarn('accessory_sale_intake.build_failed', { error: error.message });
    return null;
  }
};

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
  // ⚠️ 2026-10-15：路由的 `options` 也要透传下去（否则从路由建的实例拿不到
  //    `accessorySaleIntake` / `accessorySaleIntakeConfig` / `gateway` ⇒ 那条支路只能靠"自己 require 默认配置"）
  const dispatcher = new lark.EventDispatcher({ verificationToken, encryptKey, logger: larkLogger }).register(
    createLarkEventHandlers(service, { ...options, heartbeat }),
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
