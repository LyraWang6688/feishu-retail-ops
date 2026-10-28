const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
// 🔴 2026-10-16：「与 AI 分析有关的都停掉」⇒ `require('./doubaoService')`（文字解析层）已删。
//    它是本类**唯一**的模型接线（`this.recognizer`），而 recognizer 的两个去处
//    （`purchaseWebhooks` / `arrivalConversation`）**都不再有人读它**。
//    依据=业务负责人 2026-10-16 逐字「**连代码一起删**」；她在**扫码 / 表单 / 前端 UI** 之外
//    的录入方式「**其余录入方式不支持**」。详见 `docs/ai-parsing-removal-2026-10-16.md`。
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
// ⛔ 2026-10-28：`KeyedSerialQueue` 随 `this.cardActionQueue`（卡片动作串行队列）一起摘掉。
const { updateInteractiveCard } = require('../infrastructure/interactiveCardFeedback');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1PostingService } = require('./v1PostingService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SecondDeliveryService } = require('./secondDeliveryService');
const { SampleReplacementService } = require('./sampleReplacementService');
const { PurchaseWebhookService } = require('./purchaseWebhookService');
// 「货品信息.标签二维码」：表变更事件（新增 / 编号变更）→ 自动生成二维码并写回那一列。
// 独立 service（一个 service 只干一件事），这里只负责把它接上（见构造函数）。
const { createTagQrCodeService } = require('./tagQrCodeService');
const { TAG_QR_CODE } = require('../config/tagQrCode');
// `normalizeText`：新增的「货号有没有建档」判据必须与解析 A 用**同一套**货号归一
// （大小写 / 空格 / 分隔符），否则会出现「A 认得出来、判据说没有」这种自相矛盾。
// ⚠️ 2026-10-11（清群聊入口 C0）：`person` 随 `createSalesEntryWithOrderNo` 一起搬去
//    `services/salesEntryService.js`（本文件不再直接用它）。
const { V1ReferenceResolver, relation, normalizeText, normalizeColor } = require('./v1ReferenceResolver');
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
// ⚠️ 2026-10-11（清群聊入口 C0）：`withSalesReadRetry` 随 `listSalesOrderNos` 一起搬去
//    `services/salesEntryService.js`（本文件不再直接用它）。
const { isDataNotReady } = require('./salesReadRetry');
// ⚠️ 2026-10-11（清群聊入口 C0）：`allocateSalesOrderNo` 随 `createSalesEntryWithOrderNo`
//    一起搬去 `services/salesEntryService.js`（本文件不再直接用它）。
const { resolveAccessory } = require('./accessoryMatchPolicy');
const { AfterSalesService } = require('./afterSalesService');
// 🔴 2026-10-16（「与 AI 分析有关的都停掉」）：这里原先还有三行 import ——
//    `config/salesMissingInfoText` 的 `renderSalesMissingInfo`、
//    `config/saleIntents` 的 `isAfterSalesIntent` / `normalizeMessageIntent`、
//    `config/messageGate` 的 `isSalesCandidate` / `UNSUPPORTED_INTENT_REPLY`
//    —— 它们的调用方是**销售文字录单那条链路**（`acceptSalesText` / `processSalesTask`），
//       而那条链路 **2026-10-12 清群聊入口时就已整体退场**（方法本身都不在了）
//       ⇒ 这三行 import 从那天起就是**孤儿**，随这次删除一起清掉。
//    依据=业务负责人 2026-10-16 逐字：「**都停掉，与 AI 分析有关的都停掉**……**其余录入方式不支持**」
//    ＋「**连代码一起删**」。详见 `docs/ai-parsing-removal-2026-10-16.md`。
// ⛔ 2026-10-28：原来这里还有四组 import —— 它们只服务**交互卡片动作**那条链路：
//   · `config/unknownCardAction`（未知动作的兜底人话）
//   · `utils/larkCards` 的 `salesStatusCard` / `keepOnlyCardButton` / `SECOND_DELIVERY_ACTION`
//   · `config/salesConfirmDeal`（【确认成交】按钮的动作名 / 判据 / 文案）
//   · `config/salesProgressIntake` 的 `PROGRESS_KINDS`
//   业务负责人现行口径：「现在没有群聊入口，也没有旧卡片」⇒ 卡片动作入口
//   （`handleCardAction` 及下面那一串卡片专用方法）**整体删除**，这些 import 一并摘掉。
//   ⚠️ 恢复卡片链路 = 重新实现（不是翻开关）。
const { extractSalesMessageText, isMentioned, stripMentionPlaceholders } = require('../utils/larkMessageText');
const { resolveAckReaction } = require('../config/groupPurchase');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');
const { extractBatchNos } = require('./purchaseBatchNo');
// 「群话题 ↔ 销售记录」的本地路由映射（只写本地，不写业务表，见服务的注释）。
const { SalesGroupThreadLocator } = require('./salesGroupThreadLocator');
// 「消息深链存哪儿」的唯一落点（本地映射 + 销售主表「消息链接」列，见服务的注释）。
const { SalesMessageLinkService } = require('./salesMessageLinkService');
// 「话题里的二次处理识别」（②：预定 / 现货待收的进展同步）——⚠️ 2026-10-28：
//   独立 service（`services/salesThreadProgressService.js`）与它的配置
//   （`config/salesProgressIntake.js`）**整文件删除**：它只服务群话题那条入口，
//   而群聊入口 2026-10-12 就退场了（`acceptMessage` 收到即静默拒绝）。
//   卡片上那个「成交」按钮（唯一还剩的调用方 `handleConfirmDealAction`）也在本次删除。
// 「采购到货：群话题对话式核对」的编排（独立 service；本类只做接线）。
const { PurchaseArrivalConversationService } = require('./purchaseArrivalConversationService');
// ⛔ 2026-10-28：`config/arrivalConversation` 的 `ARRIVAL_CONVERSATION_ACTIONS`（到货核对卡片上的
//   「是」）随卡片动作入口一起摘掉；到货验收的现行入口是**工作台发起 + 扫码录入**
//   （`PurchaseArrivalConversationService.confirmBatchArrival`）。
// ⛔ 2026-10-28：`config/voucherSettlement` 的「确认到账」动作名随 9 点推送删除 ——
//   那条推送（【团购券待结算】区块）与它的「确认到账」按钮一起退场。
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

// 🔴 2026-10-16：这里原先有 `looksLikeSalesText = (text) => isSalesCandidate(text)`
//    （消息入口闸门：含数字 / 含业务关键词才送进 AI）。它是**销售文字录单入口的闸门**，
//    而那条入口 2026-10-12 已退场 ⇒ 它随 `config/messageGate` 一起删除。
//    依据=她 2026-10-16 逐字「**都停掉，与 AI 分析有关的都停掉**」「**连代码一起删**」。
//    ⚠️ 它的旧判据**迁到了** `test/aiParsingRemoval.test.js` 的 AC-2/AC-3（反向钉"塞回即红"）✓


// 🔴 2026-10-07「私聊链路移除」：原来的 `shanghaiDay(now)` 只有 `sendTodaySales`（机器人菜单
//    「今日销售」，只有私聊点得到）在用，随它一起删了。上海自然日的算法仍在
//    `services/v1WorkbenchService` 里（工作台「今日销售」用它），要看今日销售去那儿。

// ═══════════════════════════════════════════════════════════════════════════
// 🧹 2026-10-28（本轮清理）：本类的两个**旧入口**都已退场 ——
//   · `handleCardAction`（飞书交互卡片的按钮回调）—— 2026-10-28 整体删除：
//     群销售确认卡 / 成交提醒卡 / 到货核对卡 / 团购券「确认到账」卡都随各自链路退场，
//     线上已经没有任何会带按钮的卡片（业务负责人：「现在没有群聊入口，也没有旧卡片」）。
//   · `acceptMessage` 里的**群聊分支**—— 2026-10-12 起就是「收到即静默拒绝」的守卫，
//     **本轮保留**（`reason: 'group_chat_removed'`，不建任务、不进 AI、不读表、不写表、不回话）。
//
// 连带删除的卡片专用方法（本次一并退场，别再加回来）：
//   `unknownCardAction` / `handleSecondDeliveryAction` / `confirmDealOptionFor` /
//   `handleConfirmDealAction` / `confirmDealSummary` / `confirmDealUndeliveredCount` /
//   `settleConfirmDealCard`。
//
// ⚠️ 仍然保留的**出站**能力（工作台 / 补样品提醒在用，与群入口无关）：
//   `sendTaskText` / `sendTaskCard` / `replyTaskCard` 与 `bindGroupSaleThread`
//   （没有群上下文的任务照旧只记一条 `lark.private_chat.send_skipped`、返 `null`）。
// ═══════════════════════════════════════════════════════════════════════════

class LarkMvpService {
  constructor(options = {}) {
    if (options.client) this.client = options.client;
    else {
      const { appId, appSecret } = getLarkAgentCredentials();
      this.client = new lark.Client({ appId, appSecret, logger: larkLogger });
    }
    this.gateway = options.gateway || new V1BitableGateway({ client: this.client });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    // 🔴 2026-10-16：`this.recognizer = options.recognizer || doubaoService` 已删。
    //    它原先只被**往下传**（`purchaseWebhooks` / `arrivalConversation`），
    //    而那两个收方对它的使用**都随各自的 AI 解析入口退场了**（采购 2026-10-09、
    //    到货对话 2026-10-12）⇒ 本类现在**不持有、也不传**任何模型。
    //    依据=她 2026-10-16 逐字「**都停掉，与 AI 分析有关的都停掉**」。
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
      // 🔴 2026-10-16：`recognizer` 不再传 —— `PurchaseWebhookService` 自 2026-10-09 起
      //    就**不读**这个选项了（它唯一的调用方 `parseReportQuantities` 已随入口退场），
      //    传一个没人读的模型进来只会让人以为"采购还在用 AI" ✗
    });
    // 「货品信息.标签二维码」的自动补齐（2026-10-08 业务负责人定的能力）。
    // ⚠️ 只**新增**这一个成员：上面报货那条链路（`purchaseWebhooks`）一行都没动。
    // 入口在 `routes/larkEvents.js` 的 `drive.file.bitable_record_changed_v1` 分支里，
    // 按 **table_id** 分派（货品信息走这里，报货表走上面那个）——两条路互不影响。
    this.tagQrCodes = options.tagQrCodes || createTagQrCodeService({
      gateway: this.gateway,
      config: TAG_QR_CODE,
    });
    this.store =
      options.store ||
      new JsonTaskStore({ dir: path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id' });
    // 退换货第二期：售后**编排**（定位 → 组装方案 → 确认卡片 → 调执行器）也是独立 service。
    // 本类只留"意图 → 分派"的接线：
    //   · 定位复用第一期的只读 SaleLookupService（同上一个实例，共享任务状态）；
    //   · 写入复用第二期第一步的 AfterSalesService 执行器（幂等由它自己负责）；
    //   · 卡片渲染在 utils/larkCards，本类不拼卡片内容。
    // 执行器用自己的任务存储（data/after_sales_operations），所以这里不能把销售的任务存储传给它。
    this.afterSales = options.afterSales || new AfterSalesService({ gateway: this.gateway });
    this.sampleReplacements = options.sampleReplacements || new SampleReplacementService({
      gateway: this.gateway, inventory: this.delivery.inventory, store: this.store, client: this.client,
      updateCard: (task, event, card, metadata) => this.updateSalesActionCard(task, event, card, metadata),
      // ⭐ 渠道感知的两个出口（接线方式与补样品那条**完全一致**，见 PR #148）：
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
    // ⛔ 2026-10-28：`this.cardActionQueue`（卡片动作的串行队列）随 `handleCardAction` 一起删除。
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
    // 「这条话题 ↔ 这笔销售」的**本地**路由映射的唯一落点（业务负责人 2026-10-06 要的）。
    // ⚠️ 它同时算/存话题深链，但**只存本地**：原来还往销售主表「消息链接」列写一份，
    //    那一列 + 那个写入点已在 2026-10-09 随"扫码时代不要这几列了"一起删掉
    //    （见 `salesMessageLinkService` 与 `config/v1BitableSchema.salesEntry` 段）。
    //    链接只可能在**发送响应**里出现（实测当前不回带），所以它挂在"我们发卡片/文字的那一刻"上。
    this.salesMessageLinks = options.salesMessageLinks || new SalesMessageLinkService({
      locator: this.salesGroupThreads,
    });
    // ⚠️ 2026-10-12（清群聊入口 C3）：这里原先解析两个**只服务群准入**的东西 ——
    //    `this.botOpenId`（判"群里有没有 @ 机器人"，`config/groupPurchase` 的 `LARK_BOT_OPEN_ID`）
    //    与 `this.mainChatRequireMention`（`config/groupAdmission` 的显式布尔开关）。
    //    群入口已退场 ⇒ 两样一起删除，`config/groupAdmission.js` 随之整文件删除
    //    （它没有任何其它读取点），`LARK_BOT_OPEN_ID` 这个环境变量也不再有读取点。
    // ⛔ 2026-10-28：`this._pendingDealPush` / `this.voucherSettlementSettings` 已删除 ——
    //   它们只服务 9 点推送【团购券待结算】卡片的「确认到账」按钮（推送已整体退场）。
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
      // 🔴 2026-10-16：`recognizer` 不再传（"群话题对话式核对"的**解析**那一半已删，
      //    这个 service 现在只保留**确认**那一半：`confirmLocked` / `confirmBatchArrival`）。
      //    依据=她 2026-10-16 逐字「**都停掉，与 AI 分析有关的都停掉**」。
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
      // ⭐⭐ 2026-10-08（业务负责人逐条批准）：采购侧**统一改用销售那条共享实现**
      //    `updateInteractiveCard`（`infrastructure/interactiveCardFeedback.js`）——
      //    与销售确认卡是同一条出口，于是自动获得它两件事：
      //      ① **id 优先 + 失败告警**（失败打 `purchase.card.update.failed`，不再是吞异常的自研 patch）；
      //      ② 到货核对那边的 `safeUpdateCard` 只看返回值 ⇒ 现在"改没改成"是可信的（false = 真没改成）。
      //    ⚠️ 这里的 `messageId` 是**调用方明确传进来的那条消息**（她要 patch 的那张卡），
      //       所以用 `event.context.open_message_id` 把它交进去 —— 正是共享实现"id 优先"的口径。
      //    ⚠️ 刻意**不复用**销售那个 `updateSalesActionCard`：它按 `task.type` 选日志前缀、
      //       并且会去读 `task.card_message_id`；采购这条没有销售任务，只有明确的 message_id。
      //       共享的是**实现**（`updateInteractiveCard`），不是那层按任务分流的包装。
      updateCard: (messageId, card) => updateInteractiveCard({
        client: this.client,
        task: null,
        event: { context: { open_message_id: String(messageId || '') } },
        card,
        stage: 'purchase_arrival_card',
        eventPrefix: 'purchase.card.update',
      }),
      // ⭐ 2026-10-07 晚：更新任何"已经存在的消息"之前先读一眼它是什么（只读，
      //   `im.v1.message.get`）。`patch` 对非卡片消息可能回 `code 0` 却什么都没改
      //   —— 真机 23:37「日志说卡片已更新、她那边一张都没有」就是这么来的。
      getMessageMeta: (messageId) => this.getMessageMeta(messageId),
    });
    // ⚠️⚠️ 2026-10-12（清群聊入口 C2）：这里原先 new 的**群采购入站**分派 service
    //    （按 thread_id / parent_id / 正文批次号定位是哪一批 → 到货核对）**整块删除**。
    //    业务负责人 2026-10-12 逐字：「到货差异的链路群聊链路不用管了；验收是在工作台页面上，
    //    用户选报货批次里未到货状态的报货号之后点【验收】，然后扫描二维码」。
    //    ✅ **保留 `this.purchaseBatchLocator`**（下面几行仍在建）：它的**出站**查询
    //       `listGroupMessages` 还在给**9 点推送**的采购区拼深链
    //       （`pendingPushCandidateService` → `purchasePendingBatchService`），
    //       而 `PurchaseWebhookService.deliverSupplierImages` 仍会 `rememberGroupMessage` 写映射。
    // ⚠️⚠️ 2026-10-12（清群聊入口 C3）：这里原先 new 的**群销售入站**分派 service
    //    （这条群消息归销售还是采购、是哪一笔销售）**整块删除** ——
    //    它唯一的消费者是群入口（已退场）⇒ services/salesGroupFlowService.js 整文件删除。
    // ⛔ 2026-10-28：`this.threadProgress`（`SalesThreadProgressService` —— 群话题里的
    //   「二次处理识别」：她说「已完毕 / 成交」/「收到钱了」时同步进展）**整块删除**。
    //   它唯一的入口是群话题消息，而群聊入口 2026-10-12 已退场（`acceptMessage` 收到即静默拒绝）；
    //   卡片上「成交」按钮那条路（`handleConfirmDealAction` → `completeDealFromCard`）也在本次删除。
    //   ⚠️ 成交的**唯一实现**（`SecondDeliveryService.confirm`）没动，工作台的
    //     「二次交付（收尾款 + 交付）」照旧调它（`routes/workbenchOrderActions.js`）。
  }
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
   * ⭐ 只读一眼**一条已经存在的消息**是什么（`im.v1.message.get`）。
   *
   * 为什么需要它（真机 2026-10-07 23:37）：`im.v1.message.patch` 的官方文档写明
   * 路径参数 `message_id` "**仅支持更新卡片（消息类型为 `interactive`）**"，
   * 可它的错误码表里**没有**"目标不是卡片"这一条（只有 230001 参数错 / 230011 已撤回 /
   * 230031 超 14 天 / 230110 已删除 / 230027 无权限…）⇒ 对一条文字/图片消息，
   * patch 完全可能回 `code 0` 却什么都没改。所以"能不能安全地 patch 它"这件事
   * **必须靠读一次事实**，不能靠猜（`purchaseArrivalConversationService.retirePreviousCard` 用的就是它）。
   *
   * 交付的字段：`msgType`（`interactive` 才是卡片）· `deleted`（撤回）·
   * `updated`（这条消息被更新过没有）· `threadId`（它落在哪个话题）· `updateTime`。
   *
   * ⚠️ **本方法永不抛**：没接线 / 缺权限 / 网络抖动一律返 `{ ok: false, reason }`，
   *    调用方据此"拿不准就不动手"，**绝不影响**任何业务事实。
   * ⚠️ 它是**读**接口（`im:message:readonly` / `im:message` 都能调）；
   *    项目里已有别处在生产调它（`larkMessageLinkResolver` 的 `im.message.get` 实测 `code = 0`）。
   */
  async getMessageMeta(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return { ok: false, reason: 'no_message_id' };
    const get = this.client.im?.v1?.message?.get || this.client.im?.message?.get;
    if (!get) return { ok: false, reason: 'sdk_missing' };
    try {
      const response = await get.call(this.client.im?.v1?.message || this.client.im.message, {
        path: { message_id: id },
      });
      if (response.code !== 0) {
        return { ok: false, reason: `code_${response.code}`, error: response.msg || '' };
      }
      // 合并转发（merge_forward）也走这个接口，此时 `items` 里还有 N 条子消息 ——
      // 取第一条（也就是被查的那条本身）即可。
      const item = response.data?.items?.[0];
      // `code 0` 但一条都没回 = **没读到它是什么** ⇒ 如实报"读不到"（调用方据此不动手）。
      if (!item) return { ok: false, reason: 'items_missing' };
      return {
        ok: true,
        msgType: item.msg_type || '',
        deleted: Boolean(item.deleted),
        updated: Boolean(item.updated),
        threadId: item.thread_id || '',
        updateTime: item.update_time || '',
      };
    } catch (error) {
      return { ok: false, reason: 'call_failed', error: error.message };
    }
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
    // ⚠️ 文字这条出口**只补本地路由映射** —— 两条理由：
    //   ① 深链是**话题级**的（URL 里只有 chat_id + thread_id，没有 message_id）：同一话题里
    //      不管哪条回复拼出来都是同一条，卖卡片那条出口（sendTaskCard）已经记过了，再记是空转；
    //   ② 这条出口里混着"**不猜、不写业务表**"的路径（例：多笔未收款占位 / 金额对不上时
    //      回一句「有多条待收款，请先人工核对」）——业务表的写入**绝不能搭在它上面**，
    //      否则"一个字都不写"这条保证会被一个不相干的副作用破掉。
    //   ⭐ 2026-10-09：销售主表「消息链接」那一列已被她删掉、**写入点整体删除**
    //      （见 `salesMessageLinkService` / `v1BitableSchema.salesEntry` 段）——
    //      于是"写表/不写表"这个开关本身没有了，两条出口现在都只记本地映射
    //      （本地映射是「话题 ↔ 这笔销售」的路由，本来就必须记）。
    await this.bindGroupSaleThread(task, sent);
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
   * 记下「这条话题 ↔ 这笔销售」的**本地**路由映射（`data/sales_group_threads/`）。
   *
   * 时机就是"我们第一条回复发出去之后"：`reply_in_thread` 的响应里才带 thread_id
   * （普通群里这个话题是**我们这条回复**创建的）。`message_app_link` 一旦飞书回带，就只有
   * "发出去的那一刻"能拿到（实测 2026-10-06：这个应用当前**根本不回带**，见
   * docs/reports/group-message-deep-link-2026-10-06.md 的实测四）——所以这里是唯一的落点。
   * 失败只告警——它只影响"她后面在这个话题里说话能不能被认出来"，
   * 绝不能因此把已经发出去的卡片判失败。
   *
   * ⚠️ 2026-10-09：原来这里还有一个 `storeLink` 开关（要不要顺手写销售主表「消息链接」列）——
   *    那一列已被业务负责人删除、**写入点整体下线** ⇒ 开关删掉。
   *    **本地路由映射仍然是任何情况都记**（「9 点推送」里那句「查看原话」的深链读的就是它，
   *    与业务表那一列无关）：功能没死，只是不再往业务表写。
   */
  async bindGroupSaleThread(task, sent = {}) {
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
      });
      return result.record;
    } catch (error) {
      logWarn('sales.group.thread.remember_failed', { task_id: task.task_id, error: error.message });
      return null;
    }
  }
  async acceptMessage(event) {
    const message = event?.message;
    const senderOpenId = event?.sender?.sender_id?.open_id;
    if (!message?.message_id || !senderOpenId) return { accepted: false, reason: 'missing_identity' };

    // ⚠️⚠️ 2026-10-12（清群聊入口 C3）：**群聊 / 群话题消息不再受理**。
    //    业务负责人的口径：「**清理群聊那个也得做呀**」；
    //    日常录入改走**扫码页**（货品流转的数据录入），查询 / 订单补充 / 售后走**工作台**。
    //    ⇒ 这里**一个远端调用都不发**：不建任务、不进 AI、不读表、不写表、不加表情、不回话。
    //    ⚠️ 刻意**不**回一句「请用扫码页」：群里所有人发的消息都会推给我们，
    //      回话 = 刷屏（这与"主群日常聊天必须静默"是同一条纪律）。
    //    ⚠️ 也**不要**给这里加开关：要恢复群聊入口是**重新实现那条链路**，不是翻一个开关
    //      （与私聊移除时的 ⓐ 口径一致）。
    if (message.chat_type === 'group') {
      logInfo('lark.group.message.disabled', {
        message_id: message.message_id,
        chat_id: message.chat_id,
        message_type: message.message_type,
        thread_id: String(message.thread_id || '').trim(),
        hint: '群聊入口已于 2026-10-12 退场：录入走扫码页，查询/订单补充/售后走工作台',
      });
      return { accepted: false, reason: 'group_chat_removed' };
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
  // ⛔ 2026-10-28：本方法之后原先还有一整段**卡片动作**实现，本轮整体删除 ——
  //   · `get pendingDealPush()` + `handleCardAction()`（含 9 点推送【团购券待结算】「确认到账」、
  //     到货核对「是」、「成交」、「确认成交」、补样品选择这几条分派）
  //   · `unknownCardAction()`（未知动作兜底人话，随卡片入口一起无载体）
  //   · `handleSecondDeliveryAction()` / `confirmDealOptionFor()` / `handleConfirmDealAction()`
  //     / `confirmDealSummary()` / `confirmDealUndeliveredCount()` / `settleConfirmDealCard()`
  //   ⚠️ 依据：业务负责人确认「现在没有群聊入口，也没有旧卡片」「9 点群推送不再需要」；
  //     `routes/larkEvents.js` 的 `card.action.trigger` 也已删除 ⇒ 这些方法没有任何入口。
  //   ⚠️ 恢复 = **重新实现**（卡片渲染器与动作分派都要重建），不是翻一个开关。
}

module.exports = {
  LarkMvpService,
  aggregateRecognizedItems,
  idFor,
  parseContent,
};
