const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const doubaoService = require('./doubaoService');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { updateInteractiveCard } = require('../infrastructure/interactiveCardFeedback');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1PostingService } = require('./v1PostingService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SecondDeliveryService } = require('./secondDeliveryService');
const { SampleReplacementService } = require('./sampleReplacementService');
const { PurchaseWebhookService } = require('./purchaseWebhookService');
// `normalizeText`：新增的「货号有没有建档」判据必须与解析 A 用**同一套**货号归一
// （大小写 / 空格 / 分隔符），否则会出现「A 认得出来、判据说没有」这种自相矛盾。
const { V1ReferenceResolver, person, relation, normalizeText, normalizeColor } = require('./v1ReferenceResolver');
const { LiveInventoryIndex, buildLiveInventoryIndex } = require('./liveInventoryIndex');
const { tradeTypeLabel, deliversForTradeType } = require('../config/salesMovements');
// 「类型的唯一判据（查完库存再定）」+「录单时要跑哪些解析」的**唯一**判据来源
//（配置先行，业务负责人 2026-10-07 确认）。
// ⭐ 2026-10-07 口径大改：**类型 = 实时库存里有没有这一双**（`salesTradeTypeForStock`）
//    ⇒ A（货品信息）与 B（实时库存）**两种类型都跑**；"预定跳过库存检查"那条策略已删。
// ⭐ 粒度仍是「**逐明细一个类型** + 整单去重多选」——
//    `itemTradeTypeCode` 取某一行的类型，`orderTradeTypeCodes` 取整单去重后的那几个。
//    ⚠️ `deliveryForTradeType`（整单口径）已不再被本文件使用：交付改由
//       `deliversForTradeType` **逐行**推，不再有"整单一个交付状态"的说法。
const {
  salesTradeTypeForStock, itemTradeTypeCode, orderTradeTypeCodes,
} = require('../config/salesTradeTypePolicy');
// 「这一单交给了多少」那句结果话（全交付 / 全未交付 / **部分交付**）的文案来源。
const { salesDeliverySummaryFor } = require('../config/salesDeliverySummary');
// ⚠️ 2026-10-07：颜色候选上**不再**打「有货 / 无货」预览标注（业务负责人逐字「甲 去掉」：
//    「候选只显示颜色（黑色 / 绿色），选完 → 再查库存 → 告诉她"这双有货→现货"或"没货→预定"」）
//    ⇒ 这里只留"她选完之后读不到库存"那句文案；`SALES_COLOR_STOCK_STATUS` 已随预览一并删除。
const {
  resolveSalesColorChoiceConfig,
} = require('../config/salesColorChoice');
// 「A 之后：这个货号到底有没有在「货品信息」里建档」那道判据的开关 / 文案 / 事件名。
// ⚠️ 它与解析 A 是**两步**：A 仍然"找不到就空手回来"，本判据在它之后下结论。
const {
  SALES_PRODUCT_REGISTRATION_EVENTS,
  resolveSalesProductRegistrationConfig,
  formatMissingProductText,
} = require('../config/salesProductRegistration');
const { isDataNotReady, withSalesReadRetry } = require('./salesReadRetry');
// 「销售信息还缺…」那句追问的**文案**：把 `missing_fields` 这份**机器清单**
//（里面有 `items[0].actual_amount` 这类代码标识符）翻成**一件事一行的人话**。
// ⚠️ 它**只翻译、不判断** —— 什么情况下报缺项、报几条，一字未动（见该文件头注释）。
const { renderSalesMissingInfo } = require('../config/salesMissingInfoText');
const { allocateSalesOrderNo } = require('./salesOrderNo');
const { resolveAccessory } = require('./accessoryMatchPolicy');
const { SaleLookupService } = require('./saleLookupService');
const { AfterSalesService } = require('./afterSalesService');
const { AfterSalesFlowService } = require('./afterSalesFlowService');
const { isLookupIntent, isAfterSalesIntent, normalizeMessageIntent } = require('../config/saleIntents');
const { isAfterSalesCardAction } = require('../config/afterSalesFlow');
const { isSalesCandidate, UNSUPPORTED_INTENT_REPLY } = require('../config/messageGate');
const { salesConfirmationCard, salesStatusCard, salesProcessingCard, keepOnlyCardButton, SECOND_DELIVERY_ACTION } = require('../utils/larkCards');
// 「点确认后那一次立即更新」那张卡片的可见文案 / 颜色（业务负责人 2026-10-07 拍板的 ⓐ）；
// 调用时才解析（不在模块加载时求值，避免 dotenv 加载顺序事故）。
const { resolveSalesProcessingCardConfig } = require('../config/salesProcessingCard');
const { extractSalesMessageText, isMentioned, stripMentionPlaceholders } = require('../utils/larkMessageText');
const { resolveAckReaction, resolveBotOpenId } = require('../config/groupPurchase');
// 主群的准入口径（是否仍然要求 @）：**显式布尔、默认放宽**，见 config/groupAdmission。
const { resolveMainChatRequireMention } = require('../config/groupAdmission');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');
const { extractBatchNos } = require('./purchaseBatchNo');
// 「群话题 ↔ 销售记录」的本地路由映射（只写本地，不写业务表，见服务的注释）。
const { SalesGroupThreadLocator } = require('./salesGroupThreadLocator');
// 「消息深链存哪儿」的唯一落点（本地映射 + 销售主表「消息链接」列，见服务的注释）。
const { SalesMessageLinkService } = require('./salesMessageLinkService');
// 「这条群消息归销售还是采购」的分派（独立 service；本类只做接线）。
const { SalesGroupFlowService } = require('./salesGroupFlowService');
// 「话题里的二次处理识别」（②：预定 / 现货待收的进展同步；独立 service，本类只做接线）。
const { SalesThreadProgressService } = require('./salesThreadProgressService');
const { PROGRESS_KINDS } = require('../config/salesProgressIntake');
// 「采购到货：群话题对话式核对」的编排（独立 service；本类只做接线）。
const { PurchaseArrivalConversationService } = require('./purchaseArrivalConversationService');
// 到货核对卡片上的两个动作名（与卡片渲染共用同一份常量，见 utils/larkCards）。
const { ARRIVAL_CONVERSATION_ACTIONS } = require('../config/arrivalConversation');
const { GroupPurchaseFlowService } = require('./groupPurchaseFlowService');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { skipNoGroupContext } = require('../utils/privateChatSend');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { recordUrl } = require('../utils/feishuLinks');

// 交付与否以草稿的交易类型为准：现货当场交付，预定（货还没到 / 还没拿走）不交付。
// 只有旧数据才没有明确的交付状态（待确认或缺失），那时退回按钮语义——
// 旧卡片上的「确认已交付 / 确认未交付」是用户显式做出的选择。
const shouldDeliverFor = (task, action) => {
  const declared = task?.draft?.delivery_status;
  if (declared === '已交付' || declared === '未交付') return declared === '已交付';
  return action === 'confirm_sale_delivered';
};

// 「这一单交付了哪些行」——**逐明细**按交易类型推（现货交付并扣库存，预定不交付）。
// 判据全在配置：`deliversForTradeType`（要不要交付）+ `salesDeliverySummaryFor`（那三句话）。
// ⚠️ 抽成一处是因为它在**两处**用到（入账终态卡 + 她重复点确认时的终态卡），
//    两处必须说同一句话，否则同一状态会看到两种结果。
//
// ⚠️ `orderDelivers` 是**老草稿 / 手工草稿的兜底**：一行都没有逐行类型时（改动前建的草稿、
//    或者别处直接拼出来的 draft），退回**整单**口径 —— 与改动前逐字同义，不会凭空变样。
const deliverableItemIndexesOfDraft = (draft = {}, orderDelivers = true) => {
  const items = draft.items || [];
  const hasItemTradeTypes = items.some((item) => itemTradeTypeCode(item, '') !== '');
  if (!hasItemTradeTypes) return orderDelivers ? items.map((_, index) => index) : [];
  return items
    .map((item, index) => (deliversForTradeType(itemTradeTypeCode(item, draft.trade_type_code)) ? index : -1))
    .filter((index) => index >= 0);
};

const deliverySummaryOfDraft = (draft = {}, orderDelivers = true) =>
  salesDeliverySummaryFor(deliverableItemIndexesOfDraft(draft, orderDelivers).length, (draft.items || []).length);

const idFor = (prefix, value) =>
  `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20)}`;

const parseContent = (content) => {
  try {
    return JSON.parse(content || '{}');
  } catch (_error) {
    return {};
  }
};

const timestamp = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
};

const aggregateRecognizedItems = (items) => {
  const map = new Map();
  for (const item of items) {
    const key = [item.item_no, item.color, item.size].map((value) => String(value || '').trim()).join('|');
    if (!map.has(key)) map.set(key, { ...item, quantity: 0 });
    map.get(key).quantity += Number(item.quantity || 1);
  }
  return [...map.values()];
};

// 入口闸门：**含数字** 或 **含业务关键词** 的消息才送进 AI。
//
// 原来是"必须含数字"，会误伤"我要退货""查一下我买的鞋"这类明确诉求 —— 它们
// 被静默忽略，用户以为机器人坏了。关键词表在 config/messageGate（配置先行），
// 这里只做一行委托，加词不去改函数。
// 名字沿用 looksLikeSalesText：它是既有导出，改语义不改名字，避免动无关调用点。
const looksLikeSalesText = (text) => isSalesCandidate(text);

// 🔴 2026-10-07「私聊链路移除」：原来的 `shanghaiDay(now)` 只有 `sendTodaySales`（机器人菜单
//    「今日销售」，只有私聊点得到）在用，随它一起删了。上海自然日的算法仍在
//    `services/v1WorkbenchService` 里（工作台「今日销售」用它），要看今日销售去那儿。

