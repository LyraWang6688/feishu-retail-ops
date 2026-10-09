const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, person, relation, normalizeColor } = require('./v1ReferenceResolver');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
// ⚠️ 2026-10-07 深夜：`config/purchaseBehaviors`（采购环节的 `PURCHASE_IN`）**随入库行一起退场**——
//    它的唯一消费者就是"入库行的「采购行为」"那一列，而「采购入库」表已被业务负责人整表删除。
//    ⇒ 别再把它 require 回来，也别拿 `inventoryService` 的 `STOCK_PURCHASE_INCREASE` 顶替：
//      那是**库存环节**的另一条行为记录，用错了等于把流水挂到另一条行为上。
const { recordUrl } = require('../utils/feishuLinks');
// ⭐ 2026-10-08：飞书错误的真实 code / msg / log_id / method_id —— **唯一**取用口
// （本文件下面那个 `larkErrorText` 就是它的薄壳，形状不变）。
const { larkErrorText: larkErrorTextOf } = require('../utils/larkError');
// ⛔ `doubaoService`（文字解析：销售录单 ＋ 采购「数量说明」）**已从这里删除（2026-10-09）**：
//   采购那一半（`parsePurchaseReportText`）随「信息填写」入口一起退场；
//   销售录单在 `services/larkMvpService.js` 那一侧用它，与本文件无关。
// 采购申请确认卡片（purchaseRequestConfirmationCard）**已于 2026-10-08 删除**：
// 报单链路 2026-10-07 起就是免确认（`publishPurchaseRequest` 直接调 `confirmPurchaseRequest`），
// 那张卡没有任何发送方、动作也认领不了 —— 业务负责人逐条批准后连卡片、动作常量、
// `handleCardAction` 一起删干净（历史注释见文件下半部分 `updatePurchaseActionCard` 之后）。
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
const { buildArrivalCostPlan, isBlankCost, costValueOf } = require('./arrivalCostPolicy');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { renderPurchaseRequestPng, RETURN_TITLE } = require('./purchaseRequestImageService');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey } = require('../infrastructure/idempotencyKey');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { withTimeout, withTimeoutProxy } = require('../utils/withTimeout');
const { getLarkAgentCredentials } = require('../config/larkAgent');
// 采购单改成发到**群**（业务负责人：「不用再看经办人了」）。
// 群 id 从配置读，**没有默认值**（见 config/groupPurchase 里的说明）。
const { resolvePurchaseChatId } = require('../config/groupPurchase');
// 采购群那条「@经办人 + 供应商名 + 这批 N 双，图可以直接转给供应商。」的**文案**。
// 2026-10-07 业务负责人逐字：「不用（说）几条，只给出多少双就可以了」⇒ 文案进配置、
// 逻辑里不写死中文（「N 条」与「共」都已从模板里删掉）。背景见该配置文件头。
const {
  resolvePurchaseGroupNoticeConfig,
  supplierLabel,
  renderPurchaseGroupNoticeText,
  renderPurchaseGroupNoticeMention,
} = require('../config/purchaseGroupNoticeText');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');
// 「报货批次号」的生成器（前缀/日期/位数/时区在 config/purchaseBatchNo）。
// 2026-10-07 业务负责人：报货批次号不再手填，改由后端代码生成。
const { PurchaseBatchNoGenerator } = require('./purchaseBatchNoGenerator');
// 「报货批次」那一行的读写（到货状态 / 单据附件 / 按批次号定位）。
// 抽成独立 service：本类只管"报货 → 出单"，批次行怎么维护不属于它（模块化）。
const { PurchaseOrderBatchService } = require('./purchaseOrderBatchService');
// 「这批发到群里的是采购申请单还是采购退货单」的批次类型标记（到货核对靠它区分话题）。
const { ARRIVAL_BATCH_KINDS } = require('../config/arrivalConversation');
// 「这条写入属于哪一笔采购业务」—— 关联键的唯一取用口（**白名单**，非白名单键与空值
// 一律不进日志）。与销售链路同一套：只把调用方**已经知道**的键带下去，不查表、不推导。
const { mergeCorrelation, correlationFields } = require('../utils/correlationFields');
// ⭐ 2026-10-09：扫码页「货品信息」内存快照（单价真源）的**跨模块失效** ——
//   本文件是"新建货品"与"写成本"两个写入口之一（另一个是 `tagQrCodeService` 写标签二维码）。
//   传 `{ tableKey: 'product' }` 只作废货品那一份（写货品不影响库存，别让库存快照白重拉）。
const { invalidateLiveInventorySnapshot } = require('./liveInventorySnapshot');

/**
 * 采购侧的关联键包（只进日志，**不改任何业务判断、不进任何业务 input**）。
 *
 * 与销售链路的 `options.correlation` 是同一个范式：显式传参、不用 AsyncLocalStorage
 * （库存引擎有跨请求重放，从上下文读会指向错的那一笔）。
 *
 * 三个键各自"从哪来"（**拿不到就不传**，`mergeCorrelation` 会把空值 / 非白名单键丢掉，
 * 所以不会写成 `"batch_no":""`）：
 *   · `task_id`                    —— 本地采购任务（扫码补货 = `scan_replenish_…`；
 *                                     到货核对 = `arrival_reconcile_…`，那是另一套 task，如实照传）
 *   · `batch_no`                   —— 采购批次号（代码生成的 `CGD-YYYYMMDD-NNNN`；旧数据可能是手填的 `202610071` 或旧的 `BH-…`）
 *   · `purchase_batch_record_id`   —— ⭐ **「报货批次」那条记录**（2026-10-07 晚替换掉了原来的
 *                                      `purchase_arrival_record_id`：到货落点从已删除的
 *                                      「到货验收」表搬到「报货批次」，那条旧记录 id 已无来源）
 *
 * ⛔ 原先还有第四个 `purchase_report_record_id`（「信息填写」那条报单记录）——
 *    **2026-10-09 已删**：那张表被业务负责人整个删掉、报单入口退场 ⇒ 这个键**已无来源**；
 *    按「删写入点 ＋ 删白名单键」处理（`utils/correlationFields.js` 里那一行也一并删掉），
 *    否则日志里会永远缺一个"本该有值"的键，反而误导排查。
 */
const purchaseCorrelation = ({ taskId, batchNo, batchRecordId } = {}) =>
  mergeCorrelation({
    task_id: taskId,
    batch_no: batchNo,
    purchase_batch_record_id: batchRecordId,
  });

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

/**
 * 「回复某条消息」时要不要**进话题**：`options.inThread === true` → `reply_in_thread: true`。
 *
 * 为什么需要这个字段（业务负责人 2026-10-07 真机测试后提的）：
 *   · 飞书里**回复 ≠ 话题**：不带 `reply_in_thread` 的回复只是**引用回复**，
 *     在普通群里就表现为**又一条并列消息** —— 她看到的就是"图一条、@文字一条，两条消息"；
 *   · 带 `reply_in_thread: true` 才是**话题**：主群里我们那条回复会**创建**话题，
 *     响应里回带 `thread_id`（`PurchaseBatchLocator` 正是拿它写「话题 ↔ 批次」映射的）。
 * ⚠️ **只在真的在回复某条消息时才有意义**（调用方只在 `replyToMessageId` 非空时传它）：
 *    顶层 `create` 没有"回复谁"这回事，带上这个字段没有意义。
 * ⚠️ 字段名与用法与 `larkMvpService.replyMessage(..., { inThread: true })` **完全一致**
 *    （`@larksuiteoapi/node-sdk` 的 `im.message.reply` 本来就带 `reply_in_thread`）——
 *    **不新引 SDK、也不换调用方式**。
 * ⚠️ 默认 `false` ⇒ 不传时出站 payload 与改动前**逐字节相同**（单测钉住了这一条）。
 */
const replyThreadFields = (options = {}) => (options?.inThread === true ? { reply_in_thread: true } : {});

// （`PURCHASE_RETURN_BATCH_KIND` 那个批次类型标记已随采购退货入口删除：
//  它只被退货归批的恢复逻辑读过。）

// （原先这里有个 number() 小工具，只被 confirmArrivalLocked 里那段"算到货状态"的
//  回写用；那段按业务负责人口径删掉后它就没有调用方了，随之删除，不留死代码。）

// 「附件单元格 → file_token 列表」的**唯一实现**搬到了 `purchaseOrderBatchService`
//（2026-10-07 附件回填改到「报货批次.单据」，两边都要用同一套解析；
//  这里只是转发导出，保持既有 `module.exports` 形状不变，避免第二份实现慢慢漂移）。
const { attachmentTokens } = require('./purchaseOrderBatchService');

const aggregateArrivalItems = (items) => {
  const byKey = new Map();
  for (const item of items) {
    const size = Number(item.size);
    const quantity = Number(item.quantity);
    // ⚠️ 新品在建档之前还没有 product_record_id（建档排在确认之后/新流程的编排里），
    // 所以这一步身份要退回「货号+颜色」——**不能**退回空串：
    // 两个不同新品都会落到空 key 上，被错当成同一条明细合并（尺码一样时数量翻倍，
    // 入库会跟着错）。老货品仍然用 product_record_id 聚合，行为不变。
    const identity = item.product_record_id || `pending:${textValue(item.item_no)}|${textValue(item.color)}`;
    if (identity === 'pending:|' || !Number.isInteger(size) || size <= 0 ||
      !Number.isInteger(quantity) || quantity <= 0) throw new Error('到货明细的货品、尺码或数量无效');
    const key = `${identity}|${size}`;
    if (byKey.has(key)) byKey.get(key).quantity += quantity;
    else byKey.set(key, { ...item, size, quantity });
  }
  return [...byKey.values()];
};

// （原先这里有个 sleep()，只被已删除的「识别失败态重试写入」用到，随那段一起删掉。）

/**
 * 飞书 SDK 抛错时 message 往往只有 "Request failed with status code 400"，
 * 真正有用的错误码和原因在 response.data 里（例如缺权限的 99991672）。
 * 出图/发图的失败只会写日志，所以日志必须带上这两个字段，否则线上排查只能靠猜。
 *
 * ⚠️ 2026-10-08：实现**收敛到 `utils/larkError`**（同一个形状只留一处实现）；
 *    这里的 `larkErrorText` 仍然是 `msg (Code: code)`，调用点与文案一个字不变。
 */
const larkErrorText = (error) => larkErrorTextOf(error);

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
// 保留下来的入库 / 建档 / 成本能力见 confirmArrival、ensureArrivalProducts 的注释。

// 鞋盒/吊牌上的「品名」：女鞋 → B、男鞋 → A。单选选项就是 A/B 两个字。
// 识别不出性别就留空：默认成 A 会把女鞋写进男鞋，比空着更难发现。
const genderToCategory = (value) => {
  const label = String(value || '').trim();
  if (/女/.test(label)) return 'B';
  if (/男/.test(label)) return 'A';
  return '';
};

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
  const label = `${itemNo || ''}${color || ''}`.trim() || '这个货品';
  const sizeText = (size) => (size ? `（${size} 码）` : '');
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
    return `采购退货没处理：${label}${sizeNames ? `（${sizeNames}）` : ''}在实时库存里一双都没有，` +
      '我没有扣库存，也没有把这条记录标成已处理。库存补上之后再提交一条退货记录就好～';
  }
  const parts = [
    ...shortfalls.map((entry) => (
      `${label}${sizeText(entry.size)} 你说要退 ${entry.declared} 双，实时库存里只有 ${entry.available} 双 —— ` +
      `我先按能对上的 ${entry.taken} 双处理了，差的 ${entry.shortfall} 双对不上。` +
      '要我一起退的话，把数量改成能对上的数再提交一条～'
    )),
    ...surpluses.map((entry) => (
      `⚠️ ${label}${sizeText(entry.size)} 在实时库存里还剩 ${entry.surplus} 双没退（总数是 ${entry.available} 双）——` +
      '要一起退就把数量改成总数再提交一条～'
    )),
  ];
  return `采购退货：${parts.join('')}`;
};

