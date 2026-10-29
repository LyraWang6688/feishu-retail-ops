// ⭐ 用户可见文案抽到 config（2026-10-12 技术债批次：只挪位置，一个字符没改）
const { purchaseMessage, purchaseToast, arrivalToast, inventoryToast, returnNotice } = require('../config/purchaseWebhookTexts');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
// ⚠️ 2026-10-07 深夜：`config/purchaseBehaviors`（采购环节的 `PURCHASE_IN`）**随入库行一起退场**——
//    它的唯一消费者就是"入库行的「采购行为」"那一列，而「采购入库」表已被业务负责人整表删除。
//    ⇒ 别再把它 require 回来，也别拿 `inventoryService` 的 `STOCK_PURCHASE_INCREASE` 顶替：
//      那是**库存环节**的另一条行为记录，用错了等于把流水挂到另一条行为上。
// ⛔ `doubaoService`（文字解析：销售录单 ＋ 采购「数量说明」）**已从这里删除（2026-10-09）**：
//   采购那一半（`parsePurchaseReportText`）随「信息填写」入口一起退场；
//   销售录单在 `services/larkMvpService.js` 那一侧用它，与本文件无关。
// 采购申请确认卡片（purchaseRequestConfirmationCard）**已于 2026-10-08 删除**：
// 报单链路 2026-10-07 起就是免确认（`publishPurchaseRequest` 直接调 `confirmPurchaseRequest`），
// 那张卡没有任何发送方、动作也认领不了 —— 业务负责人逐条批准后连卡片、动作常量、
// `handleCardAction` 一起删干净（历史注释见 `purchase/messaging.js` 的 `updatePurchaseActionCard`）。
const { purchaseStatusCard } = require('../utils/larkCards');
// MOVEMENT_PURCHASE_DECREASE 是 #83 采购退货扣库存用的流水类型（退货独占链，见 processSupplierReturn）。
// STOCK_MOVEMENTS 是「库存行为注册表」：退货核对"能退几双"时要数的可退状态
//（= STOCK_PURCHASE_DECREASE 的 consumes：门盒 + 样品 + 仓库）**只从它读**，
// 不在本文件里再抄一份字面量（配置先行，见 AGENTS.md）。
// ⚠️ 2026-10-09：`MOVEMENT_PURCHASE_DECREASE` / `STOCK_MOVEMENTS` 是**采购退货**那条链路
//   （"能退几双"要数的可退状态）用的；退货入口随「信息填写」整表删除一起退场
//   ⇒ 本文件**不再用它们**（`inventoryService` 里那两份定义本身仍有别的读取点，
//      这里只是不再 import）。`InventoryService` 照旧 —— 到货入库还在用它。
const { InventoryService } = require('./inventoryService');
// ⛔ 2026-10-09：「数量说明」解析（`purchaseQuantityPolicy`）与报货/退货归批窗口
//   （`config/reportBatchWindow` / `config/purchaseReturnBatchWindow`）＋读记录重试
//   （`config/reportReadRetry`）**全部随「信息填写」入口一起退场**，本文件不再 import。
//   ⚠️ 「采购行为」分流（`classifyReportBehavior`）**仍在**，但已经不在本文件里用
//   —— 它现在的调用方是 `services/purchaseQueryService`（按「报货信息.采购行为」分流）。
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { renderPurchaseRequestPng } = require('./purchaseRequestImageService');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey, createOnceByKeys } = require('../infrastructure/idempotencyKey');
const { batchQuantityFields } = require('../config/purchaseBatchQuantity');
const { logInfo } = require('../utils/logger');
const { withTimeoutProxy } = require('../utils/withTimeout');
const { getLarkAgentCredentials } = require('../config/larkAgent');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');
// 「报货批次号」的生成器（前缀/日期/位数/时区在 config/purchaseBatchNo）。
// 2026-10-07 业务负责人：报货批次号不再手填，改由后端代码生成。
const { PurchaseBatchNoGenerator } = require('./purchaseBatchNoGenerator');
// 「报货批次」那一行的读写（到货状态 / 单据附件 / 按批次号定位）。
// 抽成独立 service：本类只管"报货 → 出单"，批次行怎么维护不属于它（模块化）。
const { PurchaseOrderBatchService } = require('./purchaseOrderBatchService');
// ⭐ 2026-10-12 采购明细ID（`{报货批次号}-{两位序号}`）—— 分配器只有一处实现。
const { createPurchaseDetailIdAllocator } = require('./purchaseDetailId');
// ⭐⭐ 2026-10-16（业务负责人拍板 **ⓐ**：「同一个报货批次号下**按供应商拆分/分组**」）——
//   分组口径 / 每组幂等键 / "没标注供应商"的桶只在 `config/supplierSplit.js` ＋
//   `services/supplierSplitService.js` 一处（本文件**不抄第二份** ✗）。
//   ⚠️ 它**不认识飞书**（不 require gateway / schema）、**不写表** ⇒ 本类照旧是**唯一**写库的地方。
const { resolveSupplierSplitConfig } = require('../config/supplierSplit');
// ⭐⭐ 2026-10-18（task-6 · 文件大小门禁）：报货 → 出单 → 出图 → 发群 → 到货 的**方法体**
//   原样搬进 `services/purchase/**`；本文件只保留 **facade + 编排 + 兼容导出**。
//   各小模块是"服务对象的 mixin"：facade 保留**同名薄委托**，方法名/签名/`this` 语义逐字不变，
//   模块内部也照旧 `this.xxx(...)`（⇒ 既有用例对 service 打桩依然生效）。
const messaging = require('./purchase/messaging');
const supplierGroups = require('./purchase/supplierGroups');
const documentImages = require('./purchase/documentImages');
const { startPreparedImages } = require('./purchase/preparedImages');
const postingPlan = require('./purchase/postingPlan');
const arrival = require('./purchase/arrival');
const { purchaseCorrelation } = require('./purchase/correlation');
// 「附件单元格 → file_token 列表」的**唯一实现**搬到了 `purchaseOrderBatchService`
//（2026-10-07 附件回填改到「报货批次.单据」，两边都要用同一套解析；
//  这里只是转发导出，保持既有 `module.exports` 形状不变，避免第二份实现慢慢漂移）。
const { attachmentTokens } = require('./purchaseOrderBatchService');


// 🔴 2026-10-08（业务负责人逐条批准）：**采购卡片动作整体退场**。
//   · 2026-10-05 先删了「采购到货」拍照识别链路的 `confirm_purchase_arrival` / `cancel_purchase_arrival`；
//   · 2026-10-08 再删掉最后的两个 —— `confirm_purchase_request` / `cancel_purchase_request`，
//     连同 `purchaseRequestConfirmationCard`（`utils/larkCards`）与这里的
//     `handleCardAction` / `handleCardActionLocked`。
//   为什么可以删干净：报单链路 2026-10-07 起就是**免确认**（`publishPurchaseRequest`
//   直接调 `confirmPurchaseRequest`），那张卡**早就没有任何发送方**；线上若还躺着老卡片，
//   点下去只会落空（不再写任何采购事实）。
//   ⚠️ `confirmPurchaseRequest` / `updatePurchaseActionCard` / `purchaseStatusCard`
//      **保留**：免确认链路（处理中 / 已生成 / 未完成那三张状态卡）还在用它们。