class LarkMvpService {
  constructor(options = {}) {
    if (options.client) this.client = options.client;
    else {
      const { appId, appSecret } = getLarkAgentCredentials();
      this.client = new lark.Client({ appId, appSecret, logger: larkLogger });
    }
    this.gateway = options.gateway || new V1BitableGateway({ client: this.client });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.recognizer = options.recognizer || doubaoService;
    this.posting = options.posting || new V1PostingService({ gateway: this.gateway, references: this.references });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    // 「第二次交付」：已入账、尚未完成履约的单点「成交」→ 补收款 + 交付。
    // 刻意把上面那个 delivery 实例传进去：卡片这条路的交付与首次录单的交付
    // 共用同一个串行队列，两个入口不会各扣一次库存。
    this.secondDelivery = options.secondDelivery || new SecondDeliveryService({
      gateway: this.gateway, delivery: this.delivery,
    });
    this.purchaseWebhooks = options.purchaseWebhooks || new PurchaseWebhookService({
      client: this.client,
      gateway: this.gateway,
      references: this.references,
      recognizer: this.recognizer,
    });
    this.store =
      options.store ||
      new JsonTaskStore({ dir: path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id' });
    // 退换货第一期：查销售记录是**独立 service**，不把候选查询/卡片/上下文塞进本类。
    // 这里只注入"读网关 + 任务状态 + 发消息"三样依赖；网关会被 SaleLookupService
    // 再收窄成只读视图，从结构上保证这条链路写不了业务表。
    this.saleLookup = options.saleLookup || new SaleLookupService({
      gateway: this.gateway,
      store: this.store,
      replyCard: (messageId, card) => this.replyCard(messageId, card),
      // ⭐ 渠道感知的出口：群任务回复失败时回到**那个话题**，不回落私聊。
      // 🔴 2026-10-07「私聊链路移除」：**没有群上下文**的任务（`chat_type !== 'group'`）
      //   在 `sendTaskCard` 里只记一条 `lark.private_chat.send_skipped`、返 `null`。
      sendCardToTask: (task, card) => this.sendTaskCard(task, card),
    });
    // 退换货第二期：售后**编排**（定位 → 组装方案 → 确认卡片 → 调执行器）也是独立 service。
    // 本类只留"意图 → 分派"的接线：
    //   · 定位复用第一期的只读 SaleLookupService（同上一个实例，共享任务状态）；
    //   · 写入复用第二期第一步的 AfterSalesService 执行器（幂等由它自己负责）；
    //   · 卡片渲染在 utils/larkCards，本类不拼卡片内容。
    // 执行器用自己的任务存储（data/after_sales_operations），所以这里不能把销售的任务存储传给它。
    this.afterSales = options.afterSales || new AfterSalesService({ gateway: this.gateway });
    this.afterSalesFlow = options.afterSalesFlow || new AfterSalesFlowService({
      gateway: this.gateway,
      store: this.store,
      lookup: this.saleLookup,
      executor: this.afterSales,
      references: this.references,
      sizeReferences: options.sizeReferences,
      replyCard: (messageId, card) => this.replyCard(messageId, card),
      // ⭐ ③ 渠道感知的三个出口（售后回话题）：
      //   群话题里的售后任务 → 回复/卡片都回到**那个话题**；
      //   🔴 2026-10-07「私聊链路移除」：**没有群上下文**的任务 = **没有去处** ——
      //     `sendTaskCard` / `sendTaskText` 只记一条 `lark.private_chat.send_skipped`
      //     并返 `null`（**不再**回落到 `sendCard/sendText(open_id)`，那两个发送器已整体删除）。
      //     见 docs/private-chat-removal-decision-2026-10-07.md。
      replyCardToTask: (task, card) => this.replyTaskCard(task, card),
      sendCardToTask: (task, card) => this.sendTaskCard(task, card),
      sendTextToTask: (task, message) => this.sendTaskText(task, message),
      updateCard: (task, event, card, metadata) => this.updateAfterSalesCard(task, event, card, metadata),
    });
    this.sampleReplacements = options.sampleReplacements || new SampleReplacementService({
      gateway: this.gateway, inventory: this.delivery.inventory, store: this.store, client: this.client,
      updateCard: (task, event, card, metadata) => this.updateSalesActionCard(task, event, card, metadata),
      // ⭐ 渠道感知的两个出口（接线方式与上面 afterSalesFlowService 那一组**完全一致**，见 PR #148）：
      //   群话题里的补样品任务 → 卡片/文字回到**那个话题**（`reply_in_thread`）。
      //   ⚠️ 2026-10-07 私聊链路移除后，**没有群上下文的任务没有去处**：
      //     这两个出口里 `chat_type !== 'group'` 会在本类直接记日志 + 返 `null`，
      //     `SampleReplacementService` 那侧的缺省出口同样不发（它的两个 open_id 发送器已整体删除）。
      // 飞书语义（reply_in_thread）只留在本类，service 不认识 chat_type / thread_id。
      sendCardToTask: (task, card) => this.sendTaskCard(task, card),
      sendTextToTask: (task, message) => this.sendTaskText(task, message),
    });
    // 「确认状态」（用户那一维）的唯一写入口：名字与取值都在 config/salesStatusDimensions。
    // ⚠️ 它**只记她在卡片上点了什么**，不参与任何闸门判据（判据读的是「资金状态」）。
    this.salesStatus = options.salesStatus || new SalesStatusWriter({ gateway: this.gateway });
    this.intakeSchemaValidation = new Map();
    this.senderQueues = new Map();
    this.cardActionQueue = new KeyedSerialQueue();
    // ── 群聊（采购链路搬进群）────────────────────────────────────────────────
    // 「群消息 → 是哪一批采购单」的定位器。它自带本地任务存储
    // （data/purchase_group_messages），**不共用销售任务存储**：两件事的记录混在
    // 一个目录里，将来按任务翻盘时会互相干扰。
    this.purchaseBatchLocator = options.purchaseBatchLocator || new PurchaseBatchLocator({
      store: options.purchaseBatchLocatorStore,
    });
    // ── 群聊（销售链路搬进群）────────────────────────────────────────────────
    // 「这条群消息 / 这个话题 → 是哪一笔销售」的本地定位器。与采购那套**分目录、分实例**
    // （data/sales_group_threads）：销售和采购是两件事，混在一个目录里将来按任务翻盘
    // 时会互相干扰。
    // ⚠️ 业务负责人说过「这个话题不用存」——那说的是**不建业务表、不给业务表加列**；
    //    机器人要能从话题反查回那笔销售，仍然需要这份**本地**路由映射（见服务注释）。
    this.salesGroupThreads = options.salesGroupThreads || new SalesGroupThreadLocator({
      store: options.salesGroupThreadStore,
    });
    // 「把消息深链存到该存的两处」的唯一落点。业务负责人 2026-10-06 要的：
    // 本地映射（机器人回查用）＋ 销售主表「消息链接」列（她在表里点）。
    // ⚠️ 链接只可能在**发送响应**里出现（实测当前不回带），所以它挂在"我们发卡片/文字的那一刻"上。
    this.salesMessageLinks = options.salesMessageLinks || new SalesMessageLinkService({
      locator: this.salesGroupThreads,
      gateway: this.gateway,
    });
    // @ 判据用的机器人 open_id：**只从配置读，不写死**（见 config/groupPurchase）。
    // 启动时解析一次：解析结果只影响"这条群消息理不理"，不会影响私聊的既有行为。
    this.botOpenId = options.botOpenId ?? resolveBotOpenId();
    // 主群准入的第二代口径（业务负责人 2026-10-06 拍板：「主群里可不可以不 @ 机器人啊？
    // 机器人它自动就能识别销售信息」）：**默认不再要求 @**，靠正文判"像不像销售"。
    // 开关是**显式布尔**，取值在 config/groupAdmission（默认 false = 放宽 = 新行为）。
    // ⚠️ 只影响 `thread_id` 为空的主群消息；话题里的消息与**私聊**一个字节都不变。
    this.mainChatRequireMention = options.mainChatRequireMention ?? resolveMainChatRequireMention();
    if (!this.botOpenId) {
      // 没配 = 群聊里判不出 @ 机器人（`isMentioned` 对空 open_id 恒为 false）。
      // ⚠️ 放宽口径下**主群仍然能靠正文处理"像销售 / 带批次号"的消息**——
      //    所以这里的告警必须把当前口径说清楚，不能让排查的人以为"群聊整条废了"。
      logWarn('lark.group.bot_open_id_missing', {
        env: 'LARK_BOT_OPEN_ID',
        require_mention_in_main_chat: this.mainChatRequireMention,
        hint: this.mainChatRequireMention
          ? '未配置机器人 open_id 且主群要求 @：主群消息一律不处理（私聊不受影响）'
          : '未配置机器人 open_id：主群判不出 @，但正文像销售 / 带采购批次号的消息仍会处理（私聊不受影响）',
      });
    }
    // ── 到货核对（D）：「群话题对话式核对」──────────────────────────────────
    // 它只干一件事：把话题里的自然对话变成一次核对会话 + 一个触发点。
    // ⚠️ 会话任务与入库能力**共用采购那套存储与队列**（PurchaseWebhookService 的
    //   `store` / `confirmArrival`）——入库那一步就是从那个 store 读草稿的，
    //   共用一个才不会出现"会话在这边、草稿在那边"的两份状态。
    // ⚠️ 它**不复用**已退场的「拍照识别到货」任何东西（没有视觉模型、没有旧卡片动作）：
    //   那条链路删掉的字段/能力一个都不碰，这里只调保留下来的 confirmArrival。
    this.arrivalConversation = options.arrivalConversation || new PurchaseArrivalConversationService({
      gateway: this.gateway,
      // ⚠️ 会话任务必须和**入库那一步读草稿的存储**是同一个：生产路径上就是
      // PurchaseWebhookService 的 store。`|| this.store` 只是给"注入了采购服务桩"
      // 的单元测试兜底（那种桩不跑本链路），生产上永远走前面那一个。
      store: this.purchaseWebhooks.store || this.store,
      recognizer: this.recognizer,
      sizeReferences: this.purchaseWebhooks.getSizeReferences,
      confirmArrival: (taskId, task, operatorOpenId) =>
        this.purchaseWebhooks.confirmArrival(taskId, task, operatorOpenId),
      // ⭐ 2026-10-07：到货确认成功之后，把「报货批次」那一行的到货状态改成「已到货」
      //（业务负责人口径：「当用户在话题群里说了到货之后，状态应该改成「已到货」」）。
      // 接线**只做一件事**：把批次号交给那个小 service；改哪张表、写什么取值都不是这里的事。
      // ⚠️ 采购服务桩（单测注入的）可能没有 orderBatches → 退回"什么都不做"，
      //    这样注入桩的既有用例与本条链路的接线互不影响。
      markBatchArrived: (batchNo, options) => (
        this.purchaseWebhooks.orderBatches?.markArrived
          ? this.purchaseWebhooks.orderBatches.markArrived(batchNo, options)
          : Promise.resolve({ updated: false, reason: 'not_wired' })
      ),
      // ⭐ ④ 群里的反馈一律**回复那条消息**；她是在**话题**里说的（`{ threadId }`）
      //    就带 `reply_in_thread` 回到**同一个话题** —— 采购单/图是发群的，
      //    后续对话也必须留在话题里。适配器见下面的 replyPurchaseText / replyPurchaseCard。
      replyText: (messageId, content, options) => this.replyPurchaseText(messageId, content, options),
      replyCard: (messageId, card, options) => this.replyPurchaseCard(messageId, card, options),
      updateCard: (messageId, card) => this.patchCardMessage(messageId, card),
    });
    this.groupPurchaseFlow = options.groupPurchaseFlow || new GroupPurchaseFlowService({
      locator: this.purchaseBatchLocator,
      // 群里的反馈一律**引用回复**那条消息：群聊没有"上一次对话"的概念，
      // 不复用私聊的 sendText（那会发出一条没有上下文的光秃秃消息）。
      // ⭐ ④ 同上：话题里的回复也回那个话题。
      replyText: (messageId, content, options) => this.replyPurchaseText(messageId, content, options),
      // ── 到货核对（D）────────────────────────────────────────────────────
      // 定位到某一批之后，由它接管"记下来 → **收到到货反馈就直接算并出「是/否」卡片** →
      // 点「是」才入库"。它是**独立 service**：本类只做接线，不拼卡片、不写业务规则。
      // ⭐ 2026-10-07：**不再**等她先说一句"核对完毕"（业务负责人：「用户一般一句话
      //   就能够说清楚这个事情」）；`complete` 只剩诊断用途。她补充/修正时说新的一句，
      //   那边会**重算并更新同一张卡**（不发第二张）。
      // ⚠️ 会话任务和入库能力**共用采购那套存储与队列**（PurchaseWebhookService 的
      //   store / confirmArrival）——那边读草稿就是从那个 store 读的，共用一个才不会
      //   出现"会话在这边、草稿在那边"的两份状态。
      arrivalConversation: this.arrivalConversation,
    });
    // ── 群聊（销售链路）：「这条群消息归销售还是采购、是哪一笔销售」────────────
    // 它是**独立 service**：本类只做接线，定位规则一个字都不在这里。
    // 只有它说"这条归销售"时才走销售；否则**原样**交给上面那条采购链路
    // （所以采购的既有行为、既有的"认不出"文案都不受影响）。
    this.groupSalesFlow = options.groupSalesFlow || new SalesGroupFlowService({
      locator: this.salesGroupThreads,
      // 闸门用**和私聊同一把尺子**（config/messageGate）：群聊不再自己写一套判据。
      isSalesText: looksLikeSalesText,
      // 正文里的采购批次号 → 这条归采购，即便它同时含数字。
      extractPurchaseBatchNos: extractBatchNos,
      // 销售的入口（本类的方法）：分派服务只管"转交"，销售业务全在本类里。
      salesIntake: {
        startFromGroup: (payload) => this.handleGroupSaleMessage({ ...payload, sale: null }),
        continueInThread: (payload) => this.handleGroupSaleMessage(payload),
      },
    });
    // ── 群话题里的「二次处理识别」（②）──────────────────────────────────────
    // 已定位到某笔销售之后，先问它"这句话是那笔的进展同步，还是新的销售原话"。
    // 它是**独立 service**：判据（词表/正则/文案）在 config/salesProgressIntake，
    // 收钱/交货复用 PaymentService / SalesDeliveryService，本类只做接线。
    // ⚠️ 回复走 `sendTaskText`（群里回那条话题、私聊原样发私聊），
    //    与销售卡片走同一条渠道感知的出口，不另开一条发送路径。
    this.threadProgress = options.threadProgress || new SalesThreadProgressService({
      gateway: this.gateway,
      references: this.references,
      // 交付复用**本类那一个** SalesDeliveryService：全仓唯一的销售扣库存入口，
      // 与"第二次交付（点成交）"共用同一个串行队列，两个入口不会各扣一次库存。
      delivery: this.delivery,
      // ⭐ 整单完成（她说「已完毕 / 成交」）复用**本类那一个** SecondDeliveryService：
      //    点卡片「成交」按钮与她说这句话是同一件事，成交只有这一处实现。
      secondDelivery: this.secondDelivery,
      config: options.threadProgressConfig,
      now: options.now,
      store: this.store,
      sendTextToTask: (task, message) => this.sendTaskText(task, message),
    });
  }

  enqueueForSender(senderOpenId, work) {
    const previous = this.senderQueues.get(senderOpenId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.senderQueues.set(senderOpenId, next);
    const cleanup = () => {
      if (this.senderQueues.get(senderOpenId) === next) this.senderQueues.delete(senderOpenId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async ensureIntakeSchema(scope, tableKeys) {
    if (typeof this.gateway.validateTables !== 'function') return;
    if (!this.intakeSchemaValidation.has(scope)) {
      this.intakeSchemaValidation.set(scope, this.gateway.validateTables(tableKeys));
    }
    return this.intakeSchemaValidation.get(scope);
  }

  /**
   * ⭐ 私聊文字出口 —— **只留给「私聊被挡下时回一句固定文案」那一处**
   * （`acceptMessage` 的非群聊分支，见 config/privateChatNotice）。
   *
   * 🔴 2026-10-07「私聊链路移除」：同名的 `sendCard(openId, card)` 已**整体删除** ——
   *    它的调用方（注入给子服务的 `sendCard` 出口）连同子服务里那些"缺省回落发私聊"
   *    一起清掉了，于是它成了孤儿。要发卡片只有**群**这一条路
   *    （`replyCard` / `replyCardInThread` / `replyTaskCard`）。
   *    ⚠️ 别把 `sendCard` 加回来当"通用兜底"：那正是被否掉的 ⓑ 方案。
   *    见 docs/private-chat-removal-decision-2026-10-07.md。
   */
  async sendText(openId, message) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: message }),
      },
    });
    if (response.code !== 0) throw new Error(`发送飞书消息失败: ${response.msg} (Code: ${response.code})`);
  }

  /**
   * 执行确认卡片上已经选好的补样品。
   *
   * 模块边界：补样品这件事由 SampleReplacementService 负责，这里只把
   * "哪条明细、哪个货品、补哪个尺码"整理好交给它。
   */
  async applyChosenSampleReplacements(task, postingResult, { correlation } = {}) {
    const replacements = (task.draft?.items || [])
      .map((item, index) => ({
        salesDetailRecordId: postingResult?.detailRecordIds?.[index] || '',
        productRecordId: item.product_record_id || '',
        size: item.sample_replacement_size || '',
      }))
      .filter((item) => item.salesDetailRecordId && item.productRecordId && item.size);
    if (!replacements.length) return new Set();
    // 关联键继续往下传（补样品写的库存流水也属于这条销售链）。
    return this.sampleReplacements.applyPreChosen(replacements, { correlation });
  }

  /**
   * 「补样品提醒」的转发口（把渠道上下文原样透传给 `SampleReplacementService`）。
   *
   * `options.channelTask` = **触发这次交付的那条销售任务**（群销售时才有）。
   * 本类**不理解**它，只当"这是哪个任务"转交；`SampleReplacementService` 把它交给
   * 任务感知出口（`sendCardToTask`）→ 回到本类的 `sendTaskCard` → 回复进那条话题。
   * 工作台触发时没有这条任务 → 不传 → 补样品提醒**没有群上下文 = 没有去处**，
   * 出口只记一条 `lark.private_chat.send_skipped`（**没有开关**：私聊链路已整体移除）。
   */
  async notifySampleReplacements(deliveryResult, operatorOpenId, options = {}) {
    return this.sampleReplacements.notifySampleReplacements(deliveryResult, operatorOpenId, options);
  }

  // ⭐ 私聊专属功能已删（2026-10-07，随私聊入口一起移除）：
  //    · sendTodaySales —— 机器人菜单「今日销售」，只有私聊点得到
  //    · handleBotMenu  —— 那个菜单事件的处理器（路由里的 handler 也已删）
  //    ⇒ 要看今日销售去【工作台 → 销售查询】；提醒类内容走群里的定时推送。


  /**
   * 「回复某条消息」的唯一出口（私聊与群聊共用）。
   *
   * `inThread=true` → 带 `reply_in_thread: true`：飞书会把这条回复**放进话题**里
   * （主群第一条带它的回复会**创建**那个话题），响应里回带 `thread_id`。
   * ⚠️ 这是 SDK 自带的字段（`@larksuiteoapi/node-sdk` 的类型里就有
   * `im.message.reply` 的 `data.reply_in_thread`），**不新引 SDK、也不换调用方式**：
   * 私聊那条路一个字段都不加，payload 与改动前完全一样。
   *
   * 返回值统一是 `{ messageId, threadId, appLink }`：`replyText` / `replyCard` 只取 messageId，
   * 群里那两条路还要 thread_id 去记「话题 ↔ 销售」的本地映射，`appLink` 是**消息深链**——
   * ⭐ `message_app_link` 只可能在**发送响应**里出现（历史消息一定取不回来）；实测 2026-10-06
   * **这个应用当前连发送响应都不回带**（见 docs/reports/group-message-deep-link-2026-10-06.md 实测四），
   * 但哪天回带了，"发出去的那一刻"就是唯一能拿到它的时刻，所以现在就把它交回给调用方。
   */
  async replyMessage(messageId, { msgType, content, failureLabel, inThread = false }) {
    const data = { msg_type: msgType, content };
    if (inThread) data.reply_in_thread = true;
    const response = await this.client.im.message.reply({ path: { message_id: messageId }, data });
    if (response.code !== 0) throw new Error(`${failureLabel}: ${response.msg} (Code: ${response.code})`);
    return {
      messageId: response.data?.message_id || '',
      threadId: response.data?.thread_id || '',
      appLink: response.data?.message_app_link || '',
    };
  }

  async replyText(messageId, message) {
    const sent = await this.replyMessage(messageId, {
      msgType: 'text', content: JSON.stringify({ text: message }), failureLabel: '回复飞书消息失败',
    });
    return sent.messageId;
  }

  async replyCard(messageId, card) {
    const sent = await this.replyMessage(messageId, {
      msgType: 'interactive', content: JSON.stringify(card), failureLabel: '回复飞书卡片失败',
    });
    return sent.messageId;
  }

  /**
   * ⭐ ④ 「这条消息在**话题**里吗」的唯一判据在**调用方**（它才拿得到 `thread_id`），
   * 飞书语义（`reply_in_thread`）只留在本类里。两个适配器都**只做这一件事**：
   *   · `options.threadId` 非空 → 用 `reply_in_thread: true`，回复落回**同一个话题**；
   *   · 为空（主群 @ 进来）→ 与改动前逐字相同（`replyText` / `replyCard`，不带那个字段）。
   *
   * 为什么不让 service 直接认识 `reply_in_thread`：采购/销售的定位与业务规则不该
   * 绑在飞书的消息模型上（解耦）。service 只交上下文，怎么发由这里决定。
   */
  async replyPurchaseText(messageId, message, options = {}) {
    if (!options?.threadId) return this.replyText(messageId, message);
    return (await this.replyTextInThread(messageId, message)).messageId;
  }

  async replyPurchaseCard(messageId, card, options = {}) {
    if (!options?.threadId) return this.replyCard(messageId, card);
    return (await this.replyCardInThread(messageId, card)).messageId;
  }

  /** 群里专用：回复进话题（`reply_in_thread`），并把飞书回带的话题 id 一起交回去。 */
  async replyTextInThread(messageId, message) {
    return this.replyMessage(messageId, {
      msgType: 'text', content: JSON.stringify({ text: message }),
      failureLabel: '回复飞书消息失败', inThread: true,
    });
  }

  /** 群里专用：卡片回复进话题。 */
  async replyCardInThread(messageId, card) {
    return this.replyMessage(messageId, {
      msgType: 'interactive', content: JSON.stringify(card),
      failureLabel: '回复飞书卡片失败', inThread: true,
    });
  }

