const express = require('express');
// ⚠️ `node:crypto` 随 `card.action.trigger`（2026-10-28 删除）一起摘掉 —— 它只用来生成
//    `interaction_id`（卡片动作的关联 id）。现在本文件不再有卡片回调。
const lark = require('@larksuiteoapi/node-sdk');
const { LarkMvpService } = require('../services/larkMvpService');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { invalidateConfigTable } = require('../services/configTableCache');
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
 *   （历史）配品销售支路曾用 `accessorySaleIntake*` 选项，2026-10-18 已随表单工作流接管删除。
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
  // ⛔ 2026-10-28：`card.action.trigger`（飞书交互卡片按钮回调）**整块删除**。
  //   依据（业务负责人现行口径）：「现在没有群聊入口，也没有旧卡片」＋「9 点群推送不再需要」
  //   ⇒ 线上已经没有任何会带按钮的卡片：群销售确认卡 / 成交提醒卡 / 到货核对卡 / 团购券确认到账卡
  //     都随各自的链路退场，`LarkMvpService.handleCardAction` 也一并删除。
  //   ⚠️ 恢复它 = **重新实现**卡片这条链路（卡片渲染 + 动作分派），不是翻一个开关。
  //   ⚠️ 下列两条**照旧保留**：① 群消息到达即静默拒绝（守卫在 `LarkMvpService.acceptMessage`）；
  //     ② 多维表格记录变更（「货品信息 → 标签二维码」那条支路）。
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
    // ⭐ 2026-10-26：配置表记录变更 ⇒ 作废对应快照；下一次读取重读（读失败仍用 lastGood）。
    //   只按 table_id 分派，表名/字段名不写死；未命中的表（业务数据表）完全不受影响。
    const configTableKeys = ['paymentMethod', 'sizeManagement', 'behavior', 'accessory', 'supplier', 'groupBuyVoucher'];
    for (const key of configTableKeys) {
      const id = V1_BITABLE_SCHEMA.tables?.[key]?.tableId;
      if (id && id === tableId) {
        invalidateConfigTable(key);
        break;
      }
    }

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
    // 开关模块 `config/purchaseArrivalIntake.js` 已于 2026-10-18 按业务负责人
    // 「前端没有就删」的口径删除（它当时已无任何读取点）。
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

    // 🔴 2026-10-18：配品已改为「工作台 → 销售 → 配品」跳飞书表单 + 多维表格工作流处理，
    //   代码侧不再监听配品表变更、不再写销售主表/明细/收款（服务与配置已删除）。
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