// （`idFor` 那个 hash 小工具已随报单入口删除：它只被 `purchaseTaskId` /
//  `acceptMany` 的包 id 用过，两个调用方都随「信息填写」退场。）


// （`PURCHASE_RETURN_BATCH_KIND` 那个批次类型标记已随采购退货入口删除：
//  它只被退货归批的恢复逻辑读过。）

// （原先这里有个 number() 小工具，只被 confirmArrivalLocked 里那段"算到货状态"的
//  回写用；那段按业务负责人口径删掉后它就没有调用方了，随之删除，不留死代码。）

// （原先这里有个 sleep()，只被已删除的「识别失败态重试写入」用到，随那段一起删掉。）


// ── 已删除：拍照识别那一套 ────────────────────────────────────────────────
// 2026-10-05 业务负责人删掉了「采购到货」表的「类型」「识别状态」「识别失败原因」三个字段，
// 并决定这条链路整体退场（改成纯对话驱动）。随之下线的还有：
//   · processArrival（唯一入口：读记录 → 写「识别中」→ 下载图片 → 视觉识别 → 匹配 → 出卡）
//   · resolveArrivalProduct（逐行匹配货品）
//   · failArrival / markArrivalRecognitionFailed / resolveArrivalOperator
//   · notifyArrival* / startArrivalWaitWatch（等待与提示、判失败、迟到救回）
//   · humanizeArrivalFailure / arrivalFailureNotice / ARRIVAL_RECEIVED_NOTICE（写给已删字段的文案）
//   · 卡片动作 confirm_purchase_arrival / cancel_purchase_arrival
// 删掉而不是留着：它们写的字段在表里已经不存在，留着只会在日志和卡片上
// 伪装成「识别还在跑」，属于最难查的静默失效。
// ⚠️ `sendNoticeText`（#86 曾跟着一起删，合并 #83 采购退货时为差额提示恢复）
// 已于 2026-10-06「私聊切除」时**删除**：那条提示改走 `sendPurchaseGroupNotice` 发采购群
//（业务负责人：「一律在话题群里，以后私聊路线就没有了」）。私聊出口不再需要它。
// 保留下来的入库能力见 confirmArrival 的注释（建档/成本均已随到货单链路删除，2026-10-17）。

/**
 * 退货核对结果 → 一句人话（业务负责人的口径：「把差额明确告诉她」）。
 *
 * ⚠️ 2026-10-07 口径变更（验收标准与逐条对照见
 *    `docs/purchase-return-unified-parsing-2026-10-07.md`）：
 *    退货与报货**共用同一条解析** ⇒ 一条退货记录可以带**多个尺码**（尺码是关联多选），
 *    所以差额也**逐尺码**说（"哪一码差几双"），不再是"一条记录一个尺码"。
 *
 * 只在**对不上**的时候发（差额、或某一码一双都没有）：对得上时图本身就是回执，
 * 再发一条等于刷屏。文案里不出现"实时库存/校验/差额"以外的内部术语，
 * 每一句都给出下一步动作（补数量 / 重新提交一条）。
 *
 * 兼容：`plan.sizes[].quantity`（= 实际退的双数，旧冻结计划的形状）
 * 与新的 `declared / available / taken / shortfall / surplus` 逐项字段都能读。
 */
const buildPurchaseReturnNotice = ({ itemNo, color, plan }) => {
  const label = `${itemNo || ''}${color || ''}`.trim() || returnNotice.unknownItem;
  const sizeText = (size) => (size ? returnNotice.sizeText({ size }) : '');
  // 逐尺码归一化：新计划每一项都带全字段；旧形状（只有 size/quantity）用计划级总数兜底
  //（旧计划永远只有一个尺码，所以"计划级总数"就是"这一项的数"）。
  const entries = (plan?.sizes || []).map((entry) => {
    const declared = Number(entry.declared ?? plan?.declared ?? 0) || 0;
    const taken = Number(entry.taken ?? entry.quantity ?? plan?.taken ?? 0) || 0;
    return {
      size: entry.size,
      declared,
      available: Number(entry.available ?? plan?.available ?? 0) || 0,
      taken,
      shortfall: Number(entry.shortfall ?? Math.max(0, declared - taken)) || 0,
      surplus: Number(entry.surplus ?? 0) || 0,
    };
  });
  const shortfalls = entries.filter((entry) => entry.taken < entry.declared);
  const surpluses = entries.filter((entry) => entry.surplus > 0);
  if (!shortfalls.length && !surpluses.length) return '';
  // 整条记录一双都没退掉（所有尺码都没货）：照既有口径"这一条没处理"，
  // 而不是逐尺码刷一串"差 N 双"。
  if (entries.every((entry) => entry.taken === 0)) {
    const sizeNames = entries.map((entry) => `${entry.size} 码`).join('、');
    return returnNotice.zeroTaken({ label, sizeNames });
  }
  const parts = [
    ...shortfalls.map((entry) => (returnNotice.shortfallLine({ entry, label, sizeText }))),
    ...surpluses.map((entry) => (returnNotice.surplusLine({ entry, label, sizeText }))),
  ];
  return `采购退货：${parts.join('')}`;
};