  /**
   * 把**已经发出去的那张卡片**改成新内容（例如「已入库」）。
   *
   * 与私聊那几张卡的 update 走的是同一套 SDK patch；区别只是这里拿的是
   * **明确的 message_id**（群话题里的卡片不是"某个销售草稿的卡"，没有 task 可以查）。
   * 卡片改不动（权限、消息被撤回）只记日志——业务事实早就落地了，不能因此判失败。
   */
  async patchCardMessage(messageId, card) {
    if (!messageId) return false;
    const patch = this.client.im?.v1?.message?.patch || this.client.im?.message?.patch;
    if (!patch) return false;
    const response = await patch.call(this.client.im?.v1?.message || this.client.im.message, {
      path: { message_id: String(messageId) },
      data: { content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw new Error(`更新飞书卡片失败: ${response.msg} (Code: ${response.code})`);
    return true;
  }

  async updateSalesActionCard(task, event, card, metadata = {}) {
    return updateInteractiveCard({ client: this.client, task, event, card,
      stage: metadata.stage, interactionId: metadata.interactionId,
      eventPrefix: task.type === 'sample_replacement' ? 'lark.sales.sample_card.update' : 'lark.sales.card.update' });
  }

  // 售后卡片的更新单独一个日志前缀：排查时能一眼分出"这是售后那张卡"。
  async updateAfterSalesCard(task, event, card, metadata = {}) {
    return updateInteractiveCard({ client: this.client, task, event, card,
      stage: metadata.stage, interactionId: metadata.interactionId,
      eventPrefix: 'lark.after_sales.card.update' });
  }

  async publishSalesResultCard(task, event, card, metadata = {}) {
    if (await this.updateSalesActionCard(task, event, card, metadata)) return true;
    try {
      const messageId = await this.sendTaskCard(task, card);
      if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
      logInfo('lark.sales.card.fallback.sent', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, card_message_id: messageId });
      return true;
    } catch (error) {
      logWarn('lark.sales.card.fallback.failed', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, error: error.message });
      return false;
    }
  }

  // ── 渠道感知的输出（B）：「回复 / 卡片回到话题」────────────────────────────
  //
  // 🔴 2026-10-07「私聊链路移除」：**没有群上下文的任务 = 没有去处** ——
  //    这两条出口只记一条 `lark.private_chat.send_skipped`、返 `null`，
  //    **不再**回落到 `sendText(open_id)` / `sendCard(open_id)`
  //    （那两个 open_id 发送器的卡片那个已整体删除；文字那个只剩 notice 一处用）。
  //    只有群里的销售任务（`chat_type === 'group'`）才"回复到那条消息的话题"。
  //    见 docs/private-chat-removal-decision-2026-10-07.md。
  //
  // 为什么必须按任务分流、而不是在 sendText 里判：
  //   群里任务才有 message_id（回哪条、进哪个话题）；**没有群上下文的**任务
  //   （私聊链路已移除 → 现在不该再出现）**没有去处**，见下面两条出口的处置。

  /**
   * 群里：把文字回到那条销售话题。
   *
   * ⚠️ **没有群上下文**的任务：私聊链路已移除，它**没有去处** → 只记一条
   * `lark.private_chat.send_skipped`、返 `null`，**一个远端调用都不做**。
   * 这条分支是**防御性**的（正常路径上不该再出现没有渠道的任务）；
   * 刻意**不留任何开关**：要恢复私聊是"重新实现那条链路"，不是翻一个开关
   * （业务负责人 2026-10-07 拍板的 ⓐ，见 docs/private-chat-removal-decision-2026-10-07.md）。
   */
  async sendTaskText(task, message) {
    if (task?.chat_type !== 'group') return skipNoGroupContext('text', task);
    const sent = await this.replyTextInThread(task.message_id, message);
    // ⚠️ 文字这条出口**只补本地路由映射，不写销售主表**（`storeLink: false`）——两条理由：
    //   ① 深链是**话题级**的（URL 里只有 chat_id + thread_id，没有 message_id）：同一话题里
    //      不管哪条回复拼出来都是同一条，**卖卡片那条出口（sendTaskCard）已经写过了**，再写是空转；
    //   ② 这条出口里混着"**不猜、不写业务表**"的路径（例：多笔未收款占位 / 金额对不上时
    //      回一句「有多条待收款，请先人工核对」）——业务表的写入**绝不能搭在它上面**，
    //      否则"一个字都不写"这条保证会被一个不相干的副作用破掉。
    await this.bindGroupSaleThread(task, sent, { storeLink: false });
    return sent.messageId;
  }

  /**
   * 群里：把卡片回到那条销售话题（没有原卡片可改时的兜底）。
   * ⚠️ **没有群上下文**的任务：私聊链路已移除，它**没有去处** → 只记一条
   * `lark.private_chat.send_skipped`、返 `null`，**一个远端调用都不做**（同 `sendTaskText`）。
   */
  async sendTaskCard(task, card) {
    if (task?.chat_type !== 'group') return skipNoGroupContext('card', task);
    const sent = await this.replyCardInThread(task.message_id, card);
    await this.bindGroupSaleThread(task, sent);
    return sent.messageId;
  }

  /**
   * ⭐ ③ 售后（以及任何"带任务上下文"的回复）的**渠道感知回复**：
   *   · 群里 → 回复到 `task.message_id` 的**那个话题**（`reply_in_thread: true`）；
   *   · 没有群上下文 → **没有去处**：只记一条 `lark.private_chat.send_skipped`、返 `null`。
   *
   * 与 `sendTaskCard` 的区别：这个是"回她那条消息"，不是"另发一张"。
   * 售后的确认卡片、候选卡片、结果卡片都优先走它 —— 她在话题里说话，
   * 卡片就落在同一个话题里（"在一个话题里解决一切"）。
   *
   * 🔴 2026-10-07 二次收尾：非群分支**不再**回落「回复她那条私聊消息」
   *    （`replyCard(task.message_id, card)`）—— 私聊入口已移除，非群任务**没有去处**；
   *    这是当时漏掉的最后两条口子之一。见 utils/privateChatSend.js 的口径。
   */
  async replyTaskCard(task, card) {
    if (task?.chat_type !== 'group') return skipNoGroupContext('card', task);
    const sent = await this.replyCardInThread(task.message_id, card);
    await this.bindGroupSaleThread(task, sent);
    return sent.messageId;
  }

  /**
   * 记下「这条话题 ↔ 这笔销售」的路由映射，并把**消息深链**存到该存的两处
   * （本地映射 + 销售主表「消息链接」列，见 SalesMessageLinkService）。
   *
   * 时机就是"我们第一条回复发出去之后"：`reply_in_thread` 的响应里才带 thread_id
   * （普通群里这个话题是**我们这条回复**创建的）。`message_app_link` 一旦飞书回带，就只有
   * "发出去的那一刻"能拿到（实测 2026-10-06：这个应用当前**根本不回带**，见
   * docs/reports/group-message-deep-link-2026-10-06.md 的实测四）——所以这里是唯一的落点。
   * 失败只告警——它只影响"她后面在这个话题里说话能不能被认出来 / 表里那列有没有链接"，
   * 绝不能因此把已经发出去的卡片判失败。
   *
   * ⚠️ `storeLink`（默认 true）：**只有卡片那条出口**才写销售主表的「消息链接」列。
   *    文字出口（`sendTaskText`）传 false —— 理由见那个方法的注释（话题级深链已经写过了，
   *    且文字出口里有"不猜、不写业务表"的路径）。本地路由映射**任何情况都记**。
   */
  async bindGroupSaleThread(task, sent = {}, { storeLink = true } = {}) {
    if (task?.chat_type !== 'group') return null;
    try {
      const result = await this.salesMessageLinks.rememberFromSend({
        salesEntryRecordId: task.sales_entry_record_id || '',
        taskId: task.task_id,
        orderNo: task.posting_result?.sourceNo || '',
        messageId: task.message_id,
        threadId: String(sent?.threadId || task.group_thread_id || '').trim(),
        chatId: task.chat_id || '',
        senderOpenId: task.sender_open_id || '',
        replyMessageId: sent?.messageId || '',
        appLink: sent?.appLink || '',
        storeInBitable: storeLink,
      });
      return result.record;
    } catch (error) {
      logWarn('sales.group.thread.remember_failed', { task_id: task.task_id, error: error.message });
      return null;
    }
  }

  /**
   * 「收到了」的反馈。私聊和群聊**都要加表情**（表情是唯一不变的"已收到"信号）。
   *
   * 私聊额外回一句文字（现状不变）；群聊**不回文字**——群里一句"已收到，正在识别…"
   * 会刷屏，业务负责人明确说表情就够了。
   *
   * 表情类型从配置读（默认 OneSecond，真机验证过有效）：改表情不碰代码。
   * 表情加不上（缺权限、消息被撤回）只 warn：它只是信号，绝不能影响主流程。
   */
  async acknowledgeMessage(messageId, options = {}) {
    const includeTextReply = options.includeTextReply !== false;
    const emojiType = options.emojiType || resolveAckReaction();
    const pending = [
      this.client.im.messageReaction
        .create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emojiType } },
        })
        .then((response) => {
          if (response.code !== 0) {
            throw new Error(`添加飞书表情回复失败: ${response.msg} (Code: ${response.code})`);
          }
        }),
    ];
    if (includeTextReply) pending.push(this.replyText(messageId, '👀 已收到，正在识别销售信息，请稍候…'));
    const results = await Promise.allSettled(pending);
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logWarn('lark.sales.acknowledgement.failed', {
          message_id: messageId,
          // 索引 0 永远是表情；文字回复只有私聊才有，所以按是否请求了文字回复来标注。
          channel: index === 0 ? 'reaction' : 'reply',
          emoji_type: index === 0 ? emojiType : undefined,
          error: result.reason?.message || String(result.reason),
        });
      }
    });
    return { emojiType, textReplied: includeTextReply };
  }

  async acceptMessage(event) {
    const message = event?.message;
    const senderOpenId = event?.sender?.sender_id?.open_id;
    if (!message?.message_id || !senderOpenId) return { accepted: false, reason: 'missing_identity' };

    // ── 群聊：准入**先看 thread_id**，主群再看三条判据（任一条）──────────────
    //   ① 话题里的消息（`thread_id` 有值）→ **都理，不要求 @机器人**。
    //      实测：她在话题里发「你好 小来财」没有 @（mentions=[]），事件照样推给我们；
    //      话题本身就是"这条是冲着机器人来的"的判据，再要求 @ 会把她说的话丢掉。
    //   ② 主群消息（`thread_id` 为空）→ 满足**任一条**才理（见 resolveMainChatAdmission）：
    //      · `mentions` 里有机器人（@ 了）—— 改动前的老判据，照旧；
    //      · 正文过**销售闸门**（`config/messageGate`，与私聊同一把尺子）；
    //      · 正文里有采购批次号 `CGD-YYYYMMDD-NNNN`（旧号 `BH-…` 仍然认） → 归采购那条路。
    //      三条都不满足 → **完全静默**：连日志之外的动作都没有，更没有任何远端调用
    //      （不发消息、不加表情、不读表、不进 AI）。群里所有人发的消息都会推给我们，
    //      这道闸门是拦它们的唯一一道。
    //
    // ⚠️ 必须**先判 `thread_id`**：话题里没 @ 的消息要在读 mentions 之前就放行，
    //    顺序反了会把它当成"主群没 @"丢掉——这正是她真机测出来的那个 bug。
    if (message.chat_type === 'group') {
      const threadId = String(message.thread_id || '').trim();
      // 正文先取出来：主群准入的第二代判据要看正文（销售闸门 / 采购批次号）。
      const isTextMessage = ['text', 'post'].includes(message.message_type);
      const groupText = isTextMessage ? extractSalesMessageText(message) : '';
      let mainChatVia = '';
      if (!threadId) {
        const admission = this.resolveMainChatAdmission(message, groupText);
        if (!admission.accepted) {
          // 不理的主群消息：**一个远端调用都不许有**（判据全是本地纯函数）。
          logInfo('lark.group.message.ignored', {
            message_id: message.message_id, reason: admission.reason, chat_id: message.chat_id,
            require_mention_in_main_chat: this.mainChatRequireMention,
          });
          return { accepted: false, reason: admission.reason };
        }
        mainChatVia = admission.via;
      }
      if (!isTextMessage) {
        // 群聊准入通过（话题里、或主群里 @ 了 / 正文像销售）但发的是图片/文件：
        // **静默忽略**，不解释、不回复。群里回一句"我只接收文字"同样会刷屏。
        logInfo('lark.group.message.ignored', {
          message_id: message.message_id, reason: 'unsupported_message_type',
          message_type: message.message_type,
        });
        return { accepted: false, reason: 'group_unsupported_message_type' };
      }
      if (!groupText) {
        logInfo('lark.group.message.ignored', { message_id: message.message_id, reason: 'empty_text' });
        return { accepted: false, reason: 'group_empty_text' };
      }
      logInfo('lark.group.message.accepted', {
        message_id: message.message_id, chat_id: message.chat_id,
        sender_open_id: senderOpenId, parent_id: message.parent_id,
        thread_id: threadId, // 空 = 主群；有值 = 话题（免 @）
        via: threadId ? 'thread' : mainChatVia,
        text_length: groupText.length,
      });
      // 返回值统一带上 `accepted: true`（和私聊那条路同一个契约），
      // 另外附上定位结果（resolved/batchNo/…）供调用方与将来的 D 使用。
      const flowResult = await this.acceptGroupMessage({
        message, senderOpenId, originalText: groupText, threadId,
      });
      return { accepted: true, ...flowResult };
    }

    // ── 非群聊（私聊 等）────────────────────────────────────────────────────
    // 🔴 私聊链路已移除（业务负责人 2026-10-07：「以后私聊这条链路我们就没有了」）。
    //    她拍板的方式是 **ⓐ：代码里一行私聊都不留** ——
    //    见 docs/private-chat-removal-decision-2026-10-07.md。
    //    入口统一到【群聊 + 话题】：私聊消息**只记一条日志** ——
    //    不建任务、不进 AI、不读表、不写表、**也不回消息**（它要回的那条链路已经不存在了）。
    //
    //    ⚠️ 别再往这里加私聊专属逻辑，也**不要**加"默认关闭的开关"：
    //       要恢复私聊是**重新实现**这条链路，不是翻一个开关（那正是被否掉的 ⓑ）。
    //    ⚠️ 这一条同时取代了改动前的 `not_p2p` 拒绝分支（私聊没了，那条判据也没有意义了）。
    logInfo('lark.private_chat.disabled', {
      message_id: message.message_id,
      chat_type: message.chat_type,
      message_type: message.message_type,
    });
    // ⭐ 业务负责人 2026-10-07 决定**保留这一句**（对面是人，完全静默会让人以为机器人坏了）。
    //    这是私聊链路上【唯一】保留的动作：不建任务、不进 AI、不读表、不写表。
    //    文案与"回不回"都在 config/privateChatNotice 里（显式布尔；空串 = 关掉那句话）。
    const { resolvePrivateChatNotice } = require('../config/privateChatNotice');
    const notice = resolvePrivateChatNotice();
    if (notice.enabled && notice.text) {
      await this.sendText(senderOpenId, notice.text).catch((error) => {
        logWarn('lark.private_chat.notice_failed', { message_id: message.message_id, error: error.message });
      });
    }
    return { accepted: false, reason: 'private_chat_removed' };
  }

  /**
   * 主群消息（`thread_id` 为空）的准入判据。话题里的消息**不走这里**（一律理）。
   *
   * 业务负责人 2026-10-06 拍板（逐字）：「主群里面可不可以不 @ 机器人啊？
   *   机器人它自动就能识别销售信息并进行回复呀。」→ 主群**不再要求 @**。
   * 满足**任一条**就理：
   *   ① `mentions` 里有机器人（@ 了）—— 改动前的老判据，照旧；
   *   ② 正文里有采购批次号 `CGD-YYYYMMDD-NNNN`（旧号 `BH-…` 仍然认） → 归采购那条路（`extractBatchNos`）。
   *      先判它，顺序与分派器（`SalesGroupFlowService`）一致：带批次号的就是采购的，
   *      即便同时含数字（"CGD-20261005-0009 这批到哪了"不能被当成销售）；
   *   ③ 正文过**销售闸门**（`config/messageGate`，与私聊**同一把尺子**）。
   * 三条都不满足 → `accepted:false`，调用方**静默返回**：不回复、不加表情、不读表、
   * 不进 AI —— 群里日常聊天（「今天天气不错」）绝不能有任何远端调用。
   *
   * ⚠️ 判据全部是**本地纯函数**（正则 / 字符串包含），所以"不理"这条路天然零远端调用。
   * ⚠️ `mainChatRequireMention`（`config/groupAdmission`，**默认 false**）为 true 时回到
   *    改动前：主群**只认 @**（没配 `LARK_BOT_OPEN_ID` 时一条都不理）。
   * ⚠️ 认错人的兜底不是这里：③ 放行的消息会走销售确认卡片，卡片上有「取消」，
   *    她点一下就结束——**不会直接写业务数据**（那一段复用私聊同一条链路）。
   */
  resolveMainChatAdmission(message, text = '') {
    if (isMentioned(message?.mentions, this.botOpenId)) return { accepted: true, via: 'mention' };
    if (this.mainChatRequireMention) {
      // 老行为（开关显式打开时才走）：判不出 @ 就一条主群消息都不处理。
      if (!this.botOpenId) return { accepted: false, reason: 'group_bot_open_id_unconfigured' };
      return { accepted: false, reason: 'group_not_mentioned' };
    }
    // ② 正文里有采购批次号 → 理（定位到那一批，采购那条路一个字不变）。
    if (extractBatchNos(text).length) return { accepted: true, via: 'purchase_batch_no' };
    // ③ 正文像销售 → 理（主群新开一笔：在她那条消息下开话题 + 回确认卡片，
    //    认错了也有卡片上的「取消」，不会直接写数据）。
    if (isSalesCandidate(text)) return { accepted: true, via: 'sales_gate' };
    return { accepted: false, reason: 'group_not_sales_text' };
  }

  /**
   * 群聊入口。**准入由调用方判定**（话题免 @；主群：@ / 像销售 / 带批次号），进来之后：
   *   · 剥掉 @ 占位符（`@_user_1`）再当正文；
   *   · 加「收到」表情（**不回文字**，群聊回文字会刷屏）；
   *   · 交给销售分派（C）与采购定位链路——采购那条路只回答"是哪一批"。
   *
   * ⚠️ 「进不进来」的闸门在主群**用的是私聊同一把尺子**（`config/messageGate`，
   *   2026-10-06 业务负责人拍板），但"进来之后归谁"仍由销售分派先判；采购的既有行为
   *   （含"认不出"那两句文案）一个字都不变。
   */
  async acceptGroupMessage({ message, senderOpenId, originalText, threadId = '' }) {
    const text = stripMentionPlaceholders(originalText, message.mentions);
    if (!text) {
      // 只 @ 了机器人（或话题里空着一条）、一个字没说。回一句问清楚，不猜。
      logInfo('lark.group.message.empty_after_mention', { message_id: message.message_id });
      return this.groupPurchaseFlow.handleGroupPurchaseMessage({
        messageId: message.message_id,
        text: '',
        parentId: message.parent_id,
        threadId,
        senderOpenId,
      });
    }
    await this.acknowledgeMessage(message.message_id, { includeTextReply: false });
    // ── 销售 or 采购？先问销售那条分派（C）────────────────────────────────
    // 只有它说"这条归销售"时才走销售；说"不是"时**原样**交给采购链路，
    // 所以采购的既有行为（含"认不出"那两句文案）一个字都不变。
    const sales = await this.groupSalesFlow.handleGroupSalesMessage({
      message,
      text,
      parentId: message.parent_id,
      threadId,
      senderOpenId,
      chatId: message.chat_id,
    });
    if (sales?.handled) {
      logInfo('sales.group.message.handled', {
        message_id: message.message_id, mode: sales.mode, source: sales.source,
        thread_id: threadId, sales_entry_record_id: sales.sale?.sales_entry_record_id || '',
      });
      return sales;
    }
    return this.groupPurchaseFlow.handleGroupPurchaseMessage({
      messageId: message.message_id,
      text,
      parentId: message.parent_id,
      threadId,
      senderOpenId,
    });
  }

  /**
   * 群里的销售入口（A / C）。**识别原话 → 发销售卡片 → 她确认 / 取消 / 修改 → 入账 →
   * 交付** 这条链路一个字都不变，只是**承载场所**从私聊变成了群话题：
   *   · 主群里她新说一笔（`sale` 为空）→ 建销售记录 ＋ 在她那条消息下开话题 ＋ 回卡片；
   *   · 话题里收到消息（`sale` = 本地映射定位到的那笔）→ 绑定到**同一笔**销售，
   *     不再新建销售主表记录 —— 话题本身就是上下文，**不去查"最近的销售"**。
   *
   * 处理本身**复用私聊那一个入口**（acceptSalesText → processSalesTask），
   * 这里只做"带上渠道上下文"这一件事，不另写一套识别 / 出卡 / 入账。
   */
  async handleGroupSaleMessage({ message, text, threadId = '', senderOpenId, chatId, sale = null }) {
    return this.acceptSalesText(
      { message, senderOpenId, originalText: text },
      {
        chatType: 'group',
        chatId,
        threadId,
        sale,
        // 群聊的"已收到"在准入那一步已经加过表情了（群里不回文字），这里不重复加。
        acknowledge: false,
      },
    );
  }

  async acceptSalesText({ message, senderOpenId, originalText }, context = {}) {
    // ⭐ ② 话题里、且**已经定位到某笔销售**时，闸门放宽成"像销售 **或** 像那笔的进展"。
    //    为什么必须放宽：进展同步的话未必带数字 / 业务关键词 ——
    //    「那双拿走了」既没有数字，也没有"退/换/卖/查/库存"这类词，
    //    用私聊那把尺子会把它**静默挡掉**，二次处理根本没机会跑。
    //    ⚠️ 只放宽"群 + 话题 + 已定位到销售"这三条同时成立的那一种消息：
    //       私聊（chatType 不是 group）与主群新开一笔（sale 为空）走的判据与改动前逐字相同。
    const threadSaleProgress = context.chatType === 'group' && Boolean(context.sale)
      && this.threadProgress.classify(originalText).kind !== PROGRESS_KINDS.NONE;
    if (!threadSaleProgress && !looksLikeSalesText(originalText)) {
      logInfo('lark.message.ignored', {
        message_id: message.message_id,
        sender_open_id: senderOpenId,
        reason: 'not_sales_candidate',
        text_length: originalText.length,
      });
      return { accepted: false, reason: 'not_sales_candidate' };
    }
    const taskId = idFor('sale', message.message_id);
    if (await this.store.get(taskId)) return { accepted: false, reason: 'duplicate', taskId };
    // 群聊的销售任务多带三样东西（私聊一个都不带，payload 与改动前逐字相同）：
    //   · chat_type / chat_id / group_thread_id → 输出回到那条话题（B）；
    //   · sales_entry_record_id → 话题里后续消息**绑定到已定位的那一笔**（C），
    //     processSalesTask 看到它就不再新建销售主表记录。
    const groupContext = context.chatType === 'group'
      ? {
        chat_type: 'group',
        chat_id: context.chatId || message.chat_id || '',
        group_thread_id: String(context.threadId || message.thread_id || '').trim(),
        sales_entry_record_id: context.sale?.sales_entry_record_id || '',
      }
      : {};
    const task = await this.store.create({
      task_id: taskId,
      type: 'sale',
      status: 'received',
      message_id: message.message_id,
      sender_open_id: senderOpenId,
      sent_at: timestamp(message.create_time),
      original_text: originalText,
      ...groupContext,
    });
    logInfo('lark.sales.accepted', {
      task_id: taskId,
      message_id: message.message_id,
      sender_open_id: senderOpenId,
      text_length: originalText.length,
      // ⚠️ 私聊入口已移除（2026-10-07）→ 这里只可能是群；非群标成 `unknown` 便于排查
      //    "是不是有别的 chat_type 漏进来了"。**不要再标 `p2p`**：那条路已经不存在了。
      channel: context.chatType === 'group' ? 'group' : 'unknown',
      sales_entry_record_id: groupContext.sales_entry_record_id || '',
    });
    if (context.acknowledge !== false) await this.acknowledgeMessage(message.message_id);
    setImmediate(() =>
      this.enqueueForSender(senderOpenId, () => this.processSalesTask(taskId)).catch((error) =>
        this.handleTaskFailure(taskId, error)
      )
    );
    return { accepted: true, type: 'sale', taskId: task.task_id };
  }


  /**
   * 「其他配品」清单。没配置这张表时返回空——那种部署下销售只支持鞋，
   * 配品说法会被当成未知货号处理，而不是报配置错误。
   */
  async listAccessories() {
    const table = this.gateway.table?.('accessory');
    if (!table?.tableId) return [];
    try {
      const records = await this.gateway.listAll('accessory');
      return records
        .map((record) => ({
          record_id: record.record_id,
          name: textValue(record.fields?.[table.fields.name]).trim(),
          // 「种类」是配品的品类（鞋油、腰带…），用户嘴里说的通常就是它。
          // 单选字段读回来是数组，textValue 会归一成「鞋油」这样的字符串。
          // 部署里没配这个字段映射（或某条没填）时留空：那种情况下只按名称匹配，
          // 与改动前的行为完全一致，不会因为缺分类就匹配失败。
          category: table.fields.category
            ? textValue(record.fields?.[table.fields.category]).trim()
            : '',
        }))
        .filter((item) => item.name);
    } catch (error) {
      logWarn('lark.sales.accessory.list_failed', { error: error.message });
      return [];
    }
  }

  /**
   * 卖这一双会不会动到样品？会的话，把"可以用哪些门盒补"一并算出来。
   *
   * 能提前算，是因为出卡片前已经读过实时库存：门盒几双、样品几双都是已知的。
   * 于是"卖样品要补哪个门盒"能在这张卡片上一次问完，不必事后另弹一张卡。
   *
   * 三种情况要分清：
   *   · 门盒够        → 不会动样品，什么都不用问
   *   · 门盒不够、样品够 → 会动样品，需要她选一个门盒来补（有候选项时）
   *   · 门盒样品都不够  → 这是"库存不足"，走没货那条路，不在这里处理
   */
  samplePlanFor({ productRecordId, stock, quantity = 1 }, liveInventory) {
    const none = { uses_sample: false, needs_sample_replacement: false, sample_replacement_options: [] };
    const needs = Number(quantity || 1);
    const doorBox = Number(stock?.doorBox || 0);
    const sample = Number(stock?.sample || 0);
    if (!productRecordId || doorBox >= needs || sample < needs) return none;
    const options = (liveInventory?.sampleReplacementCandidatesForProduct?.(productRecordId) || [])
      .filter((row) => row.doorBoxCount > 0);
    return {
      uses_sample: true,
      // 有候选项才需要她选；一个都没有时只在卡片上提示（另行调拨），不拦住确认。
      needs_sample_replacement: options.length > 0,
      sample_replacement_options: options,
    };
  }

  /**
   * ── 解析 A：货品信息（只读「货品信息」表）────────────────────────────────
   *
   * 输出：这个货号的**颜色**与**商品记录 id**（多颜色时不猜，把候选交给确认卡片）。
   *
   * 三步流程的第 1 步（业务负责人 2026-10-07 逐字）：
   *   「1. 货品信息还是要先查这个货品有没有、信息全不全
   *     2. 这里要给到**全色**，让用户去选
   *     3. 用户选完之后，再拿着用户选的颜色去……找，如果找到了，就是现货，如果没找到，就是预定」
   * ⇒ A 给**全部颜色**的候选（不按在售过滤）；B 拿她选的颜色去查**实时库存**定类型。
   * （走的就是入账时用的同一个 `resolveProduct`，不是第二套货品匹配逻辑。）
   *
   * ⚠️ **尽力而为、绝不抛错**：它只是"把颜色补上"。所以这里认不出、读挂了都只记一条
   *    日志，绝不因此挡住别的路径。
   *    ⚠️ 它在颜色这件事上的结论**不再被 B 覆盖**（2026-10-07 第三刀）：
   *    多候选 ⇒ **先让用户选**、选完才跑 B；单颜色 ⇒ A 直接定下来，B 只拿这个颜色
   *    去查"这个尺码有没有货"。详见类里的主循环与 `docs/ab-color-first-design-2026-10-07.md`。
   */
  async resolveProductInfoForSale({ itemNo }) {
    // ⚠️ 必须**带着 `this`** 调用（`this.references.resolveProduct(...)`）。
    //    把方法先摘下来再调（`const fn = this.references.resolveProduct; fn(...)`）会丢 `this`，
    //    而 `V1ReferenceResolver.resolveProduct` 第一行就读 `this.gateway` ⇒
    //    `TypeError: Cannot read properties of undefined (reading 'gateway')`
    //    ⇒ 被下面这个 try/catch 吞成 `{}` ⇒ **预付（B 不跑）时既没有颜色、也没有候选**。
    //    2026-10-07 真机 bug 的根因就是它，真机日志逐字：
    //    `{"event":"lark.sales.product_info.resolve_failed","item_no":"26002-52",
    //      "error":"Cannot read properties of undefined (reading 'gateway')"}`
    if (!itemNo || typeof this.references?.resolveProduct !== 'function') return {};
    try {
      const found = await this.references.resolveProduct({ itemNo, matchMode: 'sales' });
      // 多个颜色：不猜，候选交给确认卡片（形状与实时库存那条候选一致：
      // {recordId, color, number}，卡片动作 choose_sale_color 只认这三个键）。
      // ⚠️ `status`（「货品状态」：在售 / 下架）**仍然带回来**，但 2026-10-07 起
      //    **不再用它过滤候选**（候选给全部颜色）——留它是为了 trace 与兼容。
      if (found?.needsColor && found.options?.length) {
        return {
          needsColor: true,
          colorOptions: found.options.map((option) => {
            const optionColor = String(option.color || '').trim();
            return {
              recordId: option.recordId,
              color: optionColor,
              // 展示串与解析 B / `items.push` 同口径（**货号 + 颜色**）。
              // ⚠️ 不要用 resolver 回的 `number`：那是**归一化过的「编号」**（小写、去分隔符），
              //    当卡片上的货品标签会显示成 `b2600252黑色b`。
              number: `${itemNo}${optionColor}`,
              // 读不到时留空串：空 **不等于** 下架（判据只认真证据，见 AGENTS.md 第 17 条）。
              status: String(option.status ?? '').trim(),
            };
          }),
        };
      }
      if (!found?.recordId) return {};
      const colorField = this.gateway.table?.('product')?.fields?.color;
      return {
        productRecordId: found.recordId,
        // 颜色在记录字段里，不在返回值上（resolveProduct 只回 recordId + record）。
        color: colorField ? textValue(found.record?.fields?.[colorField]).trim() : '',
      };
    } catch (error) {
      // 货号在「货品信息」里没有 / 读表失败：不算缺项，只记账。
      // （"有没有建档"由判据 A′ 下结论；B 只回答"实时库存里有没有这一双"。）
      logWarn('lark.sales.product_info.resolve_failed', { item_no: itemNo, error: error.message });
      return {};
    }
  }

  // ⚠️ 2026-10-07：`colorOptionsWithStockStatus`（给每个候选颜色标 `stock_status`
  //    「有货 / 无货」，卡片上渲染成 `黑色（有货）`）**已整体删除** ——
  //    业务负责人逐字：「**甲 去掉**（推荐，贴合你的口径）：候选只显示颜色（黑色 / 绿色），
  //    **选完 → 再查库存 → 告诉她"这双有货→现货"或"没货→预定"**」。
  //    ⇒ 候选对象上不再有 `stock_status`；预览那一步没了。
  //    🔴 **"录单时读实时库存"没有被删**：单颜色货号的现货 / 预定 仍然用**这一次**
  //       读进来的索引定（见下面的 `liveInventoryPromise` → `resolveStockAvailabilityForSale`），
  //       多颜色则等她选完颜色、在 `choose_sale_color` 里重新读一次再定。
  //    ⚠️ 别把这一步加回来：加了就违反她"候选只显示颜色名"的口径，守卫用例会红
  //       （见 `test/salesColorChoice.test.js` / `test/salesColorCandidatesAllColors.test.js`）。

  // ⚠️ 2026-10-07：`colorOptionsInScope`（按「在售 / 下架」过滤候选）与
  //    `SALES_COLOR_SCOPE_EMPTY_TEXT`（"颜色全下架"那句拦截）**已整体删除** ——
  //    口径是「候选给**全部颜色**」：预定 = 没货，若候选只推在售，她永远选不到
  //    没货的颜色 ⇒ 预定走不通。判据与证据见
  //    `docs/sales-type-by-stock-2026-10-07.md` AC-2。

  /**
   * 主表「交易类型」（多选关联「行为管理」）：把**最终**的逐明细类型写上去。
   *
   * 为什么要有它、而不是只在录单那一次写：
   *   🔴 2026-10-07 口径大改后，**类型要等她选完颜色、查完实时库存才知道** ——
   *   多颜色那一条明细在录单时**根本没有编码**（空串 = "还没定"）。
   *   所以「确认入账之前」必须再同步一次，否则主表「交易类型」会漏掉整单的类型
   *   （她选了颜色、卡片上也写着"现货"，表里却是空的）。
   *
   * ⚠️ **绝不阻塞入账**：它只是审计字段（业务事实是交付与收款，那两件事另有判据）；
   *    关联查不到只记一条 warn。返回值只用于日志 / 排查。
   */
  async syncSalesTradeTypes({ salesEntryRecordId, items = [], taskId = '' } = {}) {
    const recordIds = [];
    if (typeof this.references?.resolveSalesTradeType === 'function') {
      for (const code of orderTradeTypeCodes(items, '')) {
        if (!code) continue;
        try {
          const recordId = (await this.references.resolveSalesTradeType(code)).recordId;
          if (recordId && !recordIds.includes(recordId)) recordIds.push(recordId);
        } catch (error) {
          logWarn('lark.sales.trade_type.resolve_failed', {
            task_id: taskId, code, error: error.message,
          });
        }
      }
    }
    if (!recordIds.length || !salesEntryRecordId) return recordIds;
    await this.gateway.update('salesEntry', salesEntryRecordId, { tradeType: relation(recordIds) });
    return recordIds;
  }

  /**
   * ── 判据 A′：这个货号到底有没有在「货品信息」里建档 ─────────────────────────
   *
   * 位置：**在解析 A 之后**、解析 B 之前 —— 三种交易类型**都走**这里
   * （两种交易类型都走这里）。
   *
   * 为什么要有这一步（业务负责人 2026-10-07 真机 + 逐字）：
   *   「对，所以三种交易类型，在看完货品信息之后，如果在货架上没有找到，
   *     都应该给到这个提示，而不是说等到 B」
   * 起因是那笔**预定**：`B26002-52` 被语音转文字漏成 `26002-52`，
   * A 空手回来不吭声、B 按交易类型又不跑 ⇒ 她点了确认才失败。
   *
   * ⚠️ **只回答一件事**：「货品信息」这张表里**有没有这个货号的记录**。
   *    与「货号找到了、只是齐备公式说缺字段（缺成本…）」是**两件事** ——
   *    后者仍然不拦，只进「补货品信息」那一段（**处理中卡 + 已入账终态卡**都带，
   *    见 `config/productInfoGaps.js`）。
   *
   * ⚠️ **正证据口径**（`AGENTS.md` 第 17 条：结论是「没有」→ 必须去事实表核过再说）：
   *    只有「货品信息**整表读成功**」＋「里面**确实没有**这个货号」才判 `missing`。
   *    A 的"空手回来"是**有歧义**的（`resolveProductInfoForSale` 把"找不到货品"与
   *    "读表失败"都收敛成 `{}` + 一条 warn），只凭它拦单会把"飞书抖了一下"
   *    误判成"没建档"、把一笔正常销售挡在门外；索引也读不到时**不下结论**
   *    （`unknown`，调用方记一条 undetermined 警告，不拦单）。
   *    反过来，**只要有一处正证据**（A 认得出来，或索引里有这个货号）就**不拦** ✅
   *
   * @returns {{ status: 'not_applicable'|'registered'|'missing'|'unknown', reason: string, indexAvailable: boolean }}
   */
  productRegistrationFrom({ itemNo, productInfo, productIndex } = {}) {
    const indexAvailable = Boolean(productIndex?.byNormalizedItemNo);
    const wanted = normalizeText(itemNo);
    // 没有货号不是本判据的事：缺货号由解析层自己报缺项（`items[i].item_no`）。
    if (!wanted) return { status: 'not_applicable', reason: 'no_item_no', indexAvailable };
    // 正证据①：解析 A 认得出来（拿到商品记录 / 多颜色候选）⇒ 一定建过档。
    if (productInfo?.productRecordId || productInfo?.colorOptions?.length) {
      return { status: 'registered', reason: 'resolved_by_product_info', indexAvailable };
    }
    // 正证据②：这次已经读回来的「货品信息」整表索引里有这个货号。
    if (productIndex?.byNormalizedItemNo?.has(wanted)) {
      return { status: 'registered', reason: 'product_index_hit', indexAvailable };
    }
    // 索引建出来了（整表读成功）⇒ 这是**负向结论的正证据**：表里确实没有这个货号。
    if (indexAvailable) return { status: 'missing', reason: 'product_index_miss', indexAvailable };
    // 两路都没给出可判定的证据（例如「货品信息」读挂了）⇒ 不下结论、不拦单。
    return { status: 'unknown', reason: 'product_index_unavailable', indexAvailable };
  }

  /**
   * ── 解析 B：库存可得性（只读「实时库存」表）— **类型的判据本身** ──────────────
   *
   * 输出：**有没有这一双**（`inStock`）、门盒 / 样品 / 仓库的数量、
   *      以及卖样品要不要补门盒。
   *
   * 🔴 2026-10-07 口径大改：**有货 → 现货，没货 → 预定**（业务负责人逐字：
   *   「库存里有这双 → 现货（当场交付 + 扣库存）；库存里没有 → 预定（不交付；
   *     等货到了再交付、那时才扣库存）」）。
   *   ⇒ ① 「没货」**不是错误、不再拦单** —— 它就是「预定」的结论，返回 `inStock:false`；
   *     ② **两种类型都跑这一步**（"预定跳过库存"那条策略已整体删除）；
   *     ③ 没有一个"缺货文案"这种东西了（那句话说的事现在由卡片上的「类型：预定」表达）。
   *
   * ⭐ 颜色/记录 id 由 A 定死，B 不再整体替换 A（她逐字：「B 应该是拿着 A 环节用户选的
   *   那个颜色，然后再去找库存」）。传了 `color` 就只按它找
   *   （A 给单色 / 用户在卡片上选定颜色后都走这条）；找不到 ⇒ `inStock:false` ⇒ 预定。
   *   没传 `color` 只有一种情况：**「货品信息」读不到**（A 空手回来），
   *   这时才沿用旧行为 —— 按货号+尺码把实时库存里的颜色摆成候选让她点。
   *
   * ⚠️ 它只管"录单时的存在性判定"：**交付 / 扣库存**不在这里，也不受它影响
   *    （交付与否由 `SALES_MOVEMENTS.delivery` 从类型推，预定 → 未交付）。
   *
   * @returns `{ inStock: false }`（没货）｜`{ inStock: true, productRecordId, color, stock,
   *          samplePlan }`（找到一双）｜`{ inStock: true, needsColor: true, colorOptions }`
   *          （A 没给颜色时的兜底候选）。
   */
  resolveStockAvailabilityForSale({ itemNo, size, itemQuantity = 1, color = '' }, liveInventory) {
    const found = liveInventory.find({ itemNo, size });
    // 传了颜色（A 定的 / 她选的）⇒ 只看这一个颜色；没传 ⇒ 看整个尺码下的全部颜色（兜底）。
    // ⚠️ 比色走 `normalizeColor`（小写、去分隔符、去尾「色」）：A 的颜色来自「货品信息」、
    //    B 的颜色来自「库存键」，是两个列 —— 必须与 resolver 自己那套「棕 = 棕色」同口径，
    //    否则会出现"货其实有、却被判成没货"的假缺货。
    const wantedColor = normalizeColor(color);
    const colors = wantedColor
      ? found.colors.filter((entry) => normalizeColor(entry.color) === wantedColor)
      : found.colors;
    if (!colors.length) {
      // ⭐ **实时库存里没有这一双 = 预定**（类型的判据）。不是错误、不拦单、不再拼缺货文案。
      //    可排查：`lark.sales.trade_type.decided` 里有 `in_stock:false` 与这一行的货号尺码。
      return { inStock: false };
    }
    if (colors.length === 1) {
      const [only] = colors;
      const stock = { doorBox: only.doorBox, sample: only.sample, warehouse: only.warehouse };
      const productRecordId = only.productRecordId;
      return {
        inStock: true,
        productRecordId,
        color: only.color,
        stock,
        samplePlan: this.samplePlanFor({ productRecordId, stock, quantity: itemQuantity }, liveInventory),
      };
    }
    // 只有"A 没给出颜色"才会走到这里：这个货号在这个尺码上有多个颜色，不猜，把候选交给确认卡片。
    // 补样品方案按颜色预先算好——颜色定了才谈得上"用哪个门盒补"。
    // ⚠️ 候选上**不打库存状态**（2026-10-07 口径：候选只显示颜色名，等她选完再查库存定类型）。
    return {
      inStock: true,
      needsColor: true,
      colorOptions: colors.map((entry) => {
        const optionStock = { doorBox: entry.doorBox, sample: entry.sample, warehouse: entry.warehouse };
        return {
          recordId: entry.productRecordId,
          color: entry.color,
          number: `${itemNo}${entry.color}`,
          stock: optionStock,
          sample_plan: this.samplePlanFor(
            { productRecordId: entry.productRecordId, stock: optionStock, quantity: itemQuantity }, liveInventory,
          ),
        };
      }),
    };
  }

    /**
   * 「货品信息」整表读一次，按记录 ID 建索引。
   *
   * 为什么不按需逐条读：录单时逐条读是**串行**的（一件商品一次请求），
   * 那份等待会直接加到"卡片出现"的时间上；整表读只有一个请求，而且能和
   * AI 解析、实时库存读取**三路并行**，读表时间藏在 AI 后面。
   * 这张表是**主数据**（货品资料，不像实时库存那样时时在变）。
   *
   * 表里没配 completeness 映射时返回 null —— 那种部署下不做这项检查。
   */
  async loadProductIndex() {
    const table = this.gateway.table?.('product');
    if (!table?.tableId || !table.fields?.completeness) return null;
    const readStartedAt = Date.now();
    const records = await this.gateway.listAll('product');
    const byId = new Map();
    // 同时按「货号」建索引：同一个货号会有多个颜色（每个颜色一条货品记录）。
    // 卖货时要把**这个货号下所有颜色**里资料不全的都提示出来——同款不同色通常
    // 一起上架，让她一次补齐，比每次卖一个颜色提醒一次省事。
    const byItemNo = new Map();
    // 同时按**归一后**的货号建一份（`normalizeText`：小写、去空格、去分隔符）：
    // 这是新增的「货号有没有建档」判据用的键，**必须与解析 A 的匹配规则同一套** ——
    // 否则「B26002-52」写成「b26002-52」时会得出"A 认得出来、判据说没建档"的自相矛盾。
    // 上面那份**原值**索引不动：`productInfoGapsFromIndex` 仍按 `item.item_no` 原值取。
    const byNormalizedItemNo = new Map();
    // 配置写错（例如用了界面显示名而记录里是内部名）时，整表都读不到这个键。
    // 那种情况下不报错、只是永远不提示她补资料——最难查，所以单独留一条警告。
    let completenessSeen = 0;
    for (const record of records) {
      const fields = record?.fields || {};
      // 「信息是否齐备」是飞书公式：齐备时返回「齐备」，否则返回缺的字段名。
      // 不自己逐字段判断——单一数据源留在表里，她在飞书改公式这里自动跟着变。
      const completeness = textValue(fields[table.fields.completeness]).trim();
      const sampleImages = fields[table.fields.sampleImage];
      const itemNo = textValue(fields[table.fields.itemNo]).trim();
      const color = textValue(fields[table.fields.color]).trim();
      const info = {
        missing: completeness && completeness !== '齐备'
          ? completeness.split('、').map((name) => name.trim()).filter(Boolean)
          : [],
        // 「样例图」是附件字段，不在齐备公式里，单独看有没有图。
        missingSampleImage: !(Array.isArray(sampleImages) && sampleImages.length > 0),
        label: `${itemNo}${color}`,
      };
      if (fields[table.fields.completeness] !== undefined) completenessSeen += 1;
      byId.set(record.record_id, info);
      if (itemNo) {
        if (!byItemNo.has(itemNo)) byItemNo.set(itemNo, []);
        byItemNo.get(itemNo).push({ recordId: record.record_id, ...info });
        const normalized = normalizeText(itemNo);
        if (normalized) {
          if (!byNormalizedItemNo.has(normalized)) byNormalizedItemNo.set(normalized, []);
          byNormalizedItemNo.get(normalized).push(record.record_id);
        }
      }
    }
    if (records.length && completenessSeen === 0) {
      logWarn('lark.sales.product_index.completeness_field_unreadable', {
        field: table.fields.completeness,
        hint: '字段名可能写成了界面显示名；记录 API 用的是内部名',
      });
    }
    logInfo('lark.sales.product_index.loaded', {
      record_count: records.length, item_count: byItemNo.size,
      // 这一段和 AI 解析、实时库存读取是并行的，所以这份耗时是"自己花了多久"，
      // 不是"让用户多等了多久"——排查时看它有没有盖过另外两路即可。
      duration_ms: Date.now() - readStartedAt,
    });
    return { tableId: table.tableId, byId, byItemNo, byNormalizedItemNo };
  }

  /**
   * 从已读好的索引里算货品资料缺口 —— **纯计算，不再请求远端**。
   * 索引为 null（没配这项检查 / 读表失败）时返回空：宁可少一次提醒，也不能挡住录单。
   */
  productInfoGapsFromIndex(items, index) {
    if (!index) return [];
    const appToken = V1_BITABLE_SCHEMA.appToken;
    const gaps = [];
    const seen = new Set();
    // 按「货号」取——同一个货号可能有多个颜色，每个颜色一条货品记录。
    // 卖其中一双时，把这个货号下**所有颜色**里资料不全的都提示出来。
    for (const item of items || []) {
      const itemNo = String(item.item_no || '').trim();
      if (!itemNo) continue;
      // 优先用货号索引；没有货号索引时退回"只看这一件匹配到的记录"。
      const candidates = index.byItemNo?.get(itemNo)
        || (index.byId?.get(item.product_record_id)
          ? [{ recordId: item.product_record_id, ...index.byId.get(item.product_record_id) }] : []);
      for (const candidate of candidates) {
        if (seen.has(candidate.recordId)) continue;
        seen.add(candidate.recordId);
        if (!candidate.missing.length && !candidate.missingSampleImage) continue;
        gaps.push({
          record_id: candidate.recordId,
          label: candidate.label || item.item_no || '',
          missing: candidate.missing,
          missing_sample_image: candidate.missingSampleImage,
          url: recordUrl({ appToken, tableId: index.tableId, recordId: candidate.recordId }),
        });
      }
    }
    if (gaps.length) logInfo('lark.sales.product_info.gaps', { count: gaps.length });
    return gaps;
  }

  /**
   * 团购券目录：只取「在售」的券，按「售价 + 面值」匹配结算金额。
   *
   * 读不到就当没有券目录——她对券的说法会落到"未配置该券的结算金额，请补充"的追问上，
   * 而不是拿别的券顶替、写一个错的收款金额。
   */
  async listGroupBuyVouchers() {
    const table = this.gateway.table?.('groupBuyVoucher');
    if (!table?.tableId) return [];
    try {
      const records = await this.gateway.listAll('groupBuyVoucher');
      return records
        .map((record) => ({
          record_id: record.record_id,
          name: textValue(record.fields?.[table.fields.name]).trim(),
          status: textValue(record.fields?.[table.fields.status]).trim(),
          purchasePrice: Number(record.fields?.[table.fields.purchasePrice]),
          faceValue: Number(record.fields?.[table.fields.faceValue]),
          settlementAmount: Number(record.fields?.[table.fields.settlementAmount]),
        }))
        .filter((voucher) => voucher.status === '在售'
          && Number.isFinite(voucher.purchasePrice)
          && Number.isFinite(voucher.faceValue)
          && Number.isFinite(voucher.settlementAmount));
    } catch (error) {
      logWarn('lark.sales.group_buy_vouchers.list_failed', { error: error.message });
      return [];
    }
  }

  /**
   * 读一次「实时库存」，按 `货号 + 尺码` 建索引。
   *
   * 为什么以实时库存为准：它是"店里实际有什么"，「货品信息」只是"配置过什么"。
   * 销售卖的是实物，所以颜色、有没有货、是门盒还是样品，都该从这里回答；
   * 而且一张表读一次就够，不必每双鞋各查一遍货品资料。
   */
  async loadLiveInventoryIndex() {
    const table = this.gateway.table?.('liveInventory');
    if (!table?.tableId) return new LiveInventoryIndex({ records: [] });
    const startedAt = Date.now();
    const records = await this.gateway.listAll('liveInventory');
    const index = buildLiveInventoryIndex({ records, table });
    logInfo('lark.sales.live_inventory.loaded', {
      task_id: null,
      record_count: records.length,
      skipped_records: index.skippedRecords,
      duration_ms: Date.now() - startedAt,
    });
    return index;
  }

  /**
   * 读回销售主表里已有的销售单号，交给纯函数算下一个号。
   *
   * 只负责「读」：怎么算在 salesOrderNo.js（纯函数，可单测），怎么写在本类里
   * createSalesEntryWithOrderNo（唯一写入口）。三段分开，是为了让"序号怎么来的"
   * 能在单测里被穷举，而不是埋在 IO 里。
   */
  async listSalesOrderNos() {
    const field = this.gateway.table?.('salesEntry')?.fields?.orderNo;
    // 字段映射缺失时读不到号；此时返回空列表，后续写单号会因
    //「未配置语义字段: orderNo」直接报错，而不是静默写一个空号。
    if (!field) return [];
    const records = await withSalesReadRetry(
      () => this.gateway.listAll('salesEntry'), 'sales_order_no_list',
    );
    return records.map((record) => textValue(record.fields?.[field])).filter(Boolean);
  }

  /**
   * 创建销售主表记录，并在**同一处**生成 + 写入「销售单号」。
   *
   * 为什么集中在这一处：这是全仓库唯一创建销售主表记录的地方（退货/换货不建新单，
   * 它们沿用原销售单号）。单号只在这里生成一次，规则就不会散成两套；
   * 以后新增入口也必须走这里，否则又会回到"飞书不生成、代码也不生成"的空号状态。
   *
   * 为什么拿了号才建记录、撞号时改自己这条：createSalesEntryWithOrderNo 内部
   * 由 allocateSalesOrderNo 负责"读→算→写→写后复查"；真撞上并发时它会把号 +1 后
   * update 回**同一条**记录，不留下第二条记录，也不给退货/换货留下两个同号的"原单"。
   */
  async createSalesEntryWithOrderNo(task) {
    let created = null;
    const allocation = await allocateSalesOrderNo({
      readExistingNos: () => this.listSalesOrderNos(),
      writeOrderNo: async (orderNo) => {
        if (created) {
          await this.gateway.update('salesEntry', created.recordId, { orderNo });
          return;
        }
        created = await this.gateway.create('salesEntry', {
          originalText: task.original_text,
          sender: person(task.sender_open_id),
          parseStatus: '解析中',
          // 建单 = 还没轮到她做任何动作 → 「确认状态」= 未确认。
          // ⚠️ 旧「确认状态（旧）」那一列已被她 2026-10-06 整列删除，四个维度是唯一入口。
          userAction: WRITE.userAction.pending,
          orderNo,
        });
      },
      onCollision: ({ attempt, order_no: orderNo }) =>
        logWarn('sales.order_no.collision', { task_id: task.task_id, attempt, order_no: orderNo }),
    });
    logInfo('sales.order_no.generated', {
      task_id: task.task_id,
      sales_entry_record_id: created?.recordId,
      order_no: allocation.orderNo,
      sequence: allocation.sequence,
      // 当天已有单号的条数（只数「日期段 == 今天」的）：排查"这个号从哪来"时看它。
      today_count: allocation.todayCount,
      attempts: allocation.attempts,
    });
    return created;
  }

  async processSalesTask(taskId) {
    const startedAt = Date.now();
    logInfo('lark.sales.processing.started', { task_id: taskId });
    const task = await this.store.get(taskId);
    // ⭐ ② 二次处理识别（预定 / 现货待收的进展）：**只有群话题里、且已经定位到某笔销售**时
    //    才问它（两个判据都由 service 自己收口，私聊的任务两个字段都没有 → 直接返回）。
    //    它说"这条归二次处理"就**不再**往下走销售原话解析 —— 这正是这次要修的 bug：
    //    她在话题里说「收到微信 500」不该被当成新原话、更不该回"销售信息还缺…"。
    const threadProgress = await this.threadProgress.handle({ task });
    if (threadProgress.handled) {
      logInfo('lark.sales.processing.thread_progress', {
        task_id: taskId, kind: threadProgress.kind, duration_ms: Date.now() - startedAt,
      });
      return threadProgress;
    }
    // 两张配置表都很小（配品十几条、在售券几条），先并行拿齐：
    // 配品清单交给 AI 是为了让它知道「39元腰带」这类说法不是鞋；
    // 券目录交给后端是为了按表里的平台结算款算钱，不再写死券种。
    const [accessories, vouchers] = await Promise.all([
      this.listAccessories(),
      this.listGroupBuyVouchers(),
    ]);
    // 交给 AI 的配品词表：名称 + 表里实际存在的「种类」。
    // 为什么要带上「种类」：用户嘴上说的是「鞋油」，而表里这条叫「15元鞋油」；
    // 只给名称，AI 可能认不出这是配品，后端新加的"按分类匹配"就永远轮不到。
    // 去重是因为「女士包」这类词既是名称又是分类。
    const accessoryVocabulary = [...new Set(
      accessories.flatMap((item) => [item.name, item.category]).filter(Boolean)
    )];
    // AI 解析是最慢的一段（十几秒），读实时库存和货品资料不依赖它的结果，所以三件事
    // **同时启动**：读表的时间藏在 AI 后面，不额外增加用户等待。
    //
    // 与改动前的区别只在"先 await 谁"：这里先只等 AI。查销售记录（退换货第一期）
    // 只需要 AI 判出的货号颜色 + 销售记录本身，不需要那两张表，所以一拿到意图就出卡片，
    // 不必陪着读完库存。销售链路仍然是三者并行，总耗时不变（都是 max(AI, 读表)）。
    const parsePromise = this.recognizer.parseSalesText(task.original_text, {
      taskId, accessoryNames: accessoryVocabulary, vouchers,
    });
    const liveInventoryPromise = this.loadLiveInventoryIndex();
    // 货品信息是主数据，整表读一次即可；读挂了也不影响录单，所以单独吞掉异常。
    const productIndexPromise = this.loadProductIndex().catch((error) => {
      logWarn('lark.sales.product_index.load_failed', { task_id: taskId, error: error.message });
      return null;
    });
    const parsed = await parsePromise;
    // 意图是「AI 输出」到「后端分支」的唯一契约，统一先收敛成注册表里的规范值：
    // 认不出来一律 unsupported，不会被误判成 sale 去写单（见 config/saleIntents）。
    const intent = normalizeMessageIntent(parsed.intent);

    // 查销售记录：只读 + 只展示，绝不写业务表（实现全在 SaleLookupService）。
    if (isLookupIntent(intent)) {
      // 这一次用不上的在途读取挂一个吞异常的 catch：不 await 它，但也不让它变成
      // unhandledRejection 把进程日志搞脏。
      liveInventoryPromise.catch(() => undefined);
      productIndexPromise.catch(() => undefined);
      // 把收敛后的 intent 一并传下去：SaleLookupService 只认规范值，不猜模型的措辞。
      const result = await this.saleLookup.handleQuery(task, { ...parsed, intent });
      // 第二期：把这次查到的候选按**人**记一份（跨消息、10 分钟有效），
      // 下一句「第 2 笔，退货」才定位得到（每条消息都是一个新任务）。
      // 这一步只是本地缓存，失败不影响查询结果，所以吞掉异常只记警告。
      await this.afterSalesFlow
        .rememberCandidates(task.sender_open_id, result?.candidates || [])
        .catch((error) => logWarn('after_sales.context.remember_failed', {
          task_id: taskId, error: error.message,
        }));
      return result;
    }
    // 退货 / 换货 / 赔货：真执行——先出确认卡片，她点确认后才调执行器
    // （编排全在 AfterSalesFlowService，本类只做这一行分派）。
    if (isAfterSalesIntent(intent)) {
      liveInventoryPromise.catch(() => undefined);
      productIndexPromise.catch(() => undefined);
      return this.afterSalesFlow.handle(task, { ...parsed, intent });
    }
    const [liveInventory, productIndex] = await Promise.all([liveInventoryPromise, productIndexPromise]);
    // 走到这里已经过了入口闸门（不含数字也不含业务关键词的消息更早被静默挡掉），
    // 只是 AI 认不出意图 —— 所以这里**可以**回一句引导语，把"能说什么"教给她。
    // ⚠️ 引导语只在这一档发；闸门没过的消息一律不回，不允许在这条链路上"兜底回复"。
    if (intent !== 'sale') {
      await this.store.update(taskId, { status: 'ignored', draft: parsed });
      logInfo('lark.sales.processing.ignored', {
        task_id: taskId,
        sender_open_id: task.sender_open_id,
        duration_ms: Date.now() - startedAt,
        reason: 'unsupported_intent',
        intent,
      });
      await this.sendTaskText(task, UNSUPPORTED_INTENT_REPLY);
      return;
    }

    await this.ensureIntakeSchema('sales_intake', ['salesEntry']);
    // ⭐ 话题里后续的消息（C）：任务上已经带着**本地映射定位到的那笔销售**，
    //    直接沿用同一条销售主表记录 —— 不再新建第二条（一条销售记录 = 一个话题）。
    //    ⚠️ 私聊的任务上没有这个字段（`undefined`），走的仍然是原来那一个建单入口，
    //       行为与改动前逐字相同。
    const locatedSaleRecordId = task.sales_entry_record_id || '';
    const created = locatedSaleRecordId
      ? { recordId: locatedSaleRecordId, reused: true }
      : await this.createSalesEntryWithOrderNo(task);
    const salesEntryRecordId = created?.recordId;
    if (!salesEntryRecordId) throw new Error('销售主表未返回 record_id');
    if (created.reused) logInfo('lark.sales.entry.reused', { task_id: taskId, sales_entry_record_id: salesEntryRecordId });
    await this.store.update(taskId, { sales_entry_record_id: salesEntryRecordId, status: 'parsing' });
    // 群聊回复时要带上"这是哪一条销售主表记录"（本地映射记的就是它）。
    // ⚠️ `task` 是本方法开头读进来的**快照**，销售主表 record_id 是刚刚才写进 store 的，
    //    所以下面群聊那两条路用 `replyTask`，不用 `task`。
    const replyTask = { ...task, sales_entry_record_id: salesEntryRecordId };

    const missingFields = [...(parsed.missing_fields || [])];
    // ⭐ 2026-10-07 口径大改：**类型 = 实时库存里有没有这一双**（判据在
    //    `config/salesTradeTypePolicy.salesTradeTypeForStock`），所以下面循环里
    //    **逐行查、逐行定**；整单去重后的那几个写进主表多选（`orderTradeTypeCodes`）。
    //    ⚠️ 解析层给的 `parsed.trade_type` **只是提示**，不再决定任何事。
    // 缺货**不再是缺项**：实时库存里没有这一双 ⇒ **预定**，是合法输入、照出卡片，
    // 所以这里不再有 `shortageNotes` / `colorScopeNotes`。
    // 「货号没建档」单独收集：它是一句完整的话，前面再套一层
    // "销售信息还缺…"反而看不清要她做什么。
    const registrationNotes = [];
    // 开关 / 文案一次读进来（**调用时才解析** process.env，不在模块加载时求值）。
    const registrationConfig = resolveSalesProductRegistrationConfig(process.env);
    const items = [];
    for (const [index, item] of (parsed.items?.length ? parsed.items : [parsed]).entries()) {
      const itemQuantity = Number(item.quantity || 1);
      const quantityIssue = `第${index + 1}件请逐双列出成交金额；每条销售明细只能记录一双`;
      if (itemQuantity !== 1 && !missingFields.includes(quantityIssue)) missingFields.push(quantityIssue);
      // ── ⭐ 逐明细的交易类型（业务负责人 2026-10-07 口径大改）──────────────────────
      //   「【类型 = 只看库存】库存里有这双 → 现货；库存里没有 → 预定」
      //   ⇒ 解析层给的 `trade_type` **只是提示**（配品那种查不到库存的才沿用），
      //     鞋的类型由**下面这一次实时库存查询**定（`salesTradeTypeForStock`）。
      //   A（货品信息）与 B（实时库存）**两种类型都跑** —— 这里没有任何"按类型跳过"的开关。
      if (item.kind === 'accessory') {
        // 配品先按「种类」找，找不到再退回按名称精确匹配（见 accessoryMatchPolicy）。
        // 为什么不能只按名称精确匹配：表里叫「15元鞋油」，用户说的是「鞋油」，
        // 精确匹配必然失败，于是"配品明明有，系统却说没有"。
        // 用**她说的价位**（tier_price）去对多档（腰带 9 档）里是哪一条记录：
        // 这个价位只用于定位记录，**不是成交金额**（119 的腰带收了 100，成交就是 100）。
        // 她说价位时模型放在 tier_price 里；只说了一个数（老形状）时退回 actual_amount，
        // 后者在解析层已被换成实收，所以优先 tier_price。
        const spoken = String(item.accessory_name || '').trim();
        const resolved = resolveAccessory({
          spoken, amount: item.tier_price || item.actual_amount, accessories,
        });
        if (!resolved.match) {
          missingFields.push(`第${index + 1}件：${resolved.issue}`);
        }
        items.push({ ...item, quantity: itemQuantity, accessory_record_id: resolved.match?.record_id || '' });
        continue;
      }
      // ── 卖一双鞋要跑两个**互相独立**的解析（各读一张表，见 config/salesTradeTypePolicy）──
      //   A 货品信息（「货品信息」）：颜色 / 商品记录 id —— **全部颜色都给候选**。
      //   B 库存可得性（「实时库存」）：有没有这一双 + 门盒/样品/仓库 ——
      //     ⭐ **这就是类型的判据**（有货 → 现货，没货 → 预定），所以**两种类型都跑**。
      //   ⭐ 顺序（她的三步流程）：A 给候选 → 她选颜色 → 拿着选定的颜色跑 B 定类型。
      //     · A 给出**多个**颜色 ⇒ 出候选让用户选，**在她选定之前 B 一次都不跑**；
      //     · A 给出**单个**颜色 ⇒ 直接定下来（不问她），B 拿这个颜色去查；
      //     · A 什么都给不出（「货品信息」读不到）⇒ 才让 B 按货号+尺码摆候选（兜底）。
      //     ⚠️ 不再出现旧行为那种"B 用候选把 A 整体替换掉"。
      let productRecordId = '';
      let color = '';
      let colorOptions = null;
      let stock = null;
      let samplePlan = null;
      // ⭐ 类型的结论：`null` = **还没定**（多颜色、颜色还没选 / 库存还没查）；
      //    true / false = 这一次实时库存里有没有这一双 ⇒ 现货 / 预定。
      let inStock = null;
      if (item.item_no && item.size) {
        // ── 解析 A ──（两种类型都跑）
        const productInfo = await this.resolveProductInfoForSale({ itemNo: item.item_no });
        productRecordId = productInfo.productRecordId || '';
        color = productInfo.color || '';
        // ⭐ 多个颜色：**A 的候选**（不是 B 的）交给确认卡片让用户选。
        //    ⚠️ 候选 = **全部颜色**（2026-10-07 撤掉"只推在售"：预定 = 没货，
        //       过滤掉没货的颜色她就永远选不到，预定这条路走不通）。
        //    ⚠️ 候选**只带颜色名**（2026-10-07 业务负责人逐字「甲 去掉」）：
        //       这里**不打**「有货 / 无货」预览标注 —— 她选完颜色之后才查库存、才定现货 / 预定。
        if (productInfo.colorOptions?.length) {
          colorOptions = productInfo.colorOptions.map((option) => ({ ...option }));
          // 可排查：这一单给了几个候选（**不再**记有货 / 无货数：候选上已经没有那个状态）。
          logInfo('lark.sales.color_options.offered', {
            task_id: taskId,
            item_no: item.item_no,
            size: item.size,
            option_count: colorOptions.length,
          });
        }
        // ── 判据 A′：这个货号有没有在「货品信息」里建档 ──
        // **两种交易类型都走这里**（它在库存那一段**之外**）。
        // ⚠️ 只判"这张表里有没有这个货号的记录"；"有记录但资料不齐"不走这里（不拦）。
        const registration = this.productRegistrationFrom({
          itemNo: item.item_no, productInfo, productIndex,
        });
        if (registration.status === 'missing') {
          // ⭐ 正向证据：这一单**为什么没出卡片**，看这条 —— 带 task_id / item_no / size。
          //    开关关掉时记的是另一条（`…guard_disabled`）：两条合起来才能回答
          //    "是判据拦的"还是"配置关了"（都不拦时也不至于看不出原因）。
          logInfo(
            registrationConfig.enabled
              ? SALES_PRODUCT_REGISTRATION_EVENTS.blocked
              : SALES_PRODUCT_REGISTRATION_EVENTS.guardDisabled,
            {
              task_id: taskId,
              item_no: item.item_no,
              size: item.size,
              item_index: index,
              // 类型**这时还没定**（要等库存查询）：只记解析层给的提示，便于对照。
              trade_type_hint: item.trade_type || parsed.trade_type,
              index_available: registration.indexAvailable,
              reason: registration.reason,
            },
          );
          if (registrationConfig.enabled) {
            const text = formatMissingProductText(registrationConfig.missingText, {
              itemNo: item.item_no,
            });
            // 同一个货号的多条明细（例如同款两个尺码）只报一次：
            // 这句话是按**货号**说的，重复两遍不增加信息，只会让她以为要建两次档。
            if (!registrationNotes.includes(text)) registrationNotes.push(text);
            if (!missingFields.includes(text)) missingFields.push(text);
          }
        } else if (registration.status === 'unknown') {
          // 读不到「货品信息」⇒ 不下"没建档"的结论、也不拦单（AGENTS.md 第 17 条）。
          // ⚠️ 这里只记一条 warn：它**不是**拦截证据，别拿它当"已经提示过"。
          logWarn(SALES_PRODUCT_REGISTRATION_EVENTS.undetermined, {
            task_id: taskId,
            item_no: item.item_no,
            size: item.size,
            item_index: index,
            reason: registration.reason,
          });
        }
        // ── 解析 B：实时库存（**类型的判据本身**，两种类型都跑）──
        if (colorOptions?.length) {
          // ⭐ A 已经给出多个颜色 ⇒ 颜色还没定，**B 一次都不跑**（她的口径：
          //    "在用户选定颜色之前，B 不跑"）。等她点完候选，`choose_sale_color`
          //    里再拿**那个颜色**跑 B —— 那一次才定类型。
          // 可排查：这一单为什么这次还没定类型（而不是"静默跳过"）——答案就是"等她选颜色"。
          logInfo('lark.sales.stock_existence.deferred', {
            task_id: taskId, item_no: item.item_no, size: item.size, step: 'stock',
            color_option_count: colorOptions.length,
            reason: 'awaiting_color_choice',
          });
        } else {
          // A 定下来的颜色（单色货号；A 读不到时是空串 ⇒ B 走兜底那条老路）。
          const availability = this.resolveStockAvailabilityForSale(
            { itemNo: item.item_no, size: item.size, itemQuantity, color },
            liveInventory,
          );
          inStock = Boolean(availability.inStock);
          if (availability.inStock) {
            // ⭐ 颜色 / 记录 id **以 A（货品信息）为准**；A 没给出来的才用 B 的。
            //    B 只回答"这个颜色在这个尺码有没有货"，**不再整体替换 A 的候选**。
            productRecordId = productRecordId || availability.productRecordId || '';
            color = color || availability.color || '';
            // 只有 A 没能给出候选时 B 才补候选（「货品信息」读不到时的兜底路径）。
            colorOptions = colorOptions || availability.colorOptions || null;
            stock = availability.stock || null;
            samplePlan = availability.samplePlan || null;
            // B 兜底又给出多个颜色 ⇒ 还是"颜色没定"，类型等她那一次点击。
            if (colorOptions?.length) inStock = null;
          }
          // ⭐ 正向证据：这一单的**类型是怎么定下来的**（判据 = 库存有没有）——
          //    以后问"为什么这单是预定 / 现货"，看这条，不用猜。
          logInfo('lark.sales.trade_type.decided', {
            task_id: taskId,
            item_no: item.item_no,
            size: item.size,
            color,
            judged_by: 'realtime_stock',
            in_stock: inStock,
            trade_type_code: inStock === null ? '' : salesTradeTypeForStock({ inStock }),
            step: 'intake',
          });
        }
      }
      // ⭐ 这一条明细的类型：鞋 = 上面那次库存查询的结论（还没查 → 空串 = "还没定"）；
      //    配品没有货号 / 尺码、无从查库存 ⇒ 沿用她嘴上说的性质（解析层已收敛成编码）。
      const itemTradeTypeCodeForSale = (item.item_no && item.size)
        ? (inStock === null ? '' : salesTradeTypeForStock({ inStock }))
        : String(item.trade_type_code || '').trim();
      items.push({
        ...item,
        quantity: itemQuantity,
        // ⚠️ `trade_type` / `trade_type_code` 一律写**结论**（不是模型的原话）：
        //    认不出来时是空串 —— 空串在 `itemTradeTypeCode` 里就是"还没定"，
        //    绝不能让模型说的「预定」在库存明明有货时还留在行上。
        trade_type: tradeTypeLabel(itemTradeTypeCodeForSale),
        trade_type_code: itemTradeTypeCodeForSale,
        product_record_id: productRecordId,
        color,
        // 展示用编号：货号 + 颜色——实时库存里就是用这两个要素定位一双鞋。
        product_number: productRecordId ? `${item.item_no}${color}` : '',
        ...(colorOptions ? { needs_color: true, color_options: colorOptions } : {}),
        ...(stock ? { stock } : {}),
        ...(samplePlan || {}),
      });
    }
    // 货品资料缺口：从**已经读好的**索引里算，不再请求远端。
    const productInfoGaps = this.productInfoGapsFromIndex(items, productIndex);

    const actualTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount || 0), 0) * 100) / 100;
    if (!parsed.voucher_policy_blocked && items.some((item) => !Number(item.actual_amount))) missingFields.push('请逐件说明成交金额');
    if (parsed.agreed_total && Math.abs(actualTotal - Number(parsed.agreed_total)) > 0.005) {
      missingFields.push('逐件成交金额合计与整单成交金额不一致');
    }
    if (!parsed.voucher_policy_blocked && Number(parsed.total_covered ?? parsed.total_paid ?? 0) > actualTotal) {
      missingFields.push('已收金额和待平台结算金额不能超过本单成交金额');
    }

    // ⭐ 类型的判据是**实时库存**（上面每一条明细各查了一次），**交付状态由类型推出来**
    //   （`config/salesMovements.delivery`），不再让用户在卡片上选。
    // ⭐ 一张单可以**同时**有现货与预定（业务负责人：「这就是一个人买的呀」）⇒
    //    · 每一行自己的类型在 `items[].trade_type_code`（明细行写它，单选；""= 还没定）；
    //    · 整单是 `trade_type_codes` **去重后的多个**（主表写它，多选）；
    //    · 整单的 `delivery_status` 只在"**所有行都不交付**"时才是未交付，否则按行判。
    // ⚠️ **整单的 `trade_type_code` 恒为空串**：新口径下"整单一个类型"不存在，
    //    它只能当**兜底**用 —— 而拿它当兜底会把"颜色还没选、类型还没定"的行
    //    静默当成整单的那个类型（那就等于没查库存就定了类型）。所以刻意留空。
    const orderTradeTypeCodesForThisOrder = orderTradeTypeCodes(items, '');
    const deliverableItemCount = items.filter((item) =>
      deliversForTradeType(itemTradeTypeCode(item, ''))).length;
    const draft = {
      ...parsed,
      product_info_gaps: productInfoGaps,
      // 显示用的整单类型（诊断 / 摘要里人读）：去重后的规范标签；还没定时是空串。
      trade_type: [...new Set(orderTradeTypeCodesForThisOrder
        .filter(Boolean).map((code) => tradeTypeLabel(code)))].join('/'),
      trade_type_code: '',
      trade_type_codes: orderTradeTypeCodesForThisOrder,
      // 「整单要不要交付」只作**兼容字段**：只要有一行要交付，就标已交付（真正逐行判在
      // confirm 里）。纯预定 → 未交付，其余 → 已交付。
      delivery_status: deliverableItemCount > 0 ? '已交付' : '未交付',
      product_number: items[0]?.product_number || '',
      items,
      missing_fields: missingFields,
    };
    // 交易类型落成关联「行为管理」的记录，便于以后筛选和对账。
    // ⭐ 多选：把**去重后的每一个**编码都解析成记录 id（顺序 = 明细行出现顺序）。
    // ⚠️ 这一步在**确认入账前**还会再同步一次（见 `syncSalesTradeTypes`）：
    //    多颜色时类型要等她选完颜色、查完库存才知道，录单这一次可能一个编码都没有。
    const tradeTypeRecordIds = await this.syncSalesTradeTypes({
      salesEntryRecordId, items, taskId,
    });
    // ⚠️ 复用已定位的那笔销售时（群话题里的后续消息），**不写**这几个"解析中间态"
    //    字段：`解析摘要` 里放的是**这一条消息**的草稿，写上去会把她原单的解析摘要盖掉。
    //    她的原单已经在表里了，这次的处理过程留在本地任务里就够（不放业务表）。
    // ⭐ 「销售信息还缺…」那段话**只在这里渲染一次**（两处出口共用同一份，见下）：
    //    · 「解析失败原因」列（表里给她看的解释）—— 只取分行的**条目**、不带开头那句汇总；
    //    · 群里回她那一条 —— 带开头汇总 + 行首编号。
    // ⚠️ 渲染器只把 `missing_fields`（机器清单）翻成人话，**不改条数、不改判据**；
    //    `missing_fields` 本身与 `解析结果摘要`（JSON）**逐字不变** —— 排查时仍看得到原值。
    const missingInfo = renderSalesMissingInfo({
      missingFields: draft.missing_fields || [],
      items,
      payments: draft.payments || [],
    });
    // 摸底：万一将来冒出一种"渲染不出来的形状"，**绝不静默** ——
    // 退回改动前的原样拼接（宁可不好看，也不能让她以为"没事了"）。
    const missingInfoText = missingInfo.text || draft.missing_fields.join('\n');
    const missingInfoLines = missingInfo.lines.length ? missingInfo.lines : draft.missing_fields;
    if (!created.reused) {
      await this.gateway.update('salesEntry', salesEntryRecordId, {
        parseStatus: draft.missing_fields?.length ? '需补充' : '解析成功',
        parseSummary: JSON.stringify(draft),
        // ⭐ 这一行是 #233 的（缺项文案人话化）：渲染成分行的人话。
        failureReason: draft.missing_fields?.length ? missingInfoLines.join('\n') : '',
        // ⭐ 这一行是 #234 的（一单多明细）：交易类型**按明细行**收集、主表**多选**。
        // 两行来自不同的改动，各自都是对的、互不相干 —— 所以**两行并存**，一行都不删。
        // 「交易类型」是**多选**关联字段：一个 id 就是单选（长度 1），多个就是多选。
        ...(tradeTypeRecordIds.length ? { tradeType: relation(tradeTypeRecordIds) } : {}),
      });
    }
    await this.store.update(taskId, {
      status: draft.missing_fields?.length ? 'needs_info' : 'ready_to_confirm',
      draft,
    });
    if (draft.missing_fields?.length) {
      // 优先级：「货号没建档」> 完整说明。
      // ⚠️ 2026-10-07：「缺货」「颜色全不在售」两条独立短句**已退场** ——
      //    没货不再是缺项（它就是「预定」，是合法输入、照出卡片）。
      //    「货号没建档」那句话本身就是完整的（她照着做就行），再套一层
      //    "销售信息还缺…"只会把要她做的事埋起来；一单多双只缺一双时，这里也只报那一双。
      // ⭐ 完整说明那一支 2026-10-07 改过：原来是
      //    `销售信息还缺：${missing_fields.join('、')}。请补充后重新发送完整销售信息。`
      //    —— 把代码标识符（`items[0].actual_amount`）漏给她，还把 4~5 句串成一段。
      //    现在走渲染器：**一件事一行 + 每条都有具体动作 + 一个字都不含代码标识符**。
      await this.sendTaskText(replyTask, registrationNotes.length
        ? registrationNotes.join('\n')
        : missingInfoText);
      return;
    }
    const cardStartedAt = Date.now();
    // 群聊：回复进她的销售话题（`reply_in_thread`），并把飞书回带的话题 id 记进本地映射（B / A）。
    // 🔴 2026-10-07 三次收尾：**非群任务没有去处** —— 这里原来是
    //   `await this.replyCard(task.message_id, …)`（= 回她那条私聊消息），
    //   那正是"非群也会回一条"的最后两条口子之一。私聊入口已移除，
    //   非群 → 只记一条 `lark.private_chat.send_skipped`（`skipNoGroupContext`）、
    //   `cardMessageId` 为 `null`（下面据此不写 `card_message_id`）。
    //   见 docs/private-chat-removal-2026-10-07.md 第七节。**群那一条逐字不变。**
    const cardMessageId = task.chat_type === 'group'
      ? await this.sendTaskCard(replyTask, salesConfirmationCard(taskId, draft))
      : skipNoGroupContext('card', task);
    // 没发出去的（`null`）就不许记「已发出」——这是 `skipNoGroupContext` 的语义
    // （调用方据此知道"这次没发出去"；谎报已发送会让遗留任务的排查方向跑偏）。
    if (cardMessageId !== null) logInfo('lark.sales.card.sent', {
      task_id: taskId, stage: 'confirmation',
      duration_ms: Date.now() - cardStartedAt,
      // 她感知到的"从发消息到看见卡片"就是这个数；单看它比看各段之和更准。
      since_message_ms: Date.now() - startedAt,
    });
    if (cardMessageId) await this.store.update(taskId, { card_message_id: cardMessageId });
    logInfo('lark.sales.processing.completed', {
      task_id: taskId,
      sales_entry_record_id: salesEntryRecordId,
      item_count: items.length,
      // 从"收到消息"到"卡片发出去"——用户实际等的时间。各段耗时之和可以比它大，
      // 因为并行的几段是重叠的；校准优化效果应该看这个数。
      user_wait_ms: Date.now() - startedAt,
      duration_ms: Date.now() - startedAt,
      result: 'awaiting_confirmation',
    });
  }

  async handleCardAction(event, context = {}) {
    const value = event?.action?.value || event?.event?.action?.value || {};
    const draftId = value.draft_id;
    const action = value.action;
    const operatorOpenId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    if (['choose_sample_replacement', 'refresh_sample_replacement'].includes(action)) {
      return this.sampleReplacements.handleCardAction(value, event, operatorOpenId, context);
    }
    // 「采购到货核对」卡片的「是 / 否」。
    // ⚠️ 位置有意放在这里（采购申请卡片分派**之前**、下面那句 `if (!draftId) throw` 之前）：
    //   这张卡片也带 draft_id（= 到货核对任务 id，不是销售草稿），落到下面那套销售逻辑里
    //   一定会报「卡片缺少草稿 ID」或更糟——把别人的草稿当成自己的。
    //   动作名与卡片渲染共用 config 里的同一份常量。
    if ([ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, ARRIVAL_CONVERSATION_ACTIONS.REJECT].includes(action)) {
      return this.arrivalConversation.handleCardAction(value, event, operatorOpenId);
    }
    const procurementResult = await this.purchaseWebhooks.handleCardAction(value, operatorOpenId, event);
    if (procurementResult) return procurementResult;
    // 「第二次交付」的「成交」按钮：收尾的是**已入账、尚未完成履约**的单。
    // ⚠️ 位置有意放在这里——采购分派之后（它只认自己的动作名，我们的动作会返回 null）、
    // 下面那句 `if (!draftId) throw` 之前：这条链路绑的是销售主表 record_id，
    // 根本没有草稿，也没有草稿状态机，落在下面那套逻辑里一定抛「卡片缺少草稿 ID」。
    // 动作名用 larkCards 里那一个常量，卡片和分派不会各写一份而慢慢写歪。
    if (action === SECOND_DELIVERY_ACTION) {
      return this.handleSecondDeliveryAction(value, operatorOpenId, event);
    }
    if (!draftId) throw new Error('卡片缺少草稿 ID');
    // 售后卡片：确认 / 取消 / 选回库状态。和销售草稿共用同一个串行队列
    // （同一张卡片连点两次会被排成一前一后），执行器那一层再兜一次幂等。
    if (isAfterSalesCardAction(action)) {
      return this.cardActionQueue.run(draftId, () =>
        this.afterSalesFlow.handleCardAction(value, event, operatorOpenId, context));
    }
    return this.cardActionQueue.run(draftId, () => this.handleSalesOrLegacyCardAction(event, context));
  }

  /**
   * 「成交」：已入账、尚未完成履约的单收尾（补收款 + 交付）。
   *
   * 这里只做三件事：把按钮带上来的「销售单号 + 收款方式」转给编排服务，
   * 把"点的是哪条群消息、哪天的卡"一起带下去（成交成功后要把那张卡的这一单变灰，
   * 见 SecondDeliveryService.markCardSettled），以及把结果说成她能看懂的一句话。
   * 写账、扣库存全在 SecondDeliveryService 里，本类不碰——那两件事都必须只有一处实现。
   */
  async handleSecondDeliveryAction(value, operatorOpenId, event = {}) {
    const result = await this.secondDelivery.confirm({
      salesEntryRecordId: value?.sales_entry_record_id,
      // 收款方式由按钮带上来的，缺了会让补收款明确报错，不在这里兜一个默认值。
      method: value?.method,
      operatorOpenId,
      // 卡片回调事件里的消息 id = 被点的那张卡；reminder_day 是发卡时写进按钮取值的。
      cardMessageId: event?.context?.open_message_id || event?.open_message_id || '',
      reminderDay: value?.reminder_day || '',
    }, {
      // 关联键：这条链路上没有本地任务（点的是每日提醒卡），能给的业务键就是这张销售单。
      correlation: { sales_entry_record_id: value?.sales_entry_record_id },
    });
    if (result.alreadyCompleted) {
      return { toast: { type: 'info', content: '这一单已经成交，无需重复处理' } };
    }
    const parts = [];
    if (result.collectedAmount > 0) parts.push(`补收款 ￥${result.collectedAmount}`);
    const deliveredCount = Number(result.delivery?.deliveredQuantity || 0);
    if (result.delivery && deliveredCount > 0) parts.push(`交付 ${deliveredCount} 双`);
    const failedCount = result.delivery?.failures?.length || 0;
    if (failedCount) {
      // 钱已经收下、货只交了一部分：如实说清，并指到工作台去处理，不能报成功。
      return { toast: { type: 'warning', content:
        `已成交：${parts.join('，')}；还有 ${failedCount} 双交付未完成，请到工作台待交付列表核对` } };
    }
    return { toast: { type: 'success', content: `已成交：${parts.join('，') || '无待处理项'}` } };
  }

  async handleSalesOrLegacyCardAction(event, context = {}) {
    const value = event?.action?.value || event?.event?.action?.value || {};
    const draftId = value.draft_id;
    const action = value.action;
    const operatorOpenId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    const task = await this.store.get(draftId);
    if (!task) throw new Error('确认草稿不存在或已过期');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由原始发送人确认该草稿');
    if (['posted', 'posted_delivery_pending', 'cancelled'].includes(task.status)) {
      if (task.type === 'sale') {
        const completed = task.status === 'posted';
        // ⭐ 2026-10-07：这张也是"已入账"的终态卡面（`completed` 那支与 `posted` 分支同标题），
        //   所以**同一状态必须带同一段补货品信息**；`cancelled` 那支 = 原草稿不会入账 ⇒ 不带。
        //   判据是"这单入账了没有"，不是"这张卡长得像不像终态"。
        const card = salesStatusCard(task.draft,
          task.status === 'cancelled' ? '销售录单已取消' : completed ? '销售订单已入账' : '订单已入账，交付待核对',
          task.status === 'cancelled' ? '原草稿不会入账。' :
            `销售单号：${task.posting_result?.sourceNo || '请在销售主表核对'}；${completed
              ? deliverySummaryOfDraft(task.draft, shouldDeliverFor(task, task.posting_requested_action)).card
              : '交付结果尚未确认，请到工作台核对。'}`,
          task.status === 'cancelled' ? 'blue' : completed ? 'green' : 'orange',
          { productInfoGaps: task.status !== 'cancelled' });
        await this.publishSalesResultCard(task, event, card,
          { stage: 'duplicate_terminal', interactionId: context.interactionId });
      }
      return { toast: { type: 'info', content: task.status === 'posted_delivery_pending'
        ? '订单已入账，交付结果请在工作台核对' : '该草稿已处理' } };
    }
    if (task.status === 'posting') return { toast: { type: 'info', content: '正在入账，请勿重复点击' } };
    if (task.status === 'awaiting_correction' && action !== 'cancel') {
      return { toast: { type: 'info', content: '该草稿正在等待修正，请重新发送完整销售信息' } };
    }
    const hasWrittenSaleRecords = task.type === 'sale' && (task.posting_records_written === true ||
      Object.values(task.posting_record_ids || {}).some((ids) => Array.isArray(ids) && ids.some(Boolean)));
    if (hasWrittenSaleRecords && ['cancel', 'modify_sale'].includes(action)) {
      return { toast: { type: 'warning', content: '这张销售单已有明细或收款，不能直接取消或修改；请先核对现有记录' } };
    }
    if (hasWrittenSaleRecords && ['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      task.posting_requested_action && action !== task.posting_requested_action) {
      return { toast: { type: 'warning', content: '请沿用原来的交付选择继续处理这张销售单' } };
    }

    if (action === 'cancel') {
      await this.store.update(draftId, { status: 'cancelled' });
      if (task.type === 'sale' && task.sales_entry_record_id) {
        await this.salesStatus.write(task.sales_entry_record_id, { userAction: WRITE.userAction.cancelled });
        await this.publishSalesResultCard(task, event, salesStatusCard(task.draft, '销售录单已取消', '原草稿不会入账。'),
          { stage: 'cancelled', interactionId: context.interactionId });
      }
      return { toast: { type: 'info', content: '已取消' } };
    }

    if (action === 'modify_sale' && task.type === 'sale') {
      await this.store.update(draftId, { status: 'awaiting_correction' });
      if (task.sales_entry_record_id) {
        await this.salesStatus.write(task.sales_entry_record_id, { userAction: WRITE.userAction.toModify });
      }
      await this.publishSalesResultCard(task, event, salesStatusCard(task.draft, '等待重新发送', '原草稿不会入账；请重新发送完整销售信息。', 'orange'),
        { stage: 'awaiting_correction', interactionId: context.interactionId });
      await this.sendTaskText(task, '请重新发送一条完整、正确的销售信息；原草稿不会入账。').catch((error) =>
        logWarn('lark.sales.feedback.failed', { task_id: draftId, interaction_id: context.interactionId, error: error.message }));
      return { toast: { type: 'info', content: '请重新发送修正后的完整销售信息' } };
    }

    if (action === 'choose_sale_sample_replacement' && task.type === 'sale') {
      const itemIndex = Number(value.item_index);
      const items = (task.draft?.items || []).map((item) => ({ ...item }));
      const item = items[itemIndex];
      if (!item) throw new Error('找不到要补样品的明细');
      if (!item.needs_sample_replacement) throw new Error('这一双不需要补样品');
      const size = Number(value.size);
      const option = (item.sample_replacement_options || []).find((row) => Number(row.size) === size);
      if (!option) throw new Error('补样品的尺码不在候选里，请刷新卡片后重试');
      items[itemIndex] = { ...item, sample_replacement_size: size };
      const draft = { ...task.draft, items };
      await this.store.update(draftId, { draft, status: 'ready_to_confirm' });
      await this.publishSalesResultCard({ ...task, draft }, event, salesConfirmationCard(draftId, draft),
        { stage: 'sample_replacement_chosen', interactionId: context.interactionId });
      logInfo('lark.sales.sample_replacement.chosen', {
        task_id: draftId, item_index: itemIndex, size,
      });
      return { toast: { type: 'success', content: `第 ${itemIndex + 1} 双将用 ${size}码的门盒补样品` } };
    }

    if (action === 'choose_sale_color' && task.type === 'sale') {
      const itemIndex = Number(value.item_index);
      const items = (task.draft?.items || []).map((item) => ({ ...item }));
      const item = items[itemIndex];
      if (!item) throw new Error('找不到要设置颜色的明细');
      if (!value.record_id) throw new Error('卡片里缺少颜色记录 ID');
      // 用户在卡片上选定颜色：这一条明细的货品就此确定。
      // ⚠️ **颜色以她点中的那条候选为准**（`color_options` 里那条），不用卡片回带的展示串。
      const chosen = (item.color_options || []).find((option) => option.recordId === value.record_id);
      const chosenColor = chosen?.color || value.color_name || item.color || '';
      const settled = {
        ...item,
        product_record_id: value.record_id,
        color: chosenColor,
        product_number: value.product_number || item.product_number || item.item_no || '',
      };
      // ── ⭐ 颜色定下来**之后**才跑解析 B —— **这一次才定类型**（她的三步流程第 3 步）──
      //   「用户选完之后，再拿着用户选的颜色去……找，如果找到了，就是现货，如果没找到，就是预定」
      //   ⇒ 找到 → `SALE_CASH`（现货，交付并扣库存）；没找到 → `SALE_PREPAID`（预定，不交付）。
      //   🔴 **没找到不是错误**：不再有"缺货提示 / 请核实"，也不再把候选留着让她重选。
      // 跑的是同一个 `resolveStockAvailabilityForSale`，输入带上她选定的颜色。
      // ⚠️ 只把**远端读表**这一步当作"可重试的失败"：读不到就**不下结论**（AGENTS.md 第 17 条）、
      //    候选保留、回她一句让她再点一次（**类型也不写** —— 宁可让她再点一次，
      //    也不能在没查到库存的情况下替她定成现货或预定）；纯函数里的编程错误照旧抛出来。
      let inStock = null;
      {
        let liveInventory = null;
        let readError = null;
        try {
          liveInventory = await this.loadLiveInventoryIndex();
        } catch (error) {
          readError = error;
        }
        if (readError) {
          const failureText = resolveSalesColorChoiceConfig().stockLookupFailedText;
          logWarn('lark.sales.color.stock_lookup_failed', {
            task_id: draftId, item_index: itemIndex, color: chosenColor, error: readError.message,
          });
          await this.sendTaskText(task, failureText).catch((error) =>
            logWarn('lark.sales.feedback.failed', {
              task_id: draftId, interaction_id: context.interactionId, error: error.message,
            }));
          return { toast: { type: 'warning', content: failureText } };
        }
        const availability = this.resolveStockAvailabilityForSale({
          itemNo: item.item_no,
          size: item.size,
          itemQuantity: Number(item.quantity || 1),
          color: chosenColor,
        }, liveInventory);
        inStock = Boolean(availability.inStock);
        if (availability.inStock) {
          if (availability.stock) settled.stock = availability.stock;
          // 颜色定了才知道"卖的是不是样品"：补样品方案由 B 现算（不是候选里预先带的）。
          Object.assign(settled, availability.samplePlan || {});
        }
      }
      const chosenTradeTypeCode = salesTradeTypeForStock({ inStock });
      settled.trade_type_code = chosenTradeTypeCode;
      settled.trade_type = tradeTypeLabel(chosenTradeTypeCode);
      // ⭐ 正向证据：类型是**这一次点击、这一次库存查询**定下来的（判据 = 库存有没有）。
      logInfo('lark.sales.trade_type.decided', {
        task_id: draftId,
        item_index: itemIndex,
        item_no: item.item_no,
        size: item.size,
        color: chosenColor,
        judged_by: 'realtime_stock',
        in_stock: inStock,
        trade_type_code: chosenTradeTypeCode,
        step: 'color_chosen',
      });
      items[itemIndex] = {
        ...settled,
        needs_color: false,
        color_options: [],
      };
      const draft = { ...task.draft, items };
      await this.store.update(draftId, { draft, status: 'ready_to_confirm' });
      await this.publishSalesResultCard({ ...task, draft }, event, salesConfirmationCard(draftId, draft),
        { stage: 'color_chosen', interactionId: context.interactionId });
      logInfo('lark.sales.color.chosen', { task_id: draftId, item_index: itemIndex,
        product_record_id: value.record_id, color: value.color_name });
      return { toast: { type: 'success', content: `第 ${itemIndex + 1} 双的颜色已设为「${value.color_name || ''}」` } };
    }

    // 颜色是入账的必要信息：还有明细没选颜色就不许确认。卡片上会给出候选让用户点选。
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      (task.draft?.items || []).some((item) => item.needs_color)) {
      return { toast: { type: 'warning', content: '还有明细没选颜色，请先在卡片上选择颜色，再确认订单' } };
    }
    // 卖的是样品时同样要先选完"用哪个门盒补"，否则确认后还得再来一次。
    // 跟颜色用同一条规矩：卡片上的必选项没定，不入账。
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      (task.draft?.items || []).some((item) => item.needs_sample_replacement && !item.sample_replacement_size)) {
      return { toast: { type: 'warning', content: '这一单里有样品要补，请先在卡片上选补哪个门盒，再确认' } };
    }

    await this.store.update(draftId, { status: 'posting',
      ...(task.type === 'sale' ? { posting_requested_action: hasWrittenSaleRecords
        ? task.posting_requested_action || action : action } : {}) });
    try {
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
      // 交付与否由**交易类型**决定，不由用户点哪个按钮决定。
      // 卡片上只留一个「确认」；旧卡片上的 confirm_sale_delivered / _pending 仍然兼容。
      const shouldDeliver = shouldDeliverFor(task, action);
      // ⭐ 2026-10-07：交付是**逐明细行**的事（业务负责人：「在销售明细里面分开」）——
      //   现货的行要交付并扣库存，**预定（没货）的行不交付**。
      //   `shouldDeliver` 仍然决定"整单要不要走交付这一段"（纯预付单一次都不调用，
      //   与改动前逐字相同），具体交付哪几条由下面的 `deliverableDetailIds` 挑出来。
      const deliverableItemIndexes = deliverableItemIndexesOfDraft(task.draft, shouldDeliver);
      // 交付结果那句话（全交付 / 全未交付 / **部分交付**）—— 文案在 config/salesDeliverySummary。
      const deliverySummary = deliverySummaryOfDraft(task.draft, shouldDeliver);
      // ⭐ 她**点了「确认」**这件事要**立刻在卡片上看得出来**（业务负责人 2026-10-07 拍板的 ⓐ）：
      //   标题换成醒目的「处理中/正在写入」＋ 明细区变灰 ＋ 一行"正在写入"提示
      //   （文案与颜色全在 `config/salesProcessingCard`）。
      //   ⚠️ 只换"显示"：`stage` 仍是 `processing`（日志与既有测试依赖它），
      //      状态写入 / postSale / 明细 / 收款 / 库存在这条链路上**一个字节都没动**。
      //   ⚠️ 终态卡（`posted`）与取消 / 待修正 / 部分交付卡片仍走 `salesStatusCard`，**逐字不变**。
      const cardUpdated = await this.updateSalesActionCard(task, event,
        salesProcessingCard(task.draft, resolveSalesProcessingCardConfig()),
        { stage: 'processing', interactionId: context.interactionId });
      if (!cardUpdated) await this.sendTaskText(task, '已收到确认，正在写入销售记录和收款，请稍候。').catch((error) =>
        logWarn('lark.sales.feedback.failed', { task_id: draftId, interaction_id: context.interactionId, error: error.message }));
      // ⭐ 她**点了「确认」**这件事本身要落表（今天完全没有这一笔）：
      //   「确认状态」= 已确认。放在入账**之前**写，是因为她点过是既成事实——
      //   后面入账成功与否由「资金状态」表达，不该把她的动作也一起抹掉。
      //   写失败只记警告（SalesStatusWriter 不抛），不能因为记进度挡住入账。
      // ⭐ 关联键（2026-10-07 业务负责人拍板「日志改下吧！」）：
      //   从这里开始，整条写入链（主表状态 → 销售明细 → 收款明细 → 库存流水 → 实时库存）
      //   的日志都带同一个 `task_id` ＋ `sales_entry_record_id`（单号由下游读过主表后补上）。
      //   ⚠️ 它只是**这次调用显式传下去的普通对象**，不落在任何 service 实例上
      //      （那些 service 都是启动时构造的单例，放实例上会跨请求串台）。
      //   ⚠️ 只是为了"能串起来"，不改任何写入内容与顺序。
      const correlation = { task_id: draftId, sales_entry_record_id: task.sales_entry_record_id };
      // ⭐ 主表「交易类型」在这里**再同步一次**：多颜色那一条的类型是"选完颜色、查完库存"
      //   才定下来的，录单那一次写不到它（详见 `syncSalesTradeTypes` 的注释）。
      //   ⚠️ 只是审计字段：解析不到只记 warn，绝不因此挡住入账。
      await this.syncSalesTradeTypes({
        salesEntryRecordId: task.sales_entry_record_id, items: task.draft.items || [], taskId: draftId,
      });
      await this.salesStatus.write(task.sales_entry_record_id, { userAction: WRITE.userAction.confirmed },
        correlation);
      const startedAt = Date.now();
      const result = await this.posting.postSale({
        salesEntryRecordId: task.sales_entry_record_id,
        knownRecordIds: task.posting_record_ids,
        knownFinancialComplete: task.posting_records_written === true,
        onRecordPersisted: async (kind, index, recordId) => {
          const current = await this.store.get(draftId);
          const ids = { ...(current?.posting_record_ids || {}) };
          const kindIds = [...(ids[kind] || [])];
          kindIds[index] = recordId;
          await this.store.update(draftId, { posting_record_ids: { ...ids, [kind]: kindIds } });
        },
        operatorOpenId,
        paymentMethod: task.draft.payment_method,
        totalPaid: task.draft.total_paid,
        // 她明说的欠款金额（没提欠就是空）：入账服务只有拿到它才会补未收款，
        // 所以这里必须原样透传，不能自己用"成交 − 已收"算一个出来。
        owed: task.draft.owed,
        payments: (task.draft.payments || []).map((payment) => ({
          amount: payment.amount, method: payment.method, status: payment.status, operatorOpenId,
        })),
        items: task.draft.items.map((item) => ({
          kind: item.kind,
          productRecordId: item.product_record_id,
          accessoryRecordId: item.accessory_record_id,
          itemNo: item.item_no,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
          actualAmount: item.actual_amount,
          gift: item.gift,
          giftDescription: item.gift_description,
          // ⭐ 每一行的交易类型编码 → 入账层据此把**这一行自己的**类型写进
          //   「销售明细.交易类型」（单选关联）。它不是关联键、不进日志，是业务字段。
          //   ⚠️ 缺省是空串 → 入账层退回"读主表第一条"，既有调用点行为逐字不变。
          tradeTypeCode: itemTradeTypeCode(item, task.draft.trade_type_code),
        })),
      }, { correlation });
      await this.store.update(draftId, { status: 'posted_delivery_pending', posting_result: result });
      // ⭐ 只把**要交付的那几行**的明细 id 交给交付服务（预付行不交付、不扣库存）。
      //   明细 id 的顺序与 `items` 一一对应（入账层按同一个顺序建行），所以按下标取。
      const deliverableDetailIds = deliverableItemIndexes
        .map((index) => result.detailRecordIds?.[index])
        .filter(Boolean);
      if (shouldDeliver && deliverableDetailIds.length) {
        try {
          const deliveryResult = await this.delivery.deliver({ salesEntryRecordId: task.sales_entry_record_id,
            detailRecordIds: deliverableDetailIds, paymentRecordIds: result.paymentRecordIds },
          { correlation });
          // 卡片上已经选好"用哪个门盒补样品"的，在这里直接补掉，不再为它另发一张卡片。
          // 补失败不阻断入账：库存已经扣了，补样品失败只影响展示样品，交给工作台处理。
          const handledSampleDetails = await this.applyChosenSampleReplacements(task, result, { correlation })
            .catch((error) => {
              logWarn('lark.sales.sample_replacement.apply_failed', { task_id: draftId, error: error.message });
              return new Set();
            });
          await this.notifySampleReplacements(deliveryResult, operatorOpenId, {
            handledDetailIds: handledSampleDetails,
            // ⭐ 渠道感知：**群销售**的补样品提醒回到**那条销售话题**（不是另开一条私聊）。
            //   非群任务 → `null` → 补样品提醒没有群上下文 = **没有去处**，只记一条 skip。
            channelTask: task.chat_type === 'group' ? task : null,
          }).catch((error) =>
            logWarn('lark.sales.sample_notice.failed', { task_id: draftId, error: error.message }));
          if (deliveryResult.failures?.length) {
            await this.store.update(draftId, { delivery_failures: deliveryResult.failures });
            const failedLines = deliveryResult.failures.map((failure) => {
              const item = task.draft.items[failure.lineNumber - 1] || {};
              const label = `${item.product_number || `${item.item_no || '货品'}${item.color || ''}`}${failure.size}码`;
              return `第${failure.lineNumber}双 ${label}：${failure.error}`;
            }).join('；');
            // ⭐ 2026-10-07：这一支也是**已入账**（钱与明细都写了，只是货没交齐）⇒ 同样带上补货品信息。
            await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
              deliveryResult.deliveredQuantity ? '订单已入账，部分交付' : '订单已入账，交付待处理',
              `销售单号：${result.sourceNo}。已交付 ${deliveryResult.deliveredQuantity}/${deliveryResult.totalQuantity} 双；未交付：${failedLines}。请到工作台待交付列表核对并处理。`, 'orange',
              { productInfoGaps: true }),
            { stage: 'delivery_partial', interactionId: context.interactionId });
            logWarn('lark.sales.delivery.partial', { task_id: draftId, source_no: result.sourceNo,
              delivered_quantity: deliveryResult.deliveredQuantity, total_quantity: deliveryResult.totalQuantity,
              failed_detail_ids: deliveryResult.failures.map((failure) => failure.detailRecordId) });
            return { toast: { type: 'warning', content:
              `订单已入账，已交付 ${deliveryResult.deliveredQuantity}/${deliveryResult.totalQuantity} 双；其余待处理` } };
          }
        } catch (error) {
          // ⭐ 2026-10-07：同上 —— 已入账（失败的是**交付**，不是入账）⇒ 带上补货品信息。
          await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
            '订单已入账，交付待处理', `销售单号：${result.sourceNo}。库存交付未完成：${error.message}。请在工作台待交付列表核对并处理。`, 'orange',
            { productInfoGaps: true }),
          { stage: 'delivery_failed', interactionId: context.interactionId });
          logError('lark.sales.delivery.failed', { task_id: draftId, error: error.message });
          return { toast: { type: 'warning', content: '订单已入账，库存交付待处理' } };
        }
      }
      await this.store.update(draftId, { status: 'posted', posting_result: result });
      // ⭐⭐ 本次改动的关键一张：**已入账终态卡会长期留着**，是她回来补资料的入口。
      //   缺口来自 `task.draft.product_info_gaps`（卖单解析时**已经**读过一次「货品信息」表），
      //   这里**不重新读表**。
      await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
        '销售订单已入账', `销售单号：${result.sourceNo}；${result.detailRecordIds?.length || 0} 条明细已写入。${deliverySummary.card}`, 'green',
        { productInfoGaps: true }),
      { stage: 'posted', interactionId: context.interactionId });
      logInfo('lark.sales.posting.completed', {
        task_id: draftId,
        source_no: result.sourceNo,
        detail_count: result.detailRecordIds?.length || 0,
        duration_ms: Date.now() - startedAt,
        result: 'posted',
      });
      return {
        toast: {
          type: 'success',
          content: deliverySummary.toast,
        },
      };
    }

    throw new Error(`不支持的卡片动作: ${action}`);
    } catch (error) {
      // Posting services are idempotent. Restore the draft so a corrected configuration or
      // transient Feishu failure can be retried from the same card instead of staying stuck.
      const waitingForSync = error.saleRecordsWritten === true || task.posting_records_written === true;
      await this.store
        .update(draftId, { status: 'ready_to_confirm', posting_error: error.message,
          posting_records_written: waitingForSync })
        .catch(() => undefined);
      if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
        const retryCard = salesConfirmationCard(draftId, task.draft);
        const reason = isDataNotReady(error) ? '飞书数据暂未就绪' : error.message;
        const current = await this.store.get(draftId);
        const hasWrittenRecords = waitingForSync || Object.values(current?.posting_record_ids || {})
          .some((ids) => Array.isArray(ids) && ids.some(Boolean));
        if (hasWrittenRecords) {
          // 重试卡片只留"继续处理这一单"那一个按钮。旧卡片上的交付动作名
          // （confirm_sale_delivered / _pending）现在统一对应新的「确认」。
          const requestedAction = current?.posting_requested_action || action;
          const retryAction = ['confirm_sale_delivered', 'confirm_sale_pending'].includes(requestedAction)
            ? 'confirm_sale' : requestedAction;
          // 卡片按钮已从 `action` 换成 `column_set`（移动端实测，见 larkCards.buttonColumns 的注释），
          // 所以不能再按 tag === 'action' 找按钮；收窄规则不变，交给 larkCards 里的结构遍历。
          keepOnlyCardButton(retryCard, retryAction);
        }
        retryCard.elements.splice(1, 0, { tag: 'note', elements: [
          { tag: 'plain_text', content: waitingForSync
            ? `销售明细和收款已记录，但进度同步尚未完成，库存未扣。${reason}；请稍后在原卡片重试，不要重新发送销售。`
            : `入账失败；可能已有部分记录，库存未扣。${reason}；请核对后在原卡片重试，不要重新发送销售。` },
        ] });
        await this.publishSalesResultCard(task, event, retryCard,
          { stage: 'retryable', interactionId: context.interactionId });
        logError('lark.sales.posting.retryable', { task_id: draftId,
          records_written: waitingForSync, error: error.message });
        return { toast: { type: 'warning', content: waitingForSync
          ? '销售记录已写入，进度待同步；库存未扣，请稍后在原卡片重试'
          : '销售尚未完成，请核对原卡片后重试；不要重新发送销售' } };
      }
      throw error;
    }
  }

  async handleTaskFailure(taskId, error) {
    const task = await this.store.get(taskId);
    if (task) {
      await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
      await this.sendTaskText(task, `处理失败：${error.message}`).catch(() => undefined);
    }
    logError('lark.mvp.task.failed', { task_id: taskId, error: error.message });
  }
}

module.exports = {
  LarkMvpService,
  aggregateRecognizedItems,
  idFor,
  looksLikeSalesText,
  parseContent,
};