/**
 * 从货品记录里读「还缺哪些资料」。
 *
 * 「缺失信息说明」是飞书公式：齐备时返回「齐备」，否则返回缺的字段名（如「成本、品类」）。
 * 和销售侧 loadProductIndex 同一个思路——不自己逐字段判断，单一数据源留在表里。
 * 「样例图」是附件字段，不在公式里，要单独看有没有图。
 *
 * 公式刚建完记录时可能还没算出来，所以 readable 要区分「齐备」和「读不到」，
 * 读不到时只敢说"还没齐、去补"，不敢说"齐备"。
 */
const productInfoGaps = (record, productTable) => {
  const fields = record?.fields || {};
  const completeness = textValue(fields[productTable.fields.completeness]).trim();
  const sampleImages = fields[productTable.fields.sampleImage];
  return {
    missing: completeness && completeness !== '齐备'
      ? completeness.split('、').map((name) => name.trim()).filter(Boolean)
      : [],
    missingSampleImage: !(Array.isArray(sampleImages) && sampleImages.length > 0),
    completeness_readable: Boolean(completeness),
  };
};

// 记录链接只是给她点进去补资料用的：读不到 app token（本地/测试）时给不出链接，
// 但绝不能因此打断建档和入库——货已经在仓库里了。
const productRecordUrl = (tableId, recordId) => {
  let appToken = '';
  try { appToken = V1_BITABLE_SCHEMA.appToken; } catch { appToken = ''; }
  return recordUrl({ appToken, tableId, recordId });
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
    // 新品建档按 taskId 串行：她点确认时兜底那次和别的调用方如果并行，两边各自从任务里
    // 恢复建档进度，就会各建一条同名货品（幂等靠"先落盘再重试"的读回，挡不住真正的并发）。
    // 两个队列不会互相等待死锁：确认走 confirmationQueue，建档走 creationQueue，方向是单向的。
    //
    // ⚠️ 2026-10-05：建档（ensureArrivalProducts）现在**没有调用方**了——
    // 到货识别退场后，只有确认入库那一步会调它，而入库动作本身要等新的「对话到货」流程接。
    // 这段能力**刻意保留**（它就是将来要用的「建档 + 成本」，也是未合并分支
    // refactor/decouple-creation-and-stock 要剥成 services/productCreationService.js 的那一段），
    // 所以队列、幂等落盘、回读全部原样留着。
    this.creationQueue = new KeyedSerialQueue();
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






















  /**
   * 采购单要发到哪儿。**配置先行，没有默认值**。
   *
   * 返回 `{ chatId, sandbox, reason }`：
   *   · 配了 `PURCHASE_CHAT_ID` → 发那个群；
   *   · 没配 → sandbox=true，调用方**大声跳过并记日志**，绝不回落到私聊
   *     （业务负责人明确说「不用再看经办人了」，偷偷发私聊会让人以为已经升级到群）。
   *
   * 沙箱是测试用的显式通道（构造时注入 chatId，不读环境变量）：
   * 用 `process.env` 直接判的话，一个进程里并发跑的用例会互相污染。
   */
  resolvePurchaseGroupTarget(options = {}) {
    if (options.sandboxChatId) return { chatId: options.sandboxChatId, sandbox: true, reason: 'sandbox' };
    const chatId = resolvePurchaseChatId();
    if (!chatId) return { chatId: '', sandbox: false, reason: 'chat_id_unconfigured' };
    return { chatId, sandbox: false, reason: 'configured' };
  }

  /**
   * 采购单发到群里时，@那个记录的**经办人** —— 业务负责人明确改的。
   *
   * 为什么不再 @所有人：她要的是"经办人知道这批单子发了"，@所有人是群骚扰；
   * 经办人目前都在这个采购群里，所以直接在群里 @他（不再单独发私聊）。
   *
   * ⚠️ 拿不到经办人 open_id 时**不加 @**（只发正文）：宁可少一个提醒，也不能 @错人，
   *    更不能退回 @所有人。调用方会同时记一条 warn 日志，便于排查"为什么没 @到"。
   *
   * ⚠️ 2026-10-07：那段飞书 @ 标记**也进了配置**（`config/purchaseGroupNoticeText` 的
   *    `mention`，占位符 `{openId}`）—— 这里不再有写死的 `<at …>`。
   */
  mentionOperatorText(operatorOpenId, content, config = resolvePurchaseGroupNoticeConfig()) {
    // 拿不到 open_id → 空 @ 前缀（`renderPurchaseGroupNoticeMention` 返回空串）。
    return `${renderPurchaseGroupNoticeMention(operatorOpenId, config)}${String(content || '')}`;
  }

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

  /**
   * 在**采购群**（PURCHASE_CHAT_ID，和出图同一个群）说一句纯文本。
   *
   * 业务负责人 2026-10-06 的口径：「"说明和勾选对不上"时要不要在群里给个提示」→
   * 「可以给提示」。所以这是**运营可见的反馈**，不再让她"提交了没反应、只能查日志"。
   *
   * 与 sendText 是刻意分开的语义：
   *   · sendText —— 主链动作，发不出去就算这次处理失败；
   *   · sendPurchaseGroupNotice —— 发给采购群的事后通知，**失败不抛错**（只记日志、返回 false）：
   *     它出现在"这条报货没进图" / "退货数量对不上"之后，绝不能因为一句提示发不出去
   *     就把整批判成失败。
   *
   * 群 id 走 config/groupPurchase（未配置就大声跳过、不回落私聊，与出图同一条口径）。
   * `options.sandboxChatId`（构造入参）是测试用的显式通道：不读环境变量，避免并发用例互相污染。
   *
   * ⭐ `options.replyToMessageId`：传了就**回复那条消息**而不发顶层消息 ——
   *    采购退货的差额提示用它挂到**这一批退货单（图）的那个话题**下，
   *    而不是在群里另开一个话题（业务负责人：「一律在话题群里」）。不传 = 照旧发顶层。
   * ⚠️ 2026-10-07：回复时**同时带 `inThread: true`**（飞书 `reply_in_thread`）。
   *    只"回复某条消息"在飞书里是**引用回复**，不建话题 —— 那正是她看到"两条消息"的原因。
   */
  async sendPurchaseGroupNotice(content, options = {}) {
    // 关联键（task_id / batch_no / 记录 id）：只进日志。不传 = 日志形状**逐字不变**。
    const correlation = correlationFields(options.correlation);
    const target = this.resolvePurchaseGroupTarget({ sandboxChatId: this.sandboxChatId });
    if (!target.chatId) {
      logWarn('purchase.group_notice.skipped', {
        reason: 'purchase_chat_id_unconfigured', env: 'PURCHASE_CHAT_ID', content, ...correlation,
      });
      return false;
    }
    const replyToMessageId = String(options?.replyToMessageId || '').trim();
    try {
      await this.sendText(target.chatId, content, 'chat_id', {
        replyToMessageId: replyToMessageId || undefined,
        // 有回复对象 = 挂在那一批的话题下 → 必须进话题，否则又是一条并列的引用回复。
        inThread: Boolean(replyToMessageId),
      });
      logInfo('purchase.group_notice.sent', {
        chat_id: target.chatId, reply_to_message_id: replyToMessageId, ...correlation,
      });
      return true;
    } catch (error) {
      logWarn('purchase.group_notice.failed', { chat_id: target.chatId, error: error.message, ...correlation });
      return false;
    }
  }


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
  async publishPurchaseRequest(taskId, task) {
    // 免确认路径没有卡片消息可更新，明确跳过一次卡片 patch（否则会打无意义的告警日志）。
    return this.confirmPurchaseRequest(taskId, task, {}, { skipCardUpdate: true });
  }

  /**
   * 发送图片消息（飞书图片消息要先用 im.image 上传拿 image_key）。
   *
   * ⚠️ 上传图片用的是应用身份权限 im:resource:upload（或 im:resource）。
   * 没开通时这里会以 99991672 失败，日志里带上错误码，便于线上直接定位到权限问题。
   *
   * `receiveIdType` 默认为 open_id（私聊那条路今天仍在用：到货异常告知）；采购单发到群时
   * 由调用方传 `chat_id`（参数名必须跟着 receive_id 的实际类型走，不能写死 open_id）。
   *
   * 返回 `{ imageKey, messageId, threadId }`：采购单发到群之后要把 message_id / thread_id
   * 记进映射，供「话题里的消息 / 引用那条消息 → 是哪一批」反查（见 PurchaseBatchLocator）。
   * `threadId` 只有话题群（或飞书已经给这条消息开了话题）才有值，普通群是空串——
   * 那种情况由定位器在她第一次回复时补记，不影响定位。
   *
   * `options.replyToMessageId`：传了就**回复那条消息**（`im.message.reply`）而不是
   * 发一条顶层消息——采购单发到群时用它把第 2 条起的消息都挂到第 1 条的话题下
   * （业务负责人 2026-10-06 拍板，见 deliverSupplierImagesInner）。
   *
   * ⚠️ 2026-10-07 新增 `options.inThread`（**只在有 `replyToMessageId` 时有意义**）：
   * 带上它 → `im.message.reply` 的 `data.reply_in_thread = true` → 飞书把这条回复
   * **放进话题**（主群里我们这条回复会**创建**那个话题，响应里回带 `thread_id`）。
   * 🔴 不带它时，"回复某条消息"在飞书里只是**引用回复**、**不建话题** ——
   * 那正是业务负责人看到的"图一条、文字一条，两条并列消息"。
   * ⚠️ 与 `larkMvpService.replyMessage(..., { inThread: true })` 是**同一个字段、同一种用法**
   * （`@larksuiteoapi/node-sdk` 的 `im.message.reply` 本来就带 `reply_in_thread`），
   * **不新引 SDK、也不换调用方式**。默认 `false` ⇒ 不传时 payload 与改动前**逐字节相同**。
   */
  async sendImage(openId, imageBuffer, receiveIdType = 'open_id', options = {}) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送图片');
    let upload;
    try {
      upload = await this.client.im.image.create({
        data: { image_type: 'message', image: imageBuffer },
      });
    } catch (error) {
      throw new Error(`上传采购申请图片失败：${larkErrorText(error)}`);
    }
    // SDK 会剥掉外层信封、把 image_key 放在顶层；保留 .data.image_key 兜底，
    // 免得将来换了 http 实现之后这里静默拿不到 key。
    const imageKey = upload?.image_key || upload?.data?.image_key;
    if (!imageKey) throw new Error('采购申请图片上传成功但未返回 image_key');
    const content = JSON.stringify({ image_key: imageKey });
    const response = options.replyToMessageId
      ? await this.client.im.message.reply({
        path: { message_id: String(options.replyToMessageId) },
        data: { msg_type: 'image', content, ...replyThreadFields(options) },
      })
      : await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: openId, msg_type: 'image', content },
      });
    if (response.code !== 0) throw new Error(`发送采购申请图片失败: ${response.msg} (Code: ${response.code})`);
    return {
      imageKey,
      messageId: response.data?.message_id || '',
      threadId: response.data?.thread_id || '',
    };
  }

  /**
   * 发一条纯文字。返回 `{ messageId, threadId }`。
   *
   * ⚠️ 返回值从"messageId 字符串"改成对象，是为了把 `thread_id` 一起带出来记映射
   * （话题里后续消息只带 thread_id，不带 parent_id）。本类里只有采购单发到群那一个
   * 调用点，已同步改成解构 `{ messageId, threadId }`。
   *
   * `options.replyToMessageId`：传了就**回复那条消息**而不是发顶层消息——采购单发到群时
   * 用它把「文字 @」挂到第 1 条图的话题下（业务负责人 2026-10-06 拍板）。
   * ⚠️ 一律回复**第 1 条**（不是回复上一条）：飞书的话题 = 一条消息 + 回复它的消息，
   * 回复话题里任何一条都算同一个话题；固定回复第 1 条，归属最稳、也最好解释。
   *
   * ⚠️ 2026-10-07 新增 `options.inThread`：见 `replyThreadFields` 的注释 ——
   * **只"回复"不建话题**（飞书那是引用回复），要"图与文字落在同一个话题"就必须带它。
   * 不传时 payload 与改动前**逐字节相同**。
   */
  async sendText(openId, content, receiveIdType = 'open_id', options = {}) {
    if (!openId) throw new Error('采购记录缺少经办人 open_id，无法发送说明');
    const text = JSON.stringify({ text: content });
    const response = options.replyToMessageId
      ? await this.client.im.message.reply({
        path: { message_id: String(options.replyToMessageId) },
        data: { msg_type: 'text', content: text, ...replyThreadFields(options) },
      })
      : await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: openId, msg_type: 'text', content: text },
      });
    if (response.code !== 0) throw new Error(`发送采购申请说明失败: ${response.msg} (Code: ${response.code})`);
    return {
      messageId: response.data?.message_id || '',
      threadId: response.data?.thread_id || '',
    };
  }

  // 同一个供应商的明细合成一张图。没有供应商的明细（历史草稿）归到一组，
  // 宁可出一张"未标注供应商"的图，也不能拆成一人一张。
  groupItemsBySupplier(items) {
    const groups = new Map();
    (items || []).forEach((item, index) => {
      const supplierRecordId = item?.supplier_record_id || '';
      const key = supplierRecordId || '__unknown__';
      if (!groups.has(key)) groups.set(key, { supplierRecordId, items: [], indexes: [] });
      const group = groups.get(key);
      group.items.push(item);
      group.indexes.push(index);
    });
    return [...groups.values()];
  }

  async resolveSupplierName(supplierRecordId) {
    if (!supplierRecordId) return '';
    const table = this.gateway.table('supplier');
    const record = await this.gateway.get('supplier', supplierRecordId).catch(() => null);
    return textValue(record?.fields?.[table.fields.name]).trim();
  }

  /**
   * 采购申请写完之后：按供应商出图 → 发给报单人 → 写回「采购申请单」附件。
   *
   * ⚠️ 顺序是有意为之：**先发图，再写回附件**。
   * 她已经拿到图才能转发给供应商，附件只是留档；写回失败绝不能让她收不到图。
   * 因此附件写入的异常只记警告，绝不向上抛。
   *
   * 这个方法也绝不向上抛异常：调用它的时候采购事实已经落地，
   * 抛出去会让 process() 把任务判成 failed、把报单记录标成「解析失败」，
   * 她会以为这批货没报上，而实际上已经报上了。
   */
  async deliverSupplierImages(taskId, task, posting = {}, options = {}) {
    try {
      return await this.deliverSupplierImagesInner(taskId, task, posting, options);
    } catch (error) {
      // 兜底：调用方是"采购事实已经写完"的收尾流程，这里漏出去的异常会把任务判成 failed。
      logError('purchase.request.image.delivery_failed', { task_id: taskId, error: error.message });
      return { sent: [], failed: [{ supplier: '', error: error.message }], thread_root_message_id: '' };
    }
  }

  // options.title / options.fileNameSuffix：采购退货单与采购申请单共用这一整条
  // 「按供应商出图 → 发到群 → 写回附件」的流程，只有标题和文件名不同（口径就是"格式一样"）。
  async deliverSupplierImagesInner(taskId, task, posting = {}, options = {}) {
    const draft = task?.draft || {};
    const items = draft.items || [];
    if (!items.length) return { sent: [], failed: [], thread_root_message_id: '' };
    // 这一层已经知道的关联键：task_id ＋ 批次号（只进日志）。
    // ⚠️ 报单记录 id **刻意不给**：批次草稿里它是**多条**（report_record_ids），
    //    挑一条当代表就是编 —— 每条记录自己那几次写入会各自带自己的 id。
    const batchNo = posting.batch_no || draft.batch_no || '';
    const correlation = purchaseCorrelation({ taskId, batchNo });
    // ⚠️ 采购单**只发群**（业务负责人：「不用再看经办人了」）。
    // operator_open_id 仍然留着——它是「这条记录是谁报的」，用于到货异常告知、
    // 以及权限判断，不再决定采购单发到哪儿。
    const operatorOpenId = draft.operator_open_id;
    // 构造入参里的 sandboxChatId 是**整条链路共用的测试群**（出图与提示发同一个群）：
    // 没配它、也没在读环境变量时（生产），这里等价于原来的 resolvePurchaseGroupTarget(options)。
    const target = this.resolvePurchaseGroupTarget({
      ...options,
      sandboxChatId: options.sandboxChatId || this.sandboxChatId,
    });
    if (!target.chatId) {
      // **大声跳过**：不静默、不回落到私聊。这条日志就是排查入口——
      // 线上看到它 = 环境变量 PURCHASE_CHAT_ID 没配，采购单已经写成但图没发出去。
      logWarn('purchase.request.image.skipped', {
        task_id: taskId,
        reason: 'purchase_chat_id_unconfigured',
        env: 'PURCHASE_CHAT_ID',
        operator_open_id: operatorOpenId,
        hint: '未配置采购群，采购申请已生成但图与说明未发送；配好后可按 task 补发',
      });
      return { sent: [], failed: [], skipped: 'chat_id_unconfigured', thread_root_message_id: '' };
    }
    const sent = [];
    const failed = [];
    // 发到群里的每条消息的 message_id / thread_id：记进本地映射，
    // 供「话题里的消息 / 引用那条消息 → 是哪一批」反查。
    const groupMessages = [];
    // 这一批在群里发的**第 1 条消息**（图）的 message_id = 话题根。
    // 它之后的每条消息都回复它（见下），于是整批只占一个话题。
    let threadRootMessageId = '';
    if (!operatorOpenId) {
      // 经办人没解析出来（报单记录没填/字段映射缺失）：照发正文，只是不 @ 人。
      // 记 warn 是为了排查"为什么这批单子没 @到经办人"，绝不退回 @所有人。
      logWarn('purchase.request.image.operator_missing', {
        task_id: taskId, chat_id: target.chatId, hint: '未解析出经办人 open_id，这条群消息不会 @任何人',
      });
    }
    // 群里那条话术的**文案**（含 @ 标记 / 供应商占位 / 双数占位 / 未标注供应商的兜底写法）
    // 全在 `config/purchaseGroupNoticeText`：**调用时才解析**（不在模块加载时求值）。
    const noticeConfig = resolvePurchaseGroupNoticeConfig();
    for (const group of this.groupItemsBySupplier(items)) {
      const supplierName = await this.resolveSupplierName(group.supplierRecordId).catch(() => '');
      // 供应商名取不到 → 用配置里的兜底写法（默认「未标注供应商」），**绝不编**。
      const label = supplierLabel(supplierName, noticeConfig);
      // ⚠️ 双数口径**一个字没动**：还是这一组明细的 `quantity` 求和。
      //    2026-10-07 只改文案（删掉「N 条」）——`group.items.length`（条数）**不再要了**，
      //    连那个变量一起删（留着没人读的 `rowCount` 只会让下一个人以为文案里还有条数）。
      const totalPairs = group.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      let png;
      try {
        png = await this.images.render({
          supplierName,
          batchNo: posting.batch_no || draft.batch_no || '',
          items: group.items,
          // 不传就是采购申请单（渲染器里的默认标题），退货传「邯美皮鞋采购退货单」。
          title: options.title,
        });
        // ⚠️ 一条开话题、后面的回复它（业务负责人 2026-10-06 拍板）：
        // 以前图一条、文字一条都是**顶层消息**，飞书里顶层消息各成一个话题，
        // 一次提交就变成 4 条消息 / 4 个话题（生产实测）。
        // 现在：**第 1 条（图）照常顶层发** → 后面每条（文字 @、多供应商时的第 2 张图…）
        // 都 `im.message.reply` 回复**第 1 条**，于是它们都挂在那一个话题下。
        // ⚠️ 固定回复第 1 条，不是回复上一条：飞书的话题 = 一条消息 + 回复它的消息，
        // 回复话题内任何一条都算同一个话题；固定成根消息归属最稳，也最好排查。
        //
        // 🔴 2026-10-07 关键修复（业务负责人真机测试后）：「@了经办人，但不是在同一个话题下
        // 回复的，而是发了两条消息」。根因：**飞书里"回复"≠"话题"** —— 只 `im.message.reply`
        // 是**引用回复**，要**再带 `reply_in_thread: true`** 才进话题（主群里我们这条回复
        // 会**创建**话题，响应才回带 `thread_id`）。
        // ⇒ 这一批里**凡是回复第 1 条图的消息**（第 2 张图、@文字）都带 `inThread: true`。
        // ⚠️ **第 1 条图仍然是顶层 `create`**：群里没有"她的那条消息"可以回复（这条链路是
        // 多维表格记录变更触发的），所以话题的根**只能是这张图** —— 我们自己的第一条消息。
        const imageResult = await this.sendImage(target.chatId, png, 'chat_id', {
          replyToMessageId: threadRootMessageId,
          inThread: Boolean(threadRootMessageId),
        });
        // 第 1 条消息就是这一批的话题根：它之后的每一条都回到它身上。
        if (!threadRootMessageId && imageResult.messageId) threadRootMessageId = imageResult.messageId;
        if (!threadRootMessageId) {
          // 拿不到第 1 条的 message_id 就没法回复它 → 后面的消息只能退回顶层发
          //（话题归属保证不了）。真出现这条日志说明飞书响应里没有 message_id，
          // 属于异常；但**不能因此不发**她那条 @，所以只记一条 warn。
          logWarn('purchase.request.image.thread_root_missing', {
            task_id: taskId, chat_id: target.chatId, supplier: label,
            hint: '发送图片的响应里没有 message_id，后续消息将退回顶层发送（话题归属无法保证）',
          });
        }
        // 图单独一条、文字带 @经办人 单独一条：飞书图片消息没有正文，
        // @ 只能挂在文字那条上（业务负责人明确要 @经办人，不再是 @所有人）。
        // ⚠️ `inThread`：这条必须**进话题**（回复第 1 条图 + `reply_in_thread`）——
        //    她要的就是"图与文字在同一个话题里"，而飞书单靠"回复"只会得到一条引用回复。
        // ⚠️ 第 1 条图没有 `threadRootMessageId`（它就是根）→ 那种情况 `textInThread` 自然是
        //    `false`：顶层 `create` 本来也没有"回复谁 / 进哪个话题"这回事。
        const textInThread = Boolean(threadRootMessageId);
        // ⚠️ 2026-10-07（业务负责人逐字：「不用说几条，只给出多少双就可以了」）：
        //    文案从配置渲染 —— `{supplier} 这批 {pairs} 双，图可以直接转给供应商。`
        //    **没有「N 条」、也没有「共」**；`{pairs}` = 上面那个 `totalPairs`（口径未动）。
        const textResult = await this.sendText(
          target.chatId,
          this.mentionOperatorText(
            operatorOpenId,
            renderPurchaseGroupNoticeText({ label, pairs: totalPairs }, noticeConfig),
            noticeConfig,
          ),
          'chat_id',
          { replyToMessageId: threadRootMessageId, inThread: textInThread },
        );
        groupMessages.push(
          { messageId: imageResult.messageId, threadId: imageResult.threadId },
          { messageId: textResult.messageId, threadId: textResult.threadId },
        );
        // 业务负责人要据此测试：发出去那一刻就把「哪个群 / 哪一批 / 哪条消息 / 哪个话题」记全。
        logInfo('purchase.request.image.group_sent', {
          task_id: taskId, chat_id: target.chatId,
          batch_no: posting.batch_no || draft.batch_no || '', supplier: label,
          operator_open_id: operatorOpenId || '',
          thread_root_message_id: threadRootMessageId,
          image_message_id: imageResult.messageId, image_thread_id: imageResult.threadId,
          text_message_id: textResult.messageId, text_thread_id: textResult.threadId,
          text_is_reply: Boolean(threadRootMessageId && textResult.messageId),
          // ⭐ 2026-10-07：她要能一眼看出"这次是不是真的进了话题"——把发出去时用的
          // `reply_in_thread` 一起记下来（排查"怎么还是两条消息"时，第一眼就看这个字段）。
          text_reply_in_thread: textInThread,
        });
      } catch (error) {
        failed.push({ supplier: label, error: error.message });
        logError('purchase.request.image.send_failed', {
          task_id: taskId, supplier: label, chat_id: target.chatId, error: error.message,
        });
        // 图没发出去就不写附件：保持"先发图、再写回"的顺序，留下人工补发的余地。
        continue;
      }
      try {
        const written = await this.writeSupplierImageAttachment({
          taskId, supplierName: label, png,
          // ⭐ 2026-10-07：附件改回填**「报货批次」的「单据」**（业务负责人：
          // 「把这些信息挪到我们的'报货批次'里面」）—— 原来写的「采购申请单」那一列
          // 已被她**从生产表删掉**，再往那儿写只会 FieldNameNotFound。
          batchNo: posting.batch_no || draft.batch_no || '',
          fileNameSuffix: options.fileNameSuffix,
          // 附件写回也是写库：带上这一层的关联键（task_id ＋ batch_no）。
          correlation,
        });
        if (written?.written) {
          logInfo('purchase.request.image.attachment_written', { task_id: taskId, ...written, ...correlation });
        }
      } catch (error) {
        // 只告警：她已经有图了。
        logWarn('purchase.request.image.attachment_write_failed', { task_id: taskId, supplier: label, error: error.message });
      }
      sent.push(label);
    }

    // 「这条消息 / 这条话题 ↔ 是哪一批」的映射：**发完就记**，失败只告警。
    // 记不上只影响 C 的定位（她会被告知"认不出"），绝不能让采购单已经发出去之后
    // 再把任务判成失败。
    for (const { messageId, threadId } of groupMessages.filter((item) => item.messageId)) {
      try {
        await this.batchLocator.rememberGroupMessage({
          batchNo,
          messageId,
          threadId,
          chatId: target.chatId,
          suppliers: sent,
          requestIds: posting.request_ids || [],
          detailCount: items.length,
          // 采购申请单 / 采购退货单共用这一条"出图 → 发群 → 记映射"的路，
          // 所以映射里必须带上类型：话题里的到货核对只认采购申请单那一类。
          kind: options.kind || ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
        });
      } catch (error) {
        logWarn('purchase.request.image.batch_mapping_failed', {
          task_id: taskId, message_id: messageId, chat_id: target.chatId,
          batch_no: batchNo, error: error.message,
        });
      }
    }

    // `thread_root_message_id`：这一批在群里发的**第 1 条消息**（图）= 话题根。
    // 把它交回给调用方，退货的差额提示才能**回复它**、落在同一个话题里
    //（业务负责人：「一律在话题群里，以后私聊路线就没有了」）。
    const summary = {
      sent, failed, chat_id: target.chatId, thread_root_message_id: threadRootMessageId,
    };
    if (failed.length) {
      // 图没发出去（例如机器人缺 im:resource 图片上传权限）时把失败留在任务里：
      // 采购事实已经写成、任务已是 posted，重收 webhook 会被当成重复投递跳过，
      // 所以必须留下这条记录，运维才知道哪一批图欠着、补完权限按 task 补发。
      await this.store.update(taskId, { image_delivery: { ...summary, at: new Date().toISOString() } })
        .catch((error) => logWarn('purchase.request.image.delivery_persist_failed', { task_id: taskId, error: error.message }));
    }
    return summary;
  }

  /**
   * 把某个供应商的采购申请图（或采购退货单图）写进**「报货批次」的「单据」**。
   *
   * ⭐ 2026-10-07 业务负责人改的地方（逐字）：
   *   「你之前**下载完附件之后，不是要回填到那个供应商那边吗？现在不用往那边填写信息了，
   *     你需要把这些信息挪到我们的'报货批次'里面**」
   * ⇒ 目标从「报货信息（表名沿革：原「具体信息」/「单据信息」）.采购申请单」改成「**报货批次.单据**」。
   *   原来那一列她已**从生产表删掉**，再往那儿写只会 `FieldNameNotFound`。
   *
   * 规则（**沿用改动前的语义**，只是换了落点）：
   * - 按「报货批次号」定位那一行批次记录；
   * - **重复执行（重跑批次）不得写出第二条** → 同名的图已经在「单据」里就跳过，连上传都不做；
   * - 一批多供应商时**已有附件原样带上**再追加新的那张（不冲掉别人的图）。
   *
   * ⚠️ 本方法**抛错**由调用方 catch（"写回失败不阻塞主流程"这条既有行为不变）——
   *    她已经有图了，写不回附件只是"欠一次转发"，绝不是把已经发出去的采购单判成失败。
   */
  async writeSupplierImageAttachment({
    taskId, supplierName, png, batchNo = '', fileNameSuffix = '采购单', correlation = {},
  }) {
    if (!String(batchNo || '').trim()) {
      logWarn('purchase.request.image.no_batch_no', { task_id: taskId, supplier: supplierName });
      return { written: false, reason: 'no_batch_no' };
    }
    if (typeof this.gateway.uploadAttachment !== 'function') {
      throw new Error('gateway 不支持附件上传（uploadAttachment）');
    }
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'purchase-request-image-'));
    try {
      const safeName = String(supplierName || 'supplier').replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'supplier';
      const fileName = `${safeName}-${fileNameSuffix}.png`;
      // ⚠️ **上传之前**先判"这张图是不是已经在这一批的「单据」里了"：
      //    既有的语义是「重复执行**连上传都不做**」（重跑批次不该白传一次素材）。
      const existing = await this.orderBatches.findDocument(batchNo, fileName);
      if (!existing.found) {
        // 这一批在「报货批次」里**没有行**。2026-10-07 晚起**报货与退货都会建行**
        // （退货那一行由 ensureReturnBatchRecord 在出图之前建），所以走到这里只剩两种
        // 真实可能：① 那一行的创建**失败**（建行那一步只 warn、不阻塞）；
        // ② 没有批次号的旧数据 / 入口没写回号（writeSupplierImageAttachment 的
        //    `no_batch_no` 已经先记了一条）。两种情况都**不白传一次素材**，
        // 只记这条 warn —— 图已经发到群里了。
        logWarn('purchase.batch.document.no_record', {
          task_id: taskId, batch_no: batchNo, file_name: fileName,
          hint: '这一批在「报货批次」里没有行（建行失败 / 没有批次号）→ 单据图暂时没有落点',
        });
        return {
          written: false, reason: 'no_batch_record', batch_no: batchNo, file_name: fileName,
        };
      }
      if (existing.exists) {
        // 既有日志语义保持不变（原本叫 `attachment_exists`）：重复执行时的"已经有了"。
        logInfo('purchase.request.image.attachment_exists', {
          task_id: taskId, record_id: existing.recordId, batch_no: batchNo, file_name: fileName,
        });
        return {
          written: false, skipped: true, record_id: existing.recordId, batch_no: batchNo, file_name: fileName,
        };
      }
      const filePath = path.join(tempDir, fileName);
      await fs.promises.writeFile(filePath, png);
      const fileToken = await this.gateway.uploadAttachment(filePath);
      const written = await this.orderBatches.writeDocument({
        batchNo, fileToken, fileName, correlation,
      });
      if (written?.skipped) {
        logInfo('purchase.request.image.attachment_exists', {
          task_id: taskId, record_id: written.record_id, batch_no: batchNo, file_name: fileName,
        });
      }
      return { ...written, supplier: supplierName };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 决定采购入库的库存状态：
   * - 如果该编号（货号）下完全没有样品库存（不管哪个尺码），则先作为样品入库
   * - 如果该编号下已有任意尺码的样品库存，则作为门盒入库
   * 这和销售相反（销售先卖门盒，再卖样品）
   */
  async resolvePurchaseInboundState(productRecordId) {
    try {
      // 查询该编号下所有尺码的样品库存记录（不指定尺码）
      const allLiveRecords = await this.gateway.listAll('liveInventory');
      const table = this.gateway.table('liveInventory');
      const sampleRecords = allLiveRecords.filter((record) => {
        // 使用 linkedRecordIds 处理关联字段，兼容飞书API返回的多种格式
        const productIds = linkedRecordIds(record.fields?.[table.fields.product]);
        // 单选字段可能返回字符串或数组，统一处理
        const stateValue = record.fields?.[table.fields.state];
        const state = Array.isArray(stateValue) ? stateValue[0] : stateValue;
        return productIds.includes(productRecordId) && String(state) === '样品';
      });
      return sampleRecords.length === 0 ? '样品' : '门盒';
    } catch (error) {
      logWarn('purchase.inbound.state_check.failed', { product_record_id: productRecordId, error: error.message });
      return '门盒'; // 查询失败时默认入门盒
    }
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












  /**
   * 建档进度落盘。
   *
   * 建档是远端写入，按项目约定必须把已经写出的 record_id 落盘：任务失败后重试
   * 会重跑一次到货解析，那时飞书列表可能还没读到刚建的货品，只靠"再查一遍"不足以防重复。
   *
   * 成本也一并落盘（arrival_cost_written）：写成本本身是**幂等赋值**，重复写同一个值不会
   * 写坏数据，但"结果未知"（写完还没来得及记录就失败）不能当成"没写过"再走一遍决策——
   * 尤其不能在第二次重试时把它当成"已有成本"而发一条误导的 warn。
   */
  async persistArrivalCreation(context) {
    if (!context.taskId) return;
    try {
      await this.store.update(context.taskId, {
        arrival_created_products: context.createdLog,
        arrival_created_colors: context.createdColors,
        arrival_cost_written: context.costWritten,
      });
    } catch (error) {
      logWarn('purchase.arrival.created_product_persist_failed', { task_id: context.taskId, error: error.message });
    }
  }

  /**
   * 从已落盘的任务里恢复上一次的建档结果，重试时直接复用，不再重复建。
   */
  buildArrivalCreationContext(task) {
    const products = Array.isArray(task?.arrival_created_products) ? task.arrival_created_products : [];
    const colors = Array.isArray(task?.arrival_created_colors) ? task.arrival_created_colors : [];
    const costWritten = Array.isArray(task?.arrival_cost_written) ? task.arrival_cost_written : [];
    const context = {
      taskId: task?.task_id || '',
      productCache: new Map(),
      colorIndex: new Map(),
      createdColors: colors.map((item) => ({ ...item })),
      createdLog: products.map((item) => ({ ...item })),
      colorTableLoaded: false,
      // 本次到货的价格计划（item_no → 可信单价 / 冲突标记）。
      // 由写草稿的一方从 task.recognized 里重建（见 ensureArrivalProducts）。
      arrivalCostPlan: null,
      // 已经处理过成本的货品（写成功，或已判定"不覆盖"）：重试时直接跳过，不重复写。
      costApplied: new Map(costWritten.map((item) => [item.product_record_id, item.cost])),
      costWritten: costWritten.map((item) => ({ ...item })),
    };
    // 上次已经建好的颜色先占位：重试时同一个颜色名不会再建第二条。
    for (const item of context.createdColors) {
      if (item?.name) context.colorIndex.set(normalizeColor(item.name), item.color_record_id);
    }
    for (const item of context.createdLog) {
      context.productCache.set(`${item.item_no}|${item.color}`, {
        is_new: true,
        recordId: item.product_record_id,
        record: null,
        item_no: item.item_no,
        color: item.color,
        supplier: item.supplier || '',
        label: `${item.item_no}${item.color}`,
        color_created: Boolean(item.color_created),
        gaps: null,
      });
    }
    return context;
  }

  /**
   * 按颜色名找「颜色管理」的记录，找不到就新建一条并记下来。
   *
   * 颜色表是**共享主数据**：OCR 抖一下（「棕色」/「棕」）就多建一条，以后同一个颜色
   * 会散成好几条，所以比对用 normalizeColor（去空白、去末尾「色」），
   * 并且整张表只读一次、同一次到货里同名颜色只建一条。
   */
  async ensureArrivalColor(color, context) {
    const colorTable = this.gateway.table('color');
    if (!context.colorTableLoaded) {
      for (const record of await this.gateway.listAll('color')) {
        const name = normalizeColor(textValue(record?.fields?.[colorTable.fields.name]));
        if (name && !context.colorIndex.has(name)) context.colorIndex.set(name, record.record_id);
      }
      context.colorTableLoaded = true;
    }
    const key = normalizeColor(color);
    if (context.colorIndex.has(key)) return { recordId: context.colorIndex.get(key), created: false };

    const created = await this.gateway.create('color', { name: color }, { correlation: context.correlation });
    const recordId = created?.recordId || '';
    if (!recordId) throw new Error(`颜色「${color}」新建失败`);
    context.colorIndex.set(key, recordId);
    context.createdColors.push({ name: color, color_record_id: recordId });
    await this.persistArrivalCreation(context);
    logInfo('purchase.arrival.color_created', { color, color_record_id: recordId });
    return { recordId, created: true };
  }

  /**
   * 给新品建一条「货品信息」，然后原样返回新记录。
   *
   * ⚠️ 只由 ensureArrivalProducts 调用。它原先的时序约束（"发确认卡片之前不做创建"）已随
   * 到货卡片退场失效——现在没有卡片了，调用方自己决定什么时候建；幂等规则一字不变。
   *
   * 只写确定知道的字段（产品负责人 2026-10-05 定稿的建档内容）：
   * 货号、颜色（关联）、供应商（关联，找不到就留空）、类别（识别出男/女才填，
   * 认不出留空——默认成 A 会把女鞋写进男鞋）、成本（识别到价格才填，识别不出留空）。
   * 刻意不写「编号」「货品状态」「缺失信息说明」——这三个在飞书里是公式字段，
   * 写进去会直接 FieldNameNotFound，而且它们的值本来就该由表自己算。
   * 也刻意不写「单价」：建档时看到的价格是采购成本，不是销售单价。
   */
  async ensureArrivalProduct(raw, context) {
    const itemNo = String(raw.item_no || '').trim();
    const color = String(raw.color || '').trim();
    const cacheKey = `${itemNo}|${color}`;
    const cached = context.productCache.get(cacheKey);
    // 同一个「货号+颜色」在一次到货里会有多个尺码：复用第一条建好的记录（含上次重试建的），
    // 不要再建第二条——这就是"重复建档只建一条"的落点。
    if (cached) {
      // 从上次重试恢复出来的条目还没有回读数据：补一次回读（只有日志/草稿用得上）。
      if (!cached.gaps) {
        cached.record = (await this.gateway.get('product', cached.recordId).catch(() => null)) || cached.record;
        cached.gaps = productInfoGaps(cached.record, this.gateway.table('product'));
      }
      return { ...cached };
    }

    const productTable = this.gateway.table('product');
    const values = { itemNo };
    if (color) values.color = relation((await this.ensureArrivalColor(color, context)).recordId);

    // 供应商也只在识别到名字、且供应商表里确实有这条时才关联；找不到留空，不新建、不猜。
    const supplierName = String(raw.supplier || '').trim();
    if (supplierName) {
      try {
        const supplier = await this.references.resolveSupplier(supplierName);
        if (supplier?.recordId) values.supplier = relation(supplier.recordId);
      } catch (error) {
        logWarn('purchase.arrival.supplier_not_found', { item_no: itemNo, supplier: supplierName, error: error.message });
      }
    }
    const category = genderToCategory(raw.gender || raw.category);
    if (category) values.category = category;

    // 成本：新品建档顺带把成本写上（产品负责人要求：货号/颜色/供应商/类别/成本一起落）。
    // 合并口径（#63「识别到价格就写成本」× #64「可信价格才写」）：
    //   价格来源统一走 buildArrivalCostPlan（它已按货号汇总、并把 unit_cost/unitCost/cost/price
    //   几种模型写法都算进来）；同货号多行价格不一致（conflict）→ plan 里没有可用 cost，不写。
    // 建档只会新建记录，不存在覆盖已有成本的问题——命中的老货品一律原样使用、不改动。
    const costPlanEntry = context.arrivalCostPlan?.get(itemNo);
    const createdAtCost = costPlanEntry && !costPlanEntry.conflict ? costPlanEntry.cost : null;
    if (createdAtCost !== null) values.cost = createdAtCost;

    const created = await this.gateway.create('product', values, { correlation: context.correlation });
    const recordId = created?.recordId || created?.record_id || '';
    if (!recordId) throw new Error(`新品建档失败：${itemNo}${color}`);
    // ⭐ 2026-10-09：新建了货品 ⇒ 当场作废扫码页那份「货品信息」内存快照
    //   （不然刚建档的新品在扫码页上最多 60 秒读不到单价/货品）。
    invalidateLiveInventorySnapshot('product_created', { tableKey: 'product' });

    const entry = {
      is_new: true,
      recordId,
      record: created?.record || null,
      item_no: itemNo,
      color,
      supplier: supplierName,
      label: `${itemNo}${color}`,
      color_created: context.createdColors.some((item) => normalizeColor(item.name) === normalizeColor(color)),
      gaps: null,
    };
    context.productCache.set(cacheKey, entry);
    context.createdLog.push({
      item_no: itemNo, color, product_record_id: recordId, supplier: supplierName, color_created: entry.color_created,
    });
    // 建档时已经把成本写进去了：登记成"已处理"，applyArrivalCost 就不会再对它
    // 走一次"成本为空 → 写"的判断（重试也不会）。
    if (createdAtCost !== null) {
      context.costApplied.set(recordId, createdAtCost);
      context.costWritten.push({ item_no: itemNo, color, product_record_id: recordId, cost: createdAtCost, source: 'create' });
      logInfo('purchase.arrival.cost_written', {
        item_no: itemNo, color, product_record_id: recordId, cost: createdAtCost, source: 'create',
      });
    }
    // 先落盘再回读：哪怕回读或后续步骤失败，重试也能凭这条记录跳过重复建档。
    await this.persistArrivalCreation(context);

    // 建档后回读一次：公式（缺失信息说明）是飞书算的，创建响应里通常还没有值。
    // 回读失败不影响入库；这些缺口现在只进日志和草稿，不再上卡片
    //（产品负责人：卡片上不写"还差什么字段"）。
    try {
      entry.record = (await this.gateway.get('product', recordId)) || entry.record;
    } catch (error) {
      logWarn('purchase.arrival.created_product_readback_failed', { product_record_id: recordId, error: error.message });
    }
    entry.gaps = productInfoGaps(entry.record, productTable);
    logInfo('purchase.arrival.product_created', {
      item_no: itemNo, color, product_record_id: recordId, color_created: entry.color_created,
      missing: entry.gaps.missing, missing_sample_image: entry.gaps.missingSampleImage,
    });
    return entry;
  }

  /**
   * 到货新品建档 + 到货单价格写成本。
   *
   * ⚠️ 2026-10-05：**这个方法现在没有调用方**——它原本由 processArrival（发完卡片之后）
   * 和到货卡片确认（confirmArrival 兜底）各调一次，两处都随「拍照识别」退场删掉了。
   * **刻意保留**：它就是将来「对话到货」和「货品上新提前」要用的建档能力，
   * 未合并分支 refactor/decouple-creation-and-stock 正把它原样剥成
   * services/productCreationService.js（输入改成结构化明细、不认 OCR / 图片 / 到货任务）。
   *
   * 输入：task.draft.pending_creation（要建什么）+ task.recognized（价格来源）。
   * 两者原先都由 processArrival 写进任务；形状不变，新流程照这个形状写就行。
   *
   * 幂等（三道，缺一不可）：
   *   ① 同一个 taskId 的多次调用走 creationQueue **串行**——调用方之间
   *      不会同时从任务里读到"还没建"然后各建一条；
   *   ② buildArrivalCreationContext 从任务里恢复上次已建的 record_id
   *      （arrival_created_products 每建一条就落盘），重试时 ensureArrivalProduct
   *      命中缓存直接返回，**不建第二条货品**；
   *   ③ 颜色的去重靠颜色表整表读一次 + normalizeColor（同名颜色只建一条）。
   *
   * 失败处理：建档失败**不抛**（只有 store 坏了才抛），改成把 creation_state='failed'
   * 和原因写进草稿——确认那一步据此明确告诉她，并且再点一次就能重试。
   * 成本写失败**不算建档失败**（既有的规则：成本写不进去不挡入库，只记 warn）。
   *
   * @returns {Promise<{state: 'done'|'failed', created: number, cost_written_count: number, failures: Array}>}
   */
  async ensureArrivalProducts(taskId, options = {}) {
    return this.creationQueue.run(taskId, async () => {
      const task = await this.store.get(taskId);
      const draft = task?.draft;
      // ⚠️ 2026-10-07 晚：原来这里跟着表名写成「到货验收草稿…」，但那**张表已被业务负责人删除**。
      //    这句错误原文可能被上层拼进**她看得见**的回话/提示里，所以按现在的语义改成「到货核对草稿」。
      if (!draft) throw new Error('到货核对草稿不存在或已过期');
      const pending = Array.isArray(draft.pending_creation) ? draft.pending_creation : [];
      const productTable = this.gateway.table('product');
      const context = this.buildArrivalCreationContext(task);
      // 建档 / 写成本也是写库动作：关联键（task_id ＋ 批次号 ＋ **报货批次记录 id**）挂在这个
      // **只在本进程内传递**的 context 上 —— 不落盘、不进任何业务入参，只进日志。
      context.correlation = purchaseCorrelation({
        taskId, batchNo: draft.batch_no, batchRecordId: draft.batch_record_id,
      });
      // 价格计划按任务里落盘的**到货明细**（task.recognized）重建：建档顺带写成本、
      // 老货品补成本，两条路用的是同一份计划，规则仍然是"同货号价格冲突就整条不写"。
      context.arrivalCostPlan = buildArrivalCostPlan(task.recognized || []);
      // 同一货号读出多个不同单价 → 整条不写，这里**只打一条 warn**（否则同一货号的每个
      // 尺码都会重复报一次）。这段原先在 processArrival 里，识别退场后挪到"建计划的地方"——
      // 规则不变：谁建计划，谁负责报冲突。
      for (const entry of context.arrivalCostPlan.values()) {
        if (!entry.conflict) continue;
        logWarn('purchase.arrival.cost_conflict', {
          task_id: taskId,
          batch_record_id: draft.batch_record_id || '',
          item_no: entry.item_no,
          prices: entry.prices,
          reason: '同一货号读出多个不同单价，不写成本，请人工核对',
        });
      }

      const failures = [];
      for (const entry of pending) {
        try {
          await this.ensureArrivalProduct(entry, context);
        } catch (error) {
          failures.push({ item_no: entry.item_no, color: entry.color, error: error.message });
          logWarn('purchase.arrival.product_create_failed', {
            task_id: taskId, item_no: entry.item_no, color: entry.color, error: error.message,
          });
        }
      }

      // 已经匹配到老货品的行：成本跟建档一起补（原来这个顺序由"发完卡片再写"决定，
      // 卡片退场后只保留"成本和建档同一步完成"这个事实）。
      // 按 货号+颜色+货品 去重，免得同一货品的每个尺码各读一次表。
      const costSeen = new Set();
      for (const item of draft.actual || []) {
        if (item.created_product || !item.product_record_id) continue; // 新品的成本在建档时一起写了
        const key = `${item.item_no}|${item.color}|${item.product_record_id}`;
        if (costSeen.has(key)) continue;
        costSeen.add(key);
        try {
          const record = await this.gateway.get('product', item.product_record_id).catch(() => null);
          await this.applyArrivalCost(item, { recordId: item.product_record_id, record }, productTable, context);
        } catch (error) {
          // 成本这条线故意不算进 failures：写不进去不该把她挡在入库外面（见 applyArrivalCost 注释）。
          logWarn('purchase.arrival.cost_write_failed', {
            task_id: taskId, item_no: item.item_no, product_record_id: item.product_record_id, error: error.message,
          });
        }
      }

      // 建档结果直接从缓存取（含上一次重试已经建好、本次识别里不再出现的条目）。
      // 恢复出来的条目没有回读数据：缺口按"读不到"处理（这些字段只进日志/草稿，
      // 到货明细卡片已随识别链路退场删除，所以不再有"还差什么"上卡片这件事）。
      const createdEntries = [...context.productCache.values()];
      for (const entry of createdEntries) {
        if (!entry.gaps) entry.gaps = productInfoGaps(entry.record, productTable);
      }
      const createdProducts = createdEntries.map((entry) => ({
        product_record_id: entry.recordId,
        item_no: entry.item_no,
        color: entry.color,
        supplier: entry.supplier,
        label: entry.label,
        color_created: entry.color_created,
        missing: entry.gaps.missing,
        missing_sample_image: entry.gaps.missingSampleImage,
        completeness_readable: entry.gaps.completeness_readable,
        // 链接回填到草稿：她点确认之后的结果卡片就用它（她点进去补资料）。
        url: productRecordUrl(productTable.tableId, entry.recordId),
      }));

      // 合并进**最新**草稿，不整份覆盖：她可能正好在这期间点了确认，
      // 那一侧会往草稿里写 inbound_created，覆盖掉就等于把入库进度和链接一起冲没了。
      const latest = (await this.store.get(taskId)) || task;
      const creationError = failures.length
        ? failures.map((item) => `${item.item_no || ''}${item.color || ''}：${item.error}`).join('；')
        : '';
      const nextDraft = {
        ...latest.draft,
        created_products: createdProducts,
        created_colors: context.createdColors.map((item) => item.name),
        creation_state: failures.length ? 'failed' : 'done',
        creation_error: creationError,
      };
      await this.store.update(taskId, { draft: nextDraft });
      logInfo('purchase.arrival.creation.finished', {
        task_id: taskId, reason: options.reason || 'unknown', state: nextDraft.creation_state,
        pending_count: pending.length, created_product_count: createdProducts.length,
        created_color_count: nextDraft.created_colors.length,
        cost_written_count: context.costWritten.length, failure_count: failures.length,
      });
      return {
        state: nextDraft.creation_state,
        created: createdProducts.length,
        cost_written_count: context.costWritten.length,
        failures,
      };
    });
  }

  /**
   * 把到货单识别到的价格写进货品「成本」。
   *
   * 产品负责人的口径：「如果有的到货单上有价格的，那就是成本。」
   * 单据上的「销售价 / 单价」列 → 「货品信息」的「成本」字段（number 字段，直接写数字）。
   *
   * 写入规则刻意保守（谁改这里都要先读一遍）：
   *   1. 只在成本**为空**时写（含数字 0 都算已有值，见 arrivalCostPolicy.isBlankCost）；
   *   2. 已有成本 → 不覆盖，记一条 warn（带 货号 / 已有值 / 识别到的值）；
   *   3. 同一货号多行价格不一致 → 整条不写（conflict 由调用方统一记一条 warn）；
   *   4. 价格转不成正数 → 不写（plan 里根本没有这个货号）；
   *   5. 重试不重复写：写成功的货品记进 context.costApplied 并落盘，重试直接跳过。
   *
   * 写失败**不抛错**：成本写不进去不该把整批到货卡住（货已经到了，入库优先）；
   * 记 warn 后由下一次重试再试（赋值幂等，重复写同一个值无害）。
   *
   * @returns {Promise<{applied: boolean, reason: string}|null>} 只用于日志/测试断言
   */
  async applyArrivalCost(raw, product, productTable, context) {
    const itemNo = String(raw?.item_no || '').trim();
    const entry = context.arrivalCostPlan?.get(itemNo);
    if (!entry || entry.conflict || entry.cost === null) return null;
    const recordId = product.recordId;
    if (!recordId) return null;

    // 本次（或上次重试）已经处理过这条货品：直接跳过，不重复写、也不再打日志。
    if (context.costApplied.has(recordId)) return { applied: false, reason: 'already_applied' };

    const existing = product.record?.fields?.[productTable.fields.cost];
    if (!isBlankCost(existing)) {
      // 已有成本一律不覆盖；只有「值真的不一样」才 warn。
      // 值相同说明是上一次重试已经写成功了（这就是为什么必须先记账再往下走）。
      if (costValueOf(existing) === entry.cost) {
        context.costApplied.set(recordId, entry.cost);
        logInfo('purchase.arrival.cost_already_set', {
          item_no: itemNo, product_record_id: recordId, cost: entry.cost,
        });
      } else {
        context.costApplied.set(recordId, entry.cost);
        logWarn('purchase.arrival.cost_kept', {
          item_no: itemNo,
          product_record_id: recordId,
          existing_cost: textValue(existing),
          recognized_cost: entry.cost,
          reason: '货品已有成本，识别到的到货单价不覆盖',
        });
      }
      return { applied: false, reason: 'existing_cost' };
    }

    try {
      await this.gateway.update('product', recordId, { cost: entry.cost }, { correlation: context.correlation });
      // ⭐ 2026-10-09：改了货品（成本）⇒ 作废货品快照（下一次扫码从内存里读到的就是新值）。
      invalidateLiveInventorySnapshot('product_cost_written', { tableKey: 'product' });
    } catch (error) {
      logWarn('purchase.arrival.cost_write_failed', {
        item_no: itemNo, product_record_id: recordId, cost: entry.cost, error: error.message,
      });
      return { applied: false, reason: 'write_failed' };
    }

    context.costApplied.set(recordId, entry.cost);
    context.costWritten.push({ item_no: itemNo, color: String(raw?.color || '').trim(), product_record_id: recordId, cost: entry.cost, source: 'update' });
    await this.persistArrivalCreation(context);
    logInfo('purchase.arrival.cost_written', { item_no: itemNo, product_record_id: recordId, cost: entry.cost, source: 'update' });
    return { applied: true, reason: 'written' };
  }

  // ── 已删除：processArrival（拍照识别的唯一入口）────────────────────────────
  // 它做过的事：读「采购到货」记录 → 写「识别中」→ 下载图片 → 视觉模型识别（鞋盒 / 到货单）
  // → 逐行匹配货品 → 组装草稿 → 写「识别成功」→ 发到货明细卡片 → 后台建档。
  // 2026-10-05 业务负责人删掉「类型」「识别状态」「识别失败原因」三个字段并决定这条链路退场，
  // 整段随之删除：它写的字段在表里已不存在，留着只会伪装成「识别还在跑」。
  //
  // ⚠️ 保留下来的（**2026-10-06 起有调用方了**：群话题对话式核对，她点「是」之后进来）：
  //   · confirmArrival    —— **逐条加库存**（`inventory.applyPurchase`）＋ 把「报货批次」那一行写实
  //                          （验收原话 / 确认状态；**不再回写采购申请表**，见该方法的注释）。
  //                          ⚠️ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ 这里**不再写任何入库明细行**。
  //   · ensureArrivalProducts / ensureArrivalProduct / ensureArrivalColor / applyArrivalCost
  //                       —— 新品建档 + 成本（未合并分支 refactor/decouple-creation-and-stock
  //                          正把它剥成 services/productCreationService.js）
  //   · aggregateArrivalItems / resolvePurchaseInboundState
  // 它们的输入（draft.actual / pending_creation / task.recognized）由
  // services/purchaseArrivalConversationService.js 写入，形状与 processArrival 原先落的草稿一致。
  //
  // ⚠️ 已删除：`findRequestRowForInbound`（2026-10-07 深夜）—— 它只用来把**入库行**的
  //    「采购申请」关联挂回去；入库行没有了，它就没有任何调用方（不留孤儿）。


  /**
   * 更新采购消息卡片（类似销售的 updateSalesActionCard）
   */
  async updatePurchaseActionCard(task, event, card) {
    const messageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id;
    if (!messageId) {
      console.warn('lark.purchase.card.update.skipped', { task_id: task.task_id, reason: 'missing_message_id' });
      return false;
    }
    try {
      const patch = this.client.im?.v1?.message?.patch || this.client.im?.message?.patch;
      if (!patch) return false;
      const response = await patch.call(this.client.im?.v1?.message || this.client.im.message, {
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      if (response.code !== 0) throw new Error(response.msg + ' (Code: ' + response.code + ')');
      return true;
    } catch (error) {
      console.warn('lark.purchase.card.update.failed', { task_id: task.task_id, error: error.message });
      return false;
    }
  }

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
   * 生成并持久化 Posting Plan。
   *
   * 这个计划有两个作用，缺一不可：
   * 1. 幂等键的唯一来源——重试时必须复用同一批键，每次重新生成等于没有幂等；
   * 2. 崩溃后的恢复清单——知道「应该写几条、写到哪一条」。
   *
   * 所以它必须在任何远端写入之前落盘；落盘失败就不能开始写。
   */
  async ensurePostingPlan(taskId, task) {
    if (task.posting_plan?.version === 1) return task.posting_plan;
    const draft = task.draft || {};
    const items = draft.items || [];
    if (!items.length) throw new Error('采购申请草稿没有任何明细，无法生成采购计划');
    const plan = {
      version: 1,
      batch_key: `purchase_batch:${taskId}`,
      // 批次号也只生成一次：重试时重新取号会变成一个已存在批次的新号。
      batch_no: draft.batch_no || (await this.nextBatchNo()),
      items: items.map((item, index) => ({
        // item_key 是「计划里第几条」的稳定标识，随计划一起持久化，
        // 因此重试时不会因为数组顺序变化而换键。
        item_key: `${taskId}:${index}`,
        request_key: `purchase_request:${taskId}:${index}`,
        // ⛔ `report_record_id`（「信息填写」那条报单记录）**已删除（2026-10-09）**：
        //    报单入口退场 ⇒ 这个字段没有任何读方，留着只会在日志/排查里误导。
        product_record_id: item.product_record_id,
        // 历史草稿可能带 `size: null`（采购退货那条链路，已退场）：这里保留 null，
        // 写入时**不写「尺码」字段**。不能写 Number(null)=0（0 会被尺码解析判成非法）。
        size: item.size === null || item.size === undefined ? null : Number(item.size),
        quantity: Number(item.quantity),
        // 行为按明细走（明细没带才退回批次级的那一个）。「报货信息.采购行为」是关联
        // 「行为管理」，出图/查询都要用它。
        behavior_record_id: item.behavior_record_id || draft.behavior_record_id || '',
      })),
    };
    const updated = await this.store.update(taskId, { posting_plan: plan, posting_stage: 'posting_plan_created' });
    return updated.posting_plan;
  }

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
    const plan = await this.ensurePostingPlan(taskId, task);
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
        label: '报货批次',
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
        },
      });
      batchRecordId = batch.recordId;
      progress.batch_record_id = batchRecordId;
      await this.store.update(taskId, { posting_progress: progress, posting_stage: 'batch_created' });
    }

    // 逐条创建采购申请
    const requestIds = [];
    for (const item of plan.items) {
      let recordId = requestIdByItemKey[item.item_key];
      if (!recordId) {
        // ⚠️ 历史草稿可能带 `size === null`（采购退货那条链路，已随「信息填写」退场）：
        //    那种行**不写「尺码」字段**（relation(undefined) 会被 gateway 的 fields() 跳过）；
        //    采购申请本身仍然是"必须有尺码"，扫码补货报单每一步都给得出尺码。
        const sizeReference = item.size === null ? null : await this.getSizeReferences().resolveByNumber(item.size);
        const created = await createOnceByKey({
          gateway: this.gateway,
          tableKey: 'purchaseRequest',
          keyField: IDEMPOTENCY_KEY_FIELD,
          keyValue: item.request_key,
          label: `采购申请 ${item.item_key}`,
          // ⚠️ 2026-10-09：这里原先还会补一个 `purchase_report_record_id`（那条报单记录）；
          //    报单入口退场 ⇒ 那个键**已无来源**（白名单里也删了），只留批次级关联键。
          correlation: baseCorrelation,
          values: {
            batchNo: relation(batchRecordId),
            product: relation(item.product_record_id),
            size: relation(sizeReference?.recordId),
            quantity: item.quantity,
            behavior: relation(item.behavior_record_id),
            idempotencyKey: item.request_key,
          },
        });
        recordId = created.recordId;
        requestIdByItemKey[item.item_key] = recordId;
        progress.requests = requestIdByItemKey;
        await this.store.update(taskId, {
          posting_progress: progress,
          posting_stage: `request_created:${item.item_key}`,
        });
      }
      requestIds.push(recordId);
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
    };
    // 采购事实已经落地之后的收尾动作：按供应商出图 → 发给她 → 写回附件。
    // 现场出图失败也只记日志（方法内部已吞异常），绝不把任务判成失败。
    await this.deliverSupplierImages(taskId, task, posting);
    // 更新卡片为"已完成"状态（免确认路径没有卡片，跳过）
    if (!options.skipCardUpdate) {
      await this.updatePurchaseActionCard(task, event, purchaseStatusCard({ ...draft, batch_no: plan.batch_no }, '采购申请已生成', `报货批次号：${plan.batch_no}；共 ${requestIds.length} 条明细已写入。`, 'green'));
    }
    return { toast: { type: 'success', content: `采购申请已生成：${plan.batch_no}（共${requestIds.length}条明细）` }, ...posting };
  }

  /**
   * 到货确认：**加库存** + 把**「报货批次」那一行**写实（实际数量 / 实际金额）。
   *
   * ⚠️ **不回写采购申请表**（业务负责人 2026-10-06 口径：「那个表就不要动」）。
   * 2026-10-05 之前它还由到货明细卡片的 `confirm_purchase_arrival` 动作调用；
   * 卡片随「拍照识别」退场后它一度是孤儿能力，**现在由「群话题对话式核对」在
   * 她点「是」之后调用**（见 services/purchaseArrivalConversationService.js）。
   *
   * ⭐ 2026-10-07 晚（到货落点大改）：
   *    · 「实际数量」「实际金额」**入库之前**写到「报货批次」那一行（`writeArrivalAcceptance`）；
   *    · 「到货状态 = 已到货」仍由对话链路的 `notifyBatchArrived` 负责（**不在这里写**，
   *      避免两处写同一列早晚写歪）；
   *    · 「到货验收」表已被业务负责人删除 ⇒ 这里**没有任何**指向它的读写。
   *    · ⛔ **2026-10-09**：「验收原话」「确认状态」两列在真表上**也没有了**
   *      ⇒ `markConfirmed`（写确认状态）**整个删除**、`writeAcceptance` 只再写
   *      实际数量/实际金额（见 `purchaseOrderBatchService` 与 schema 里的说明）。
   *
   * ⭐⭐ 2026-10-07 **深夜**（「采购入库」表被**整表删除**）：业务负责人的口径（逐字）——
   *    「甲 **不再写任何入库明细**：只更新「报货批次」（到货状态=已到货 + 验收原话 + 确认状态）
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
  async confirmArrival(taskId, task, operatorOpenId) {
    return this.confirmationQueue.run(taskId, () => this.confirmArrivalLocked(taskId, task, operatorOpenId));
  }

  /** 真正的入库实现：只由 confirmArrival 串行调用，不要直接调（会丢掉串行保证）。 */
  async confirmArrivalLocked(taskId, task, operatorOpenId) {
    // ⚠️ 2026-10-07 晚：这句话原先写「到货验收已入库」，但那**张表已被业务负责人删除** ——
    //    改成按现在的落点说（批次行），她看到的就是"这一批已经入过库了"。
    if (task.status === 'posted') return { toast: { type: 'info', content: '这一批已入库' } };
    // 她点确认时如果建档还没跑完（或上一次失败了），在这里同步补一次。
    // 建档是幂等的、并且和别的调用方走同一个 creationQueue，所以不会建出第二条。
    // 入库必须有货品记录，这一步不能省；失败就明确告诉她原因，别静默也不要"假装入库了"。
    const creation = await this.ensureArrivalProducts(taskId, { reason: 'confirm' });
    if (creation.state === 'failed') {
      const reason = creation.failures
        .map((item) => `${item.item_no || ''}${item.color || ''}：${item.error}`)
        .join('；');
      throw new Error(`新品建档没成功：${reason}。请再点一次「确认入库」，我先不入库`);
    }
    // 用**最新**草稿：建档刚把 created_products（含记录链接）写进去，
    // 拿动作开始时那份旧草稿会既看不到链接、也拿不到新货品的 record_id。
    const latest = (await this.store.get(taskId)) || task;
    const draft = latest.draft || task.draft;
    // 关联键（只进日志）：到货核对任务自己的 task_id（`arrival_reconcile_…`，
    // **是另一套 task，如实照传真名**）＋ 批次号 ＋ **「报货批次」记录 id**。
    // ⚠️ 这条链路**拿不到**「信息填写」报单记录 id（到货任务里只存 request_ids）
    //    —— 拿不到就不传，不编。
    // ⚠️ 2026-10-07 晚：原来的 `purchase_arrival_record_id`（「到货验收」那条记录）
    //    随表一起没了来源 ⇒ 换成 `purchase_batch_record_id`（到货信息现在的落点）。
    const batchRecordId = String(draft.batch_record_id || '').trim();
    const batchNo = String(draft.batch_no || '').trim();
    const correlation = purchaseCorrelation({
      taskId, batchNo, batchRecordId,
    });
    // 新品的明细在建档前没有 product_record_id，这里按「货号+颜色」把刚建好的记录对上。
    const productIdByKey = new Map((draft.created_products || [])
      .map((item) => [`${item.item_no}|${item.color}`, item.product_record_id]));
    const arrival = {
      ...draft,
      actual: (draft.actual || []).map((item) => (item.product_record_id ? item : {
        ...item,
        product_record_id: productIdByKey.get(`${item.item_no}|${item.color}`) || '',
      })),
    };
    const unresolved = arrival.actual.filter((item) => !item.product_record_id);
    if (unresolved.length > 0) {
      // 走到这里说明建档"看着成功"但明细对不上货品（数据异常）。宁可停下来告诉她，
      // 也不能把这几条静默丢掉、只入一部分库。
      throw new Error(`有 ${unresolved.length} 条到货明细没有对应货品（${unresolved
        .map((item) => `${item.item_no || ''}${item.color || ''}`).join('、')}）。请再点一次「确认入库」`);
    }
    // ⭐ 2026-10-07 晚：**先把结构化验收（实际数量 / 实际金额）落到「报货批次」那一行**，再逐条加库存。
    //    顺序与改动前一致（原来是在「到货验收」建行），只是落点换成了批次行；
    //    失败就**当场停下来**（一个字都不写库存）—— 到货信息没有落点，等于她这次确认没被记下来。
    // ⭐⭐ 2026-10-08：「实际数量」「实际金额」**搭同一次 update 一起写**（业务负责人批准的口径），
    //    两者都在草稿上、由到货核对那一步算好/校验好（本方法只"照草稿写，不重算"）：
    //      · `draft.actual_quantity` = 代码算出的实际到货数合计（与库存口径一致）；
    //      · `draft.actual_amount`   = 她在卡片表单里填的整批金额（提交时已校验必填/数字/非负）。
    await this.writeArrivalAcceptance({ taskId, batchNo, batchRecordId, draft, correlation });
    // ⭐ 2026-10-07 深夜：这里原本是"查「采购行为」→ `listAll('purchaseInbound')` 回查已写过的
    //    入库行 → 逐条 `create('purchaseInbound')`"，**整段随那张表一起删除**（她整表删了它）。
    //    现在这个循环只做一件事：把**实际数**逐条交给库存（`inventory.applyPurchase`），
    //    并把"这一条加过了"落进本地草稿 —— 那张表一个字段都不再有写入点。
    if (!this.inflightInventory.has(taskId)) this.inflightInventory.set(taskId, new Map());
    const inflightMap = this.inflightInventory.get(taskId);
    // 进度落盘的键改叫 `inventory_applied`（不再有"入库行"这回事）。
    // ⚠️ **同时读旧的 `inbound_created`**：改动前那一版把 `{recordId, inventoryApplied}` 写在这个键里，
    //    部署那一刻正卡在半路的任务（状态 posting）不会因为改名而把已经加过的库存**再加一遍**。
    const normalizeEntry = (value) => (typeof value === 'string' ? { inventoryApplied: false } : (value || {}));
    const persistedApplied = {};
    const legacyApplied = { ...(draft.inbound_created || {}), ...(draft.inventory_applied || {}) };
    for (const [key, value] of Object.entries(legacyApplied)) {
      persistedApplied[key] = normalizeEntry(value);
    }
    const appliedByKey = new Map();
    for (const [key, value] of inflightMap) appliedByKey.set(key, value);
    for (const [key, value] of Object.entries(persistedApplied)) {
      if (!appliedByKey.has(key)) appliedByKey.set(key, value);
    }
    // 落盘基线跟着最新草稿走：建档那一步往草稿里写过链接和 creation_state，
    // 用旧对象整份覆盖会把它们冲掉（她确认之后就看不到链接了）。
    let draftNow = { ...draft };
    const persistEntry = async (key, entry) => {
      inflightMap.set(key, entry);
      persistedApplied[key] = entry;
      try {
        draftNow = { ...draftNow, inventory_applied: persistedApplied };
        const updated = await this.store.update(taskId, { draft: draftNow });
        draftNow = updated?.draft || draftNow;
      } catch (error) {
        logWarn('purchase.arrival.inventory_applied.persist_failed', { task_id: taskId, key, error: error.message });
      }
    };
    // 她点确认的这批里，哪些（货品+尺码）真的动过库存 —— 落进任务终态，也是日志里的正向证据。
    const inventoryAppliedKeys = [];
    // 来源标识（= 库存那一层的本地幂等键）= **真实三元组**：批次身份 | 货品 | 尺码。
    // ⚠️ 三样都是真值（批次记录 id / 批次号 / 到货核对任务 id ＋ 货品 record_id ＋ 尺码），
    //    **一个都不是编的**。
    // ⭐ 2026-10-08：`purchaseBatchRecordId` 现在有**两个去处** —— ① 参与上面这个本地三元组；
    //    ② 作为**远端关联值**写进「库存流水.关联采购」（该列已被她改成指向「报货批次」）。
    //    两者互不替代：拿不到批次 record id 时①会退回批次号/任务 id，而②**整列不写**。
    const batchIdentity = {
      purchaseBatchRecordId: batchRecordId,
      purchaseBatchNo: batchNo,
      arrivalTaskId: taskId,
    };
    for (const item of aggregateArrivalItems(arrival.actual || [])) {
      const key = `${item.product_record_id}|${item.size}`;
      // 决定入库状态：没有样品则入样品库，有样品则入门盒库（口径与改动前逐字一致）。
      const inboundState = await this.resolvePurchaseInboundState(item.product_record_id);
      const existing = appliedByKey.get(key);
      if (existing?.inventoryApplied) {
        inventoryAppliedKeys.push(key);
        continue;
      }
      if (!this.enablePurchaseInventory) {
        // 库存写入被显式关掉时（`enablePurchaseInventory: false`）：一个字都不写，只记进度。
        await persistEntry(key, { ...(existing || {}), inventoryApplied: false });
        continue;
      }
      await this.inventory.applyPurchase({
        ...batchIdentity,
        productRecordId: item.product_record_id,
        size: item.size,
        quantity: item.quantity,
        // ⚠️ 2026-10-06：不再传 occurredAt（只进本地任务记录、无人读）；
        // 时间交给飞书自动的「创建时间」。
        state: inboundState,
      }, { correlation });
      await persistEntry(key, { ...(existing || {}), inventoryApplied: true });
      inventoryAppliedKeys.push(key);
    }
    // ⚠️ 2026-10-06：这里原先有一段**回写「报货信息」（采购申请表）**的代码——
    //   for (const request of arrival.requests) { … gateway.update('purchaseRequest', request.record_id,
    //     { arrivalStatus: status }) }   // 未到货 / 部分到货 / 全部到货 / 超额到货
    // 业务负责人当天的口径是：「**既然它就是采购申请，那个表就不要动**」
    //「我们要做的就是**基于采购申请表，再加上用户说的差异来进行实际入库**」。
    // 所以她删掉了这段回写：**采购申请表一个字都不改**（到货差异只体现在
    //「库存流水」/「实时库存」上）。
    // 这条口径由 `server/test/arrivalConversation.test.js` 的断言钉住：入库全过程
    // 对 `purchaseRequest` 表**零写入**（不是"看起来没写"，而是拿记录型 gateway 断言）。
    //
    // ⚠️ 也刻意**不再**把差异算成「超额到货 / 部分到货」这种状态：新口径下
    // 那个状态无处可写，算出来只会变成一个没人用的中间变量。
    //
    // 到这为止，一次到货确认只写两张表：**「报货批次」那一行**（实际数量 / 实际金额）
    // ＋ **「库存流水」「实时库存」**（由 InventoryService 写）。
    //
    // ⭐ 2026-10-07 晚：这一步原来是
    //   `gateway.update('purchaseArrival', arrival.arrival_record_id, { confirmStatus: '已确认' })`
    //   ——那张表已被她删除。现在写的是**「报货批次」那一行**的「确认状态」，
    //   取值来自 `config/purchaseAcceptance.js`（不写死中文字面量；该列现在是单选，
    //   取值由部署闸门的单选取值契约盯住）。
    // ⛔ 2026-10-09：这里原有「入库之后把这一批的『确认状态』改成『已确认』」那一段
    //   （`orderBatches.markConfirmed`）——**整段删除**：那一列在真表上已经没有了
    //   （业务负责人 2026-10-09 的只读核对：报货批次 12 列里没有「确认状态」）。
    //   ⚠️ 「到货状态 = 已到货」不在这里写（由对话链路的 `notifyBatchArrived` 负责），
    //      所以这一段的删除**没有**影响"这一批到货了没有"这个事实。
    // ⚠️ 终态里**不再有** `inbound_record_ids`（入库明细行不存在了）；改记"加过库存的（货品+尺码）"。
    await this.store.update(taskId, {
      status: 'posted', inventory_applied_keys: inventoryAppliedKeys,
    });
    this.inflightInventory.delete(taskId);
    logInfo('purchase.arrival.posted', {
      task_id: taskId, batch_record_id: batchRecordId, batch_no: batchNo,
      // 正向证据：这次确认到底给几条（货品+尺码）加了库存，以及**没有**写任何入库明细行。
      inventory_applied_count: inventoryAppliedKeys.length,
      inbound_rows_written: 0,
      inventory_applied: this.enablePurchaseInventory, ...correlation,
    });
    return { toast: { type: 'success', content: this.enablePurchaseInventory ? '采购已入库，库存已更新' : '采购入库已确认' } };
  }

  /**
   * ⭐ **结构化验收结果**→「报货批次」那一行（2026-10-07 晚的到货落点）。
   *
   * ⭐⭐ 2026-10-08：**同一次 update** 里写「实际数量」「实际金额」两列（业务负责人批准）——
   *   值来自草稿（`draft.actual_quantity` / `draft.actual_amount`），本方法**不重算**：
   *   算/校验是到货核对那一步的职责（`PurchaseArrivalConversationService.confirmLocked`
   *   与 `handleCardFormSubmit`）。
   *   ⚠️ 拿不到（`undefined`）时**那一列不写**（不写空值）—— 由 `writeAcceptance` 判，
   *      这样既有的"孤儿草稿"路径行为逐字不变。
   *   ⛔ **2026-10-09**：原先还写「验收原话」——那一列在真表上已经没有了，**写入点删除**
   *      （`draft.acceptance_text` 仍留在本地草稿里，它是解析实际到货情况的输入）。
   *
   * 三条边界（都在测试里钉住）：
   *   · **没有批次身份**（`batchNo` 与 `batchRecordId` 都空）→ 只记 warn、**不阻塞**：
   *     这是"孤儿调用"（历史草稿 / 手工种的测试任务）的形状，入库能力本身不该被它挡住。
   *   · 有批次身份但**批次行找不到** → **抛错**：她这次确认的到货信息没有落点，
   *     宁可当场告诉她，也不入库了却没有记录。
   *   · **绝对不写**「到货日」「验收人」：它们在真表上是飞书自动字段
   *     （更新时间 / 创建人），写了会被自动覆盖或直接报错。
   */
  async writeArrivalAcceptance({ taskId, batchNo, batchRecordId, draft, correlation }) {
    if (!batchNo && !batchRecordId) {
      logWarn('purchase.arrival.acceptance.skipped', {
        task_id: taskId, reason: 'no_batch_identity',
        hint: '草稿上没有批次号也没有批次记录 id（孤儿调用）→ 不写到货信息，也不阻塞入库',
      });
      return { updated: false, reason: 'no_batch_identity' };
    }
    const result = await this.orderBatches.writeAcceptance({
      batchNo,
      batchRecordId,
      // ⭐⭐ 2026-10-08：草稿上那两个值原样传下去（`undefined` = 这一列不写）。
      actualQuantity: draft?.actual_quantity,
      actualAmount: draft?.actual_amount,
      correlation,
    });
    if (!result.updated) {
      throw new Error(`「报货批次」里找不到这一批（${batchNo || batchRecordId}），到货信息没地方落，先不入库`);
    }
    return result;
  }

  /**
   * **兜底**的取号（业务负责人 2026-10-07 把格式改成 `CGD-YYYYMMDD-NNNN`）。
   *
   * ⚠️ 正常路径**不走这里**：号在**入口**就按包生成并写回「信息填写」了
   *（见 ensureReportBatchNo）—— 所以归批、出图、写「报货批次」用的都是同一个号。
   * 这个方法只在"入口没写成"时兜底（入口读不到那条记录、没权限等），
   * 由 `ensurePostingPlan` 调用，**只生成、不写回**。
   *
   * ⚠️ 生成的号会落进「报货批次」的「报货批次号」，而生成器的计数**同时数**两张表
   *   （见 `PurchaseBatchNoGenerator` 文件头 ②），所以兜底路径占掉的号也不会被别人重发。
   * ⚠️ 走串行队列 + 生成器内部的"本进程已发集合"：即便是兜底，也不会连发两个同号。
   */
  async nextBatchNo() {
    const table = this.gateway.table('purchaseOrderBatch');
    if (!table.tableId) throw new Error('未配置报货批次表ID：FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID');
    return this.batchNoGenerator.runExclusive(async () => {
      const generated = await this.batchNoGenerator.next({ source: 'fallback' });
      return generated.batchNo;
    });
  }
}

module.exports = { PurchaseWebhookService, attachmentTokens };