class PurchaseWebhookService {
  constructor(options = {}) {
    this.client = options.client || (() => {
      const { appId, appSecret } = getLarkAgentCredentials();
      return new lark.Client({ appId, appSecret, logger: larkLogger });
    })();
    // 对外调用的超时（毫秒）。为什么每个都要有：见 utils/withTimeout.js 的文件头。
    // 0 表示不设超时，只有极少数测试会这么用。
    // ⚠️ 到货链路的 mediaTimeoutMs / recognitionTimeoutMs（下载图片、视觉识别）已随
    // 「拍照识别」退场一起删除；剩下的只有发 IM 消息这一个对外调用。
    this.imTimeoutMs = options.imTimeoutMs ?? 15_000; // 飞书消息
    this.gatewayTimeoutMs = options.gatewayTimeoutMs ?? 60_000;
    // 本服务里所有 gateway 调用都套上超时。这里包的是本服务持有的引用，
    // 不影响别的服务（生产上 LarkMvpService 跟销售链路共用的是另一个引用）。
    this.gateway = withTimeoutProxy(options.gateway || new V1BitableGateway({ client: this.client }), {
      timeoutMs: this.gatewayTimeoutMs,
      prefix: 'gateway.',
    });
    // ⭐ 2026-10-12：采购明细ID 的分配器（`{报货批次号}-{两位序号}`，同一批次内不重排/不重号）。
    //    用例可注入一个替身。⚠️ 必须放在 `this.gateway` 赋值**之后**。
    this.detailIds = options.detailIds || createPurchaseDetailIdAllocator({ gateway: this.gateway });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    // 「尺码」是指向「尺码管理」的关联字段，采购申请写入时通过它换算。
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: this.gateway, sizeReferences: options.sizeReferences,
    });
    // ⛔ `this.recognizer`（文字模型：采购「数量说明」→ 尺码/数量）**已删除（2026-10-09）**：
    //    它唯一的调用方 `parseReportQuantities` 随「信息填写」入口一起退场。
    //    到货视觉识别更早（2026-10-05）就退场了 ⇒ 本类现在**不调任何模型**。
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    // 「明细 → PNG」。默认是 SVG+sharp 的真实实现；测试注入假实现就能断言
    // "每个供应商一张图"、"先发图后写表"，而不必在单测里真的跑一遍图形库。
    this.images = options.images || { render: renderPurchaseRequestPng };
    this.enablePurchaseInventory = true;
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/purchase_webhook_tasks'),
      idField: 'task_id',
    });
    // 「发到群的那条消息 ↔ 是哪一批」的映射（C 用 parent_id 反查靠它）。
    // ⚠️ 映射写**本地任务记录**，不写业务表：这是机器人的路由信息，
    // 不是经营事实，不该出现在她的多维表格里。
    this.batchLocator = options.batchLocator || new PurchaseBatchLocator({ store: options.batchLocatorStore });
    // ── 报货批次号：**由代码生成**（业务负责人 2026-10-07）────────────────────
    // 格式 `CGD-YYYYMMDD-NNNN`（前缀/日期格式/位数/时区全在 config/purchaseBatchNo）。
    // ⚠️ 2026-10-09：它原先还承担"入口按包写回「信息填写」"那件事；
    //    入口退场后只剩**生成**这一个职责（`ensurePostingPlan` → `nextBatchNo`），
    //    号源也只剩「报货批次」一张表（见 `PurchaseBatchNoGenerator`）。
    this.batchNoGenerator = options.batchNoGenerator || new PurchaseBatchNoGenerator({
      gateway: this.gateway,
    });
    // 「报货批次」那一行的读写（到货状态 / 单据附件 / 按批次号定位）。
    // 单独一个小 service：本类继续只管"报货 → 出单"，批次行怎么维护是它的事。
    this.orderBatches = options.orderBatches || new PurchaseOrderBatchService({
      gateway: this.gateway,
      settings: options.arrivalStatus,
    });
    // 卡片确认按 taskId 串行。重复的卡片事件（双击、飞书重投）会同时读到
    // awaiting_confirmation 并各自走一遍副作用，把同一批采购事实写两遍；
    // 卡片上的「处理中」只是 UX，后端必须自己保证同一任务不并行。
    this.confirmationQueue = new KeyedSerialQueue();
    // ⛔ 这里原有「读一条报单记录的重试」（`config/reportReadRetry`：读不到重试 3 次）
    //    —— 随报单入口退场（2026-10-09）；本文件不再 import 那份配置。
    // 「这一批里哪些（货品+尺码）正在加库存」的**进程内**进度（落盘那一份在 draft 上）。
    // ⚠️ 原名 `inflightInbound`（"入库行"进度）；入库行没有了 ⇒ 改叫 `inflightInventory`
    //    （它记的一直是"库存加过没有"，只是以前每一条都对应一行入库明细）。
    this.inflightInventory = new Map();
    // ⛔ 这里原有四份**报单/退货归批**状态（`inflightBatches` / `pendingReportBatches` ＋
    //    `inflightReturnBatches` / `pendingReturnBatches`，连同两个归批窗口配置与
    //    `packageProgress`「这一包应有几条」台账、以及 PM2 重启后的退货重开窗）
    //    —— 2026-10-09 随「信息填写」入口**整块删除**：没有入口就没有"一次表单提交的多条记录"，
    //    也就没有归批这回事。
    // 测试用的显式群通道（见 sendPurchaseGroupNotice）：传了就只发这个 chat_id，
    // **不读环境变量**——一个进程里并发跑的用例不会因为 PURCHASE_CHAT_ID 互相污染。
    this.sandboxChatId = options.sandboxChatId || '';
    // ⭐⭐ 2026-10-16（供应商拆分 · 业务负责人拍板 **ⓐ**：「同一个报货批次号下按供应商分组」）：
    //   分组口径 / 每组幂等键 / "没标注供应商"的桶 / 事件名。
    //   ⚠️ **构造时解析一次**（与 `this.orderBatches.settings` 同一种形状）：配置写错要在
    //      服务起来那一刻就吵，而不是等她第一次报货才发现 ✓（`resolveSupplierSplitConfig` 认不出就抛）。
    //   ⚠️ 用例可以注入一份假配置（`options.supplierSplit`）—— 与 `options.images` 同一种注入法 ✓。
    this.supplierSplit = options.supplierSplit || resolveSupplierSplitConfig();
  }

  // ── 实现已搬进 `services/purchase/**`（2026-10-18，task-6 文件大小门禁）──────────────
  // 保留**同名薄委托**：方法名 / 签名 / `this` 语义逐字不变 —— 既有调用方、用例
  // 以及模块内部的 `this.xxx(...)` 都不用改；方法体在对应小模块里**原样**保留，行为零变化。
  resolvePurchaseGroupTarget(options = {}) {
    return messaging.resolvePurchaseGroupTarget.call(this, options);
  }

  mentionOperatorText(operatorOpenId, content, config) {
    return messaging.mentionOperatorText.call(this, operatorOpenId, content, config);
  }

  async sendPurchaseGroupNotice(content, options = {}) {
    return messaging.sendPurchaseGroupNotice.call(this, content, options);
  }

  async sendImage(openId, imageBuffer, receiveIdType = 'open_id', options = {}) {
    return messaging.sendImage.call(this, openId, imageBuffer, receiveIdType, options);
  }

  async sendText(openId, content, receiveIdType = 'open_id', options = {}) {
    return messaging.sendText.call(this, openId, content, receiveIdType, options);
  }

  groupItemsBySupplier(items) {
    return supplierGroups.groupItemsBySupplier.call(this, items);
  }

  supplierReportGroups(task, posting = {}) {
    return supplierGroups.supplierReportGroups.call(this, task, posting);
  }

  async resolveSupplierName(supplierRecordId) {
    return supplierGroups.resolveSupplierName.call(this, supplierRecordId);
  }

  /** ⭐ 2026-10-29（A 方案·安全并行）：写表期间并行渲染各组 PNG（只渲染；失败返回 null 供 deliver 回退）。 */
  async prepareSupplierImages(taskId, task, plan = {}, options = {}) {
    return documentImages.prepareSupplierImages.call(this, taskId, task, plan, options);
  }

  async deliverSupplierImages(taskId, task, posting = {}, options = {}) {
    return documentImages.deliverSupplierImages.call(this, taskId, task, posting, options);
  }

  async deliverSupplierImagesInner(taskId, task, posting = {}, options = {}) {
    return documentImages.deliverSupplierImagesInner.call(this, taskId, task, posting, options);
  }

  async writeSupplierImageAttachment(options) {
    return documentImages.writeSupplierImageAttachment.call(this, options);
  }

  async resolvePurchaseInboundState(productRecordId) {
    return arrival.resolvePurchaseInboundState.call(this, productRecordId);
  }

  async updatePurchaseActionCard(task, event, card) {
    return messaging.updatePurchaseActionCard.call(this, task, event, card);
  }

  async ensurePostingPlan(taskId, task, options = {}) {
    return postingPlan.ensurePostingPlan.call(this, taskId, task, options);
  }

  async confirmArrivalLocked(taskId, task, operatorOpenId, options = {}) {
    return arrival.confirmArrivalLocked.call(this, taskId, task, operatorOpenId, options);
  }

  async writeArrivalAcceptance(options) {
    return arrival.writeArrivalAcceptance.call(this, options);
  }

  async nextBatchNo() {
    return postingPlan.nextBatchNo.call(this);
  }

  // ⛔⛔ 2026-10-09：**「信息填写」报单/退货入口整条链路已从这里删除**。
  //
  // 事实：业务负责人把「信息填写」表（`purchaseReport`，`tblo0ffzFt7vyQw2`）
  //   **整个从 Base 删掉了**（`TableIdNotFound` 1254041）；她的口径是
  //   **「自然语言 ＋ AI 录入」整套退场**（《信息填写》就是"供应商文字报单 → AI 解析"那条）。
  //
  // 随之删除的方法（原先都在这个位置附近，成片）：
  //   · 入口与归批：`accept` / `acceptMany` / `beginPackage` / `recordPackageDone` /
  //     `flushBatchSoon` / `settleBatchMembers` / `process` / `enqueue` / `purchaseTaskId`；
  //   · 报货解析：`handleReportBatch` / `flushReportBatch` / `deferReportBatch` /
  //     `runReportBatch` / `isReportRecordPosted` / `markRecordsAsPosted` /
  //     `processSupplierBatch` / `processSupplierReport` / `readReportRecordWithRetry` /
  //     `readReportBehaviorKind` / `parseReportQuantities` / `loadBehaviorIndex`；
  //   · 批次号写回：`readReportBatchNo` / `ensureIntakeBatchNo` / `ensureReportBatchNo` /
  //     `writeReportBatchNo`；
  //   · 采购退货整条：`planReturnFromItems` / `ensureReturnPlan` / `recoverPendingReturnBatches` /
  //     `handleReturnBatch` / `flushReturnBatch` / `deferReturnBatch` / `runReturnBatch` /
  //     `prepareSupplierReturn` / `applySupplierReturn` / `ensureReturnBatchRecord` /
  //     `deliverReturnImages` / `sendReturnNotice` / `processSupplierReturn`；
  //   · 顺带：`notifyQuantityMismatches`（数量不符告知，只有报货链路用）。
  //
  // ⭐ **保留下来的正是「生成采购申请」那一段**（本文件下半部分）：
  //   `publishPurchaseRequest` → `confirmPurchaseRequest`（写「报货批次」＋「报货信息」）、
  //   `deliverSupplierImages`（出图/发群/回填附件）、`confirmArrival`（到货核对 → 加库存）。
  //   它们**一处都没有**读过 `purchaseReport`，扫码补货报单与工作台仍在走这条免确认路径。
  //
  // ⚠️ 恢复这条入口（她改主意时）= **重新实现**，不是翻开关：
  //    这些方法在 git 历史里（`git log -S 'ensureReportBatchNo'`），
  //    连同 `purchaseQuantityPolicy` / `doubaoService.parsePurchaseReportText` 一起取回。


  // ⚠️ 2026-10-07：**解析只有一条路**（业务负责人的口径，逐字：「不分报货还是退货，
  // 都是按照同样的逻辑：如果数量说明不写，数量就默认为一双」）——报货与退货都调
  // `parseReportQuantities`（尺码多选逐个展开 + 数量说明，说明不写 ⇒ 每个勾选尺码 1 双）。
  // 「采购行为」只决定**走哪条链路**（出采购申请 / 扣库存出退货单），
  // **不再决定怎么解析**。原来的 `parseReportReturnQuantities`（"读「数量」列、无尺码"）
  // 与承接分流的壳 `parseReportItems` 都已随本次口径删除。


  // 🔴 2026-10-07「私聊链路移除」：`sendCard(openId, card)` **整段删除**。
  //    它是「把确认卡片发给经办人私聊」的那条路，**全仓没有调用方**
  //    （采购申请早已改走群：`sendText(chatId, …, 'chat_id')` / `sendPurchaseGroupNotice`），
  //    只留了一行注释说"要回滚成确认卡片就换回它"——留给下个读代码的人一个
  //    "好像还有一条私聊链路"的错觉。要用回来：`git log -S 'sendCard(openId, card)'`。
  //    ⚠️ 本类里「发消息」的四个方法名字仍然必须各不相同（见下面注释）：JS 类体里
  //    后定义的同名方法会**静默覆盖**先定义的，git 合并也不报冲突。

  // ── 已删除：到货「等待与提示」与失败提示整段 ──────────────────────────────
  // 删掉的有：notifyArrivalReceived / notifyArrivalFailed /
  // notifyArrivalWaiting / notifyArrivalRescued / startArrivalWaitWatch。
  //
  // 为什么删：它们服务的对象是「识别中」这个中间态和它对应的三个已删字段
  //（识别状态 / 识别失败原因 / 类型）——"每 1 分钟补一条还在识别中"、
  // "2 分钟放弃等待"、"3 分钟判失败"、"迟到结果救回"全部只在识别流程里有意义。
  // 留着的话没有任何调用方，只会在下次读代码的人脑子里重建一条不存在的流程。
  //
  // ⚠️ 合并 #57 吃过的那个亏（同类方法静默覆盖）在这里仍然有效，别重新引入：
  // 本类里同时存在语义不同的「发消息」方法时，**名字必须不同**——
  // JS 类体里后定义的同名方法会**静默覆盖**先定义的，git 合并也不报冲突。
  // 现在有三个：sendText / sendImage（失败即抛错）
  // 与 sendPurchaseGroupNotice（发群、失败只记日志、返回 false）。
  // ⚠️ 原本还有一个 `sendCard`（发经办人私聊的确认卡），已于 2026-10-07 整体删除（见上）。
  //
  // 🔴 2026-10-06「私聊切除」：`sendNoticeText`（发给经办人私聊的事后通知）**已整体删除**——
  // 它唯一的调用点就是采购退货的差额提示，那条现在改走 `sendPurchaseGroupNotice`
  // （业务负责人：「一律在话题群里，以后私聊路线就没有了」）。
  // 留着它就是留一条没人用的主动私聊出口，下次读代码的人很容易再挂上去。


  recordOperator(record, fieldName) {
    const value = record?.fields?.[fieldName];
    const first = Array.isArray(value) ? value[0] : value;
    return first?.id || first?.open_id || first?.openId || '';
  }

  /**
   * 货品记录里出图要用的三个展示字段。
   *
   * 「颜色」是关联字段，飞书在 link cell 里会带回被关联记录的主字段文本，
   * 所以 textValue 直接就能拿到颜色名，不需要再多查一次「颜色管理」。
   */
  productDisplayInfo(record, productTable) {
    const fields = record?.fields || {};
    return {
      number: textValue(fields[productTable.fields.number]),
      itemNo: textValue(fields[productTable.fields.itemNo]),
      color: textValue(fields[productTable.fields.color]),
    };
  }

  /**
   * 免确认生成采购申请。
   *
   * 产品负责人明确要求：报单解析完直接写「采购申请」，不再发确认卡片、不再等她点。
   * 理由是这批货本来就是她自己报的——「供应商报单」记录本身就是她的输入，
   * 再让她点一次「确认」只是重复劳动，还会因为忘了点让货卡住。
   *
   * ⚠️ 销售链路「未确认不写账」的红线**不受影响**：那条链路是她口述、AI 可能听错，
   * 必须由她核对后确认；采购这条是产品负责人单独定的口径，不要"顺手统一"。
   *
   * ⚠️ 幂等与回滚没有削弱：这里仍然走 confirmPurchaseRequest，
   * 也就是原来那套 posting_plan + createOnceByKey + 幂等键的写法，
   * 只是把"等卡片点确认"换成"解析完直接调用同一个确认函数"。
   * ⚠️ **回滚代价（2026-10-08 起变了）**：要回滚成"发确认卡片等她点"，
   * 卡片（`purchaseRequestConfirmationCard`）、两个动作常量与 `handleCardAction` 入口
   * **都已删除**（业务负责人逐条批准），`sendCard` 更早随私聊链路一起删——三条都得从
   * git 历史里取回（`git log -S 'purchaseRequestConfirmationCard'`）。
   */
  async publishPurchaseRequest(taskId, task, options = {}) {
    // 免确认路径没有卡片消息可更新，明确跳过一次卡片 patch（否则会打无意义的告警日志）。
    return this.confirmPurchaseRequest(taskId, task, {}, {
      skipCardUpdate: true,
      // ⭐⭐ 2026-10-16（供应商拆分 · 她选的 ⓐ）：**调用方（引擎）在"调写入口之前"已经算好的
      //   那一份分组** —— 原样带进写入口。
      //   🔴 为什么必须由调用方给：她要的是"**生成报货单之前**就把组算好"（生成完再拆就晚了 ✗）。
      //     本服务在"计划冻结"那一步**优先用它**，且会**交叉核对**（两边不一致 ⇒ 当场 warn ✓
      //     见 `ensurePostingPlan`）——**不是**两边各算一份然后随便挑一个 ✗。
      //   ⚠️ 缺省 `null` ⇒ 写入口按草稿**自己按同一条口径算**（老入口 / 单货品那条路 ✓ 逐字等价）。
      supplierGroups: options.supplierGroups || null,
    });
  }


  // ── 采购退货的归批（业务负责人 2026-10-06 的最终口径：「到齐 ＋ 重试 3 次」）──
  //
  // 为什么必须归批：一次表单提交 = N 条记录。逐条处理会出 N 张退货单、发 N 次群
  //（2026-10-06 生产实测过：同一次提交的 2 条退货被拆成两次推送 → 2 张单、2 次群）。
  //
  // 现在：按「报货批次号」把退货记录收进**自己的**待处理批次；**这一包到齐**
  //（进了链路的每一条都处理完：成功 ✓ 跳过 ✓ 重试 3 次读不到 ✓）就由**一个**处理者
  // 整批处理（一次出单、一次发群，见 runReturnBatch）。**不再有"时间窗到点就发"**。
  //
  // ⚠️ 思路复用报货那套，状态**刻意不共用**（两套 Map、两把锁、两份配置）：
  // 改一边不会动到另一边（AGENTS.md 的「解耦」）。


  // ── 已删除：processArrival（拍照识别的唯一入口）────────────────────────────
  // 它做过的事：读「采购到货」记录 → 写「识别中」→ 下载图片 → 视觉模型识别（鞋盒 / 到货单）
  // → 逐行匹配货品 → 组装草稿 → 写「识别成功」→ 发到货明细卡片 → 后台建档。
  // 2026-10-05 业务负责人删掉「类型」「识别状态」「识别失败原因」三个字段并决定这条链路退场，
  // 整段随之删除：它写的字段在表里已不存在，留着只会伪装成「识别还在跑」。
  //
  // ⚠️ 保留下来的（**2026-10-06 起有调用方了**：群话题对话式核对，她点「是」之后进来）：
  //   · confirmArrival    —— **逐条加库存**（`inventory.applyPurchase`）＋ 把「报货批次」那一行写实
  //                          （到货文字说明（该列已从真表退场） / 确认状态；**不再回写采购申请表**，见该方法的注释）。
  //                          ⚠️ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ 这里**不再写任何入库明细行**。
  //   ⛔ 2026-10-17：**成本与建档整条删除**（到货单价格识别已退场；货品建档的唯一路径是
  //      工作台「货品上新」→ 多维表格表单外链，提交后由表变更自动生成标签二维码）。
  //      现在本文件**不写「货品.成本」、不建新品**；只保留加库存与本单批次写实。
  //   · aggregateArrivalItems / resolvePurchaseInboundState
  // 它们的输入（draft.actual）由
  // services/purchaseArrivalConversationService.js 写入，形状与 processArrival 原先落的草稿一致。
  //
  // ⚠️ 已删除：`findRequestRowForInbound`（2026-10-07 深夜）—— 它只用来把**入库行**的
  //    「采购申请」关联挂回去；入库行没有了，它就没有任何调用方（不留孤儿）。


  // ── 已删除（2026-10-08，业务负责人逐条批准）：`handleCardAction` / `handleCardActionLocked` ──
  //
  // 它们只服务「报货确认卡」的两个动作（`confirm_purchase_request` / `cancel_purchase_request`）：
  //   · 取消分支：把「信息填写」的状态改成「已取消」+ patch 卡片；
  //   · 确认分支：`posting` → 出「处理中」状态卡 → `confirmPurchaseRequest` → 出「已生成」状态卡。
  // 报单链路 2026-10-07 起就是**免确认**（`publishPurchaseRequest` 直接调 `confirmPurchaseRequest`），
  // 那张卡没有任何发送方 ⇒ 入口、动作常量、卡片一并删除。
  // ⚠️ **保留**的：`confirmPurchaseRequest`（免确认链路在跑）、`updatePurchaseActionCard` 与
  //    `purchaseStatusCard`（处理中 / 已生成 / 未完成三张状态卡）。
  // ⚠️ 串行保证**没丢**：`confirmArrival` 自己就 `confirmationQueue.run(...)`（见它的注释）。


  /**
   * 确认生成采购申请（支持批量和单条）。
   *
   * 每一步都遵循「先按幂等键回查远端，再决定是否创建」，并在创建后立刻把
   * record_id 写回 posting_progress。这样无论是「远端已建、本地没记」还是
   * 「本地记了、进程重启」，重试都只会补齐缺的那部分。
   *
   * options.skipCardUpdate：免确认路径没有卡片消息可更新，跳过那次 patch。
   */
  async confirmPurchaseRequest(taskId, task, event = {}, options = {}) {
    const draft = task.draft;
    const isBatch = draft.is_batch === true;
    // ⭐ 2026-10-16（供应商拆分）：把**调用方在调写入口之前算好的分组**交给"计划冻结"那一步
    //   （它会优先用它、并交叉核对；见 `ensurePostingPlan`）。缺省 ⇒ 按草稿自己算（老入口 ✓）。
    const plan = await this.ensurePostingPlan(taskId, task, { supplierGroups: options.supplierGroups });
    // ⭐ 2026-10-29（A 方案·安全并行）：计划冻结后立刻并行渲染各组 PNG（与下面的写表同时进行）。
    //   只渲染；发送/回填仍在写表成功之后 —— 编排与重放/失败口径见 `purchase/preparedImages.js`。
    const preparedImagesPromise = startPreparedImages({ service: this, taskId, task, plan });
    // 关联键（只进日志）：task_id ＋ 批次号（plan 里已经冻结好了，重试不会换号）；
    // 每条写入再按需补上**它自己那条报单记录**的 id。
    const baseCorrelation = purchaseCorrelation({ taskId, batchNo: plan.batch_no });
    const progress = { ...(task.posting_progress || {}) };
    const requestIdByItemKey = { ...(progress.requests || {}) };

    // 报货批次：批次号与幂等键都来自已落盘的计划。
    let batchRecordId = progress.batch_record_id;
    if (!batchRecordId) {
      const batch = await createOnceByKey({
        gateway: this.gateway,
        tableKey: 'purchaseOrderBatch',
        keyField: IDEMPOTENCY_KEY_FIELD,
        keyValue: plan.batch_key,
        label: '采购主表',
        correlation: baseCorrelation,
        // ⭐ 到货状态：**新建记录时显式写「未到货」**（业务负责人 2026-10-07 的原话：
        // 「每创建一条新记录时，默认值是「未到货」」）。取值来自 config/purchaseArrivalStatus
        //（不是中文字面量），并由部署闸门对着真表 `property.options` 核对过。
        // ⚠️ 只在**新建**这一支写：`createOnceByKey` 回查到已有记录时不会走这里
        //   —— 历史批次行**零改动**（她的口径：历史不要动）。
        values: {
          batchNo: plan.batch_no,
          idempotencyKey: plan.batch_key,
          arrivalStatus: this.orderBatches.pendingStatus,
          // ⭐⭐ 2026-10-12（业务负责人测出来的缺口，逐字：「这**录入数量**里面应该是 5 啊，
          //    但是对于我们的这个数据表里面，它是记录为空呀」）：
          //    「录入数量」= **这一批的录入数量合计**（明细数量求和）。
          //    · 她走的两条入口（**供应商报单 webhook** / **扫码页补货**）都汇到这一处建行点
          //      ⇒ 一个写入点同时覆盖两条路 ✓
          //    · **拿不到 / 0 ⇒ 不写这一列**（`batchQuantityFields` 返空对象，网关跳过）
          //    · **幂等**：`createOnceByKey` 命中已有行时**整段 values 都不会重发** ⇒ 值不变、不累加 ✓
          ...batchQuantityFields(plan.items),
          // ⭐⭐ 2026-10-12（业务负责人）：「**采购主表里面的采购行为确实是需要的**，因为一个是
          //    报货，一个是退货」⇒ 建主表行时写「采购行为」（**报货这一路 = 采购申请那一档**）。
          //    值 = **行为记录 id**（`ensurePostingPlan` 里已经按这一次的明细冻结好了：
          //    `item.behavior_record_id`，明细没带才退回批次级的 `draft.behavior_record_id`），
          //    写成 `relation(...)`（关联字段的形状只有 `v1ReferenceResolver` 一处定义；
          //    空 id ⇒ `undefined` ⇒ 网关跳过该字段，不会写空值）。
          //    ⚠️ 「采购明细.采购行为」是这一列按「报货批次号」关联的 **Lookup（只读）**
          //    ⇒ 明细侧**不许再写**（2026-10-12 热修已撤，见本文件 `request_created` 那一段的注释）。
          behavior: relation(plan.items.map((item) => item.behavior_record_id).find(Boolean)
            || draft.behavior_record_id),
        },
      });
      batchRecordId = batch.recordId;
      progress.batch_record_id = batchRecordId;
      await this.store.update(taskId, { posting_progress: progress, posting_stage: 'batch_created' });
    }

    // ⭐⭐ 2026-10-12（业务负责人）：「在同一个报货批次号里面，这是我的第几双鞋，也是需要明细 ID 的」
    //    ⇒ 采购明细ID = `{报货批次号}-{两位序号}`（同一批次内按创建顺序；**已有行不重排**、
    //    后补的接着排、重放不重复占号）。号取自**主表那一行的报货批次号**（= `plan.batch_no`）。
    //    ⚠️ 逐条 `next()` 只在**真的创建**那一支调用（重放命中幂等 ⇒ 不动号）。
    //
    // ⭐⭐ 2026-10-16（采购写入提速 · 业务负责人当天点名「**补货和验收两个都需要**」）：
    //   这一段从「**逐条回查 + 逐条 create**」改成「**一次整表读（幂等回查与明细取号共用）
    //   ＋ 一次 `createBatch`**」。改之前的真账（本文件同目录的
    //   `test/purchaseDetailBatchWrite.test.js` 用计数网关量出来，不拿时间抖动当证据）：
    //     · 5 条明细 ⇒ **5 次整表读 + 5 次 create**（外加取号那 1 次读 = 6 次读）；
    //       飞书单次整表读实测 8~11 秒 ⇒ 光"明细"这一段就 ≈ 50 秒 ✗
    //     · 改之后 ⇒ **1 次整表读 + 1 次 createBatch** ✓
    //
    //  🔴 **语义一条不改**（"快了但少写一行"是绝对不行的 ✗）：
    //     · **幂等**：仍按**同一把** `request_key` 回查远端（复用**退货那一刀已经落进 main** 的
    //       `infrastructure/idempotencyKey.createOnceByKeys` —— **不另发明第二套批量形态** ✗）；
    //       重放命中 ⇒ 复用原记录 id、不重发 values、不重复占号 ✓
    //     · **明细 ID**：`detailIdCursor.next()` 仍**只对"这一次真的要建"的那几条**、
    //       且仍在 `plan.items` 顺序上依次取（空档可接受、重号不可以 —— 见 `purchaseDetailId` 文件头）✓
    //     · **本地进度**：`posting_progress.requests` 与 `posting_stage: request_created:<item_key>`
    //       仍**逐条、按原顺序**落盘 ⇒ 中断续跑与改动前逐字一致 ✓
    //       （远端那一半已经是批量的：崩在"远端已写、本地没记"之间时，重放按幂等键回查即命中 ⇒ 不重复 ✓）
    //     · **单据 / 出图 / 发群**：这一刀一个字都没碰（见 `deliverSupplierImages`）✓
    //     · **失败**：飞书**结构化拒绝**（字段不存在这类，可以确定没写）⇒ 原样抛；
    //       其余（超时 / 5xx = 写入结果未知）⇒ **不重发批量**，回落**逐条** `createOnceByKey`
    //       （它自己先按幂等键回查 ⇒ 批量已写进去的那几条被复用、没写的补上 ⇒ **补齐且不重复**）✓
    //       —— 也就是说：任何一条失败路径最终都落回**改动前那条逐条路**，不引入新的失败语义 ✓
    //     · 前置判据（尺码解析不出来 / 幂等键在远端重复）变得**更早**抛 ⇒ 不再留半截批次
    //       （改前是"前面几条已落、到那条才炸"；由 `test/purchaseDetailBatchWrite.test.js` 的
    //        AC-PB9 / AC-PB4c 显式钉住 —— 这是本刀**唯一**一处、且是更安全方向的差别 ✓）
    //  ⚠️ 退回逐条的唯一入口 = **网关没有 `createBatch`**（老替身 / 未接线）——
    //     与 2026-10-13 验收那条 `applyPurchaseBatch`、2026-10-16 退货那条 `createOnceByKeys`
    //     **同一套口径**（三条链一致：不另加开关；要回退 = 回滚这一次提交）✓
    const detailBatchWrite = typeof this.gateway.createBatch === 'function'
      && typeof this.gateway.listAll === 'function';
    // 攒批时**先读一次**采购明细快照：幂等回查与明细取号**共用这一份**（两次读的是逐字相同的数据，
    // 读两遍纯属浪费 ✗）。退回逐条时不读（那条路的读法一个字都没动 ✓）。
    const requestSnapshot = detailBatchWrite ? await this.gateway.listAll('purchaseRequest') : undefined;
    const detailIdCursor = await this.detailIds.open({
      batchRecordId, batchNo: plan.batch_no, rows: requestSnapshot,
    });

    // ── 明细：两种写法，语义（幂等 / 取号 / 进度 / 落盘顺序）**完全一致** ─────────────
    //   · **攒批**（默认，`detailBatchWrite`）：一次整表读（取号 + 幂等回查共用）＋ 一次 `createBatch`；
    //   · **逐条**（关掉开关 / 网关没有批量口）：`createOnceByKey` 一条一条 ——
    //     **这就是改动前那一段的原样保留**（既有用例里的替身走的正是这一支 ⇒ 行为逐字不变 ✓）。
    // ⚠️ 历史草稿可能带 `size === null`（采购退货那条链路，已随「信息填写」退场）：
    //    那种行**不写「尺码」字段**（relation(undefined) 会被 gateway 的 fields() 跳过）；
    //    采购申请本身仍然是"必须有尺码"，扫码补货报单每一步都给得出尺码。
    const buildRequestValues = async (item) => {
      const sizeReference = item.size === null ? null : await this.getSizeReferences().resolveByNumber(item.size);
      return {
        batchNo: relation(batchRecordId),
        product: relation(item.product_record_id),
        size: relation(sizeReference?.recordId),
        quantity: item.quantity,
        // ⭐ 采购明细ID（`{报货批次号}-01`、`-02`…）：同一批次内唯一、不重排
        detailId: detailIdCursor.next(),
        // 🔴 2026-10-12 热修：**不许再写「采购行为」** —— 她今天把这一列改成了
        //    **Lookup（19，按「报货批次号」关联采购主表的「采购行为」）**，Lookup 是**只读**的：
        //    轻则白写被忽略，重则**整条明细 create 失败**（那样这批报货一条明细都建不出来）。
        //    ⚠️ **只撤写入、保留读取**：`v1BitableSchema` 的映射留着，
        //    工作台采购查询的分流判据（`purchaseQueryService.classifyReportBehavior`）还在读它。
        //    ⚠️ 待定：主表的「采购行为」目前**没有写入点**（业务负责人 2026-10-07 说过
        //    「报货批次里面的采购行为你不用管」）⇒ 这一列在明细上会是空的，
        //    `classifyReportBehavior` 读不到就按现状=采购申请分流（口径待她确认）。
        idempotencyKey: item.request_key,
      };
    };
    // 「这一次真的要建」的明细（**按 `plan.items` 顺序**）：重放已命中幂等的不会进这里（⇒ 不动号、不重复建）。
    const requestIds = new Array(plan.items.length);
    const pendingItems = [];
    plan.items.forEach((item, index) => {
      const existing = requestIdByItemKey[item.item_key];
      if (existing) {
        requestIds[index] = existing;
        return;
      }
      pendingItems.push({ index, item });
    });

    /** 本地进度**逐条、按原顺序**落盘（与改动前逐字一致：中断续跑的判据就是它 ✓）。 */
    const persistRequestProgress = async (entry, recordId) => {
      requestIds[entry.index] = recordId;
      requestIdByItemKey[entry.item.item_key] = recordId;
      progress.requests = requestIdByItemKey;
      await this.store.update(taskId, {
        posting_progress: progress,
        posting_stage: `request_created:${entry.item.item_key}`,
      });
    };

    if (!detailBatchWrite) {
      // ── 退回逐条：**与改动前逐字一样**（先回查、再建、建完立刻落进度）──────────────
      for (const entry of pendingItems) {
        const values = await buildRequestValues(entry.item);
        // eslint-disable-next-line no-await-in-loop
        const created = await createOnceByKey({
          gateway: this.gateway,
          tableKey: 'purchaseRequest',
          keyField: IDEMPOTENCY_KEY_FIELD,
          keyValue: entry.item.request_key,
          label: `采购申请 ${entry.item.item_key}`,
          // ⚠️ 2026-10-09：这里原先还会补一个 `purchase_report_record_id`（那条报单记录）；
          //    报单入口退场 ⇒ 那个键**已无来源**（白名单里也删了），只留批次级关联键。
          correlation: baseCorrelation,
          values,
        });
        // eslint-disable-next-line no-await-in-loop
        await persistRequestProgress(entry, created.recordId);
      }
    } else if (pendingItems.length) {
      // ── 攒批：一次整表读（复用上面的快照）＋ 一次 `createBatch` ────────────────────
      //    取号与组 values 仍**按 plan.items 顺序**依次发生（与逐条路径同一串号）✓
      const built = [];
      for (const entry of pendingItems) {
        // eslint-disable-next-line no-await-in-loop
        built.push({ ...entry, values: await buildRequestValues(entry.item) });
      }
      const created = await createOnceByKeys({
        gateway: this.gateway,
        tableKey: 'purchaseRequest',
        keyField: IDEMPOTENCY_KEY_FIELD,
        correlation: baseCorrelation,
        // 幂等回查复用"取号那一次整表读"的快照 ⇒ 这一步零额外请求 ✓
        records: requestSnapshot,
        rows: built.map((entry) => ({
          keyValue: entry.item.request_key,
          label: `采购申请 ${entry.item.item_key}`,
          values: entry.values,
        })),
      });
      for (let i = 0; i < built.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await persistRequestProgress(built[i], created[i].recordId);
      }
    }

    // ⛔ 2026-10-09：这里原有「批量更新所有报单记录状态为『已生成申请』＋关联采购申请」——
    //    **整段删除**：那条记录属于「信息填写」表，而业务负责人把那张表**整个删掉了**
    //    （`gateway.update('purchaseReport', …)` 现在必然 `TableIdNotFound`）。
    //    ⚠️ 扫码补货报单**本来就没有报单记录**（`report_record_ids: []`），这一段对它是空转；
    //       真正属于它的动作（写「报货批次」＋「报货信息」＋出图）一行没动。
    await this.store.update(taskId, {
      status: 'posted',
      posting_progress: progress,
      posting_stage: 'posted',
      batch_record_id: batchRecordId,
      batch_no: plan.batch_no,
      request_ids: requestIds,
    });
    logInfo('purchase.request.created', { task_id: taskId, batch_record_id: batchRecordId, batch_no: plan.batch_no, request_count: requestIds.length, is_batch: isBatch });
    const posting = {
      request_ids: requestIds,
      request_id_by_item_key: requestIdByItemKey,
      batch_record_id: batchRecordId,
      batch_no: plan.batch_no,
      // 批次幂等键（**组级幂等键** `supplier_group:{batchKey}:{supplierKey}` 的一半就是它 ✓）
      batch_key: plan.batch_key,
      // ⭐⭐ 2026-10-16（供应商拆分 · 她选的 ⓐ）：**同一个批次号下**按供应商分的几组 ——
      //   在"计划冻结"那一步就算好了（**任何远端写入之前** ✓），这里原样交给出图那一步
      //   ⇒ 出图的每一组与计划里的每一组**一一对应**（不多一组、不少一组，组键也不漂 ✓）。
      supplier_groups: plan.supplier_groups || [],
    };
    // 采购事实已经落地之后的收尾动作：按供应商出图 → 发给她 → 写回附件。
    // 现场出图失败也只记日志（方法内部已吞异常），绝不把任务判成失败。
    // ⭐ 2026-10-16（供应商拆分）：把出图那一跑的**结果**带回去（发了几组 / 哪几组**已经出过**）——
    //   它现在是"生成报货单"这一步的可查产物（`image_delivery.group_count` / `already_reported` ✓），
    //   调用方与判据都能直接看，不必去翻日志（AC-SS4 就是靠它钉"同一组只出一次"）。
    // 写表已经成功 ⇒ 取回"并行渲染"的结果（通常早就好了）；渲染失败时为 null ⇒ deliver 现场渲染。
    const preparedImages = await preparedImagesPromise;
    const imageDelivery = await this.deliverSupplierImages(taskId, task, posting, { preparedImages });
    // 更新卡片为"已完成"状态（免确认路径没有卡片，跳过）
    if (!options.skipCardUpdate) {
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard({ ...draft, batch_no: plan.batch_no }, purchaseMessage.m1, purchaseMessage.m2({ plan, requestIds }), 'green'));
    }
    return {
      toast: { type: 'success', content: purchaseToast.m1({ plan, requestIds }) },
      ...posting,
      // ⭐ 出图那一跑的产物（**附加字段**，既有键名一个没动 ✓）：发了几组 / 哪几组已经出过
      image_delivery: imageDelivery,
    };
  }

  /**
   * 到货确认：**加库存** + 把**「报货批次」那一行**写实（实际数量 / 发生金额）。
   *
   * ⚠️ **不回写采购申请表**（业务负责人 2026-10-06 口径：「那个表就不要动」）。
   * 2026-10-05 之前它还由到货明细卡片的 `confirm_purchase_arrival` 动作调用；
   * 卡片随「拍照识别」退场后它一度是孤儿能力，**现在由「群话题对话式核对」在
   * 她点「是」之后调用**（见 services/purchaseArrivalConversationService.js）。
   *
   * ⭐ 2026-10-07 晚（到货落点大改）：
   *    · 「实际数量」「发生金额」**入库之前**写到「报货批次」那一行（`writeArrivalAcceptance`）；
   *    · 「到货状态 = 已到货」仍由对话链路的 `notifyBatchArrived` 负责（**不在这里写**，
   *      避免两处写同一列早晚写歪）；
   *    · 「到货验收」表已被业务负责人删除 ⇒ 这里**没有任何**指向它的读写。
   *    · ⛔ **2026-10-09**：「到货文字说明（该列已从真表退场）」「确认状态」两列在真表上**也没有了**
   *      ⇒ `markConfirmed`（写确认状态）**整个删除**、`writeAcceptance` 只再写
   *      实际数量/发生金额（见 `purchaseOrderBatchService` 与 schema 里的说明）。
   *
   * ⭐⭐ 2026-10-07 **深夜**（「采购入库」表被**整表删除**）：业务负责人的口径（逐字）——
   *    「甲 **不再写任何入库明细**：只更新「报货批次」（到货状态=已到货 + 到货文字说明（该列已从真表退场） + 确认状态）
   *     + **加库存**（库存流水 / 实时库存照写）—— 也就是"**入库明细表整个不要了**"」
   *    ⇒ 这个方法里**入库明细那一整段被删掉**：`create('purchaseInbound', …)`、
   *      `listAll('purchaseInbound')` 回查、为入库行做的「采购行为」查找、
   *      `draft.inbound_created` 落盘 —— 它们的对象都不存在了。
   *      `config/purchaseBehaviors.js`（采购环节 `PURCHASE_IN`）的唯一消费者就是那个「采购行为」
   *      ⇒ 一并退场。
   *    ⇒ **保留下来的正是"加库存"**：逐条 `inventory.applyPurchase`
   *      （「库存流水」+「实时库存」由它负责，这里是全仓**唯一**的库存实现）。
   *
   * 幂等（现在两层，缺一不可）：
   *    ① `draft.inventory_applied`（按 货品+尺码 逐个落盘）+ 进程内 `inflightInventory`；
   *    ② **库存自己那一层**：来源标识是**真实三元组**（批次身份 | 货品 | 尺码），
   *       由 `inventoryService.purchaseIncreaseSourceId` 算 ⇒ 重放/崩溃恢复都命中**同一条**
   *       本地库存任务（`server/data/inventory_operations` 是落盘的），不会重复加库存。
   *    ⚠️ 代价如实说：**不再有**"按远端关联列回查已写过的入库行"这一层（那张表已经不存在），
   *       所以本链路的恢复强度与**采购退货**相同（靠本地库存任务 + 落盘进度）。
   *
   * 并发：同一个 taskId 的确认走 confirmationQueue **串行**。这条保证原先由
   * `handleCardActionLocked`（到货卡片那个入口，2026-10-08 已删）提供，卡片删除后原样挪进来——
   * 否则两个调用方同时确认时，两边都会在对方落盘之前读到"还没加过"，各加一次库存。
   */
  async confirmArrival(taskId, task, operatorOpenId, options = {}) {
    // ⭐ 2026-10-13（验收提速）：尾部可选 `options.timing` —— 验收那一段自造的耗时汇总
    //    由这里**透传**到库存批量口（`inventory_ms` 只有写库那一层量得准），
    //    ⚠️ 只进日志、不改任何判定；不传 = 行为逐字不变。
    return this.confirmationQueue.run(taskId,
      () => this.confirmArrivalLocked(taskId, task, operatorOpenId, options));
  }


}

module.exports = { PurchaseWebhookService, attachmentTokens, buildPurchaseReturnNotice };
